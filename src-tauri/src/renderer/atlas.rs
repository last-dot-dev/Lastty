//! GPU glyph atlas for terminal rendering.
//!
//! Rasterizes glyphs on demand with swash, packs them into a single R8 GPU
//! texture via etagere, and exposes a fast per-char lookup. Each glyph is
//! rasterized exactly once regardless of how many times it appears on screen
//! — so a 200x60 viewport full of repeated characters never retriggers the
//! shaping/rasterization path, replacing the per-frame `shape_until_scroll()`
//! cost that dominated the glyphon-based renderer.

use std::collections::HashMap;
use std::sync::Arc;

use etagere::{size2, BucketedAtlasAllocator};
use swash::scale::image::Content;
use swash::scale::{Render, ScaleContext, Source, StrikeWith};
use swash::zeno::Format;
use swash::{FontRef, GlyphId};

use crate::font_config::{self, CellMetrics, FontConfig};

/// Atlas texture side length in pixels. 2048x2048 × R8 = 4 MiB. Plenty for
/// thousands of glyphs; if we ever exhaust it we can grow or reset it.
const ATLAS_SIZE: u32 = 2048;

/// Extra padding around each glyph in the atlas to avoid sampling bleed from
/// neighbors when linear filtering is active.
const GLYPH_PADDING: i32 = 1;

/// Look-up key for cached glyphs. Styles (bold/italic) go here eventually; for
/// the first pass we only key on the codepoint.
#[derive(Copy, Clone, Hash, Eq, PartialEq)]
pub struct GlyphKey {
    pub ch: char,
}

/// Position + metrics of a rasterized glyph inside the atlas.
#[derive(Copy, Clone, Debug)]
pub struct GlyphRegion {
    /// Atlas pixel offset.
    pub atlas_x: u16,
    pub atlas_y: u16,
    /// Rasterized glyph size.
    pub width: u16,
    pub height: u16,
    /// Horizontal bearing — the distance from the pen to the left of the glyph.
    pub bearing_x: i16,
    /// Vertical bearing — how far *above* the baseline the glyph's top edge is.
    pub bearing_y: i16,
}

pub struct GlyphAtlas {
    // Owns the font data so FontRef stays valid.
    font_data: Arc<Vec<u8>>,
    font_index: u32,
    scale_context: ScaleContext,
    font_size: f32,
    config: FontConfig,

    // GPU resources.
    pub texture: wgpu::Texture,
    pub texture_view: wgpu::TextureView,
    pub sampler: wgpu::Sampler,

    // Packer and cache.
    allocator: BucketedAtlasAllocator,
    cache: HashMap<GlyphKey, Option<GlyphRegion>>,

    // Cell metrics (pixel space, already rounded).
    pub cell_width: f32,
    pub cell_height: f32,
    /// Distance from cell top to baseline.
    pub baseline: f32,
}

impl GlyphAtlas {
    /// Build the atlas: load a monospace font, measure it, pre-rasterize the
    /// ASCII printable range, and allocate the GPU texture.
    ///
    /// `config` gives the logical-pixel font size and family; `scale_factor`
    /// is the window's backing scale (2.0 on Retina) so the rasterized size
    /// matches the surface's physical pixel dimensions.
    pub fn new(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        config: FontConfig,
        scale_factor: f32,
    ) -> anyhow::Result<Self> {
        let (font_data, font_index) = font_config::load_monospace_font(config.family)?;
        let CellMetrics {
            font_size,
            cell_width,
            cell_height,
            baseline,
        } = font_config::cell_metrics(&font_data, font_index, config, scale_factor)?;

        tracing::info!(
            "atlas font metrics: cell={:.1}x{:.1}, baseline={:.1}",
            cell_width,
            cell_height,
            baseline,
        );

        // GPU texture — R8 alpha mask. We write glyph coverage into red and
        // multiply by the text color in the shader.
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("glyph atlas"),
            size: wgpu::Extent3d {
                width: ATLAS_SIZE,
                height: ATLAS_SIZE,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::R8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        let texture_view = texture.create_view(&wgpu::TextureViewDescriptor::default());

        // Linear filter keeps subpixel positions looking smooth during resize
        // without the added cost of mipmaps.
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("glyph atlas sampler"),
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            address_mode_w: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::MipmapFilterMode::Nearest,
            ..Default::default()
        });

        let allocator = BucketedAtlasAllocator::new(size2(ATLAS_SIZE as i32, ATLAS_SIZE as i32));

        let mut atlas = Self {
            font_data,
            font_index,
            scale_context: ScaleContext::new(),
            font_size,
            config,
            texture,
            texture_view,
            sampler,
            allocator,
            cache: HashMap::new(),
            cell_width,
            cell_height,
            baseline,
        };

        // Pre-rasterize the printable ASCII range so startup-time and the first
        // frame don't thrash the allocator/queue. Any later codepoint (box
        // drawing, Unicode punctuation, etc.) falls through to the on-demand
        // path transparently.
        for code in 0x20u32..0x7Fu32 {
            if let Some(ch) = char::from_u32(code) {
                atlas.prepare(queue, ch);
            }
        }

        Ok(atlas)
    }

    /// Returns the glyph region for `ch`, rasterizing and uploading on first
    /// encounter. Returns `None` for codepoints the font doesn't cover or
    /// whose bitmap is zero-sized (e.g. whitespace).
    pub fn prepare(&mut self, queue: &wgpu::Queue, ch: char) -> Option<GlyphRegion> {
        let key = GlyphKey { ch };
        if let Some(region) = self.cache.get(&key) {
            return *region;
        }

        let region = self.rasterize_and_pack(queue, ch);
        self.cache.insert(key, region);
        region
    }

    fn rasterize_and_pack(&mut self, queue: &wgpu::Queue, ch: char) -> Option<GlyphRegion> {
        // Re-borrow the font each call — FontRef is a lightweight view over
        // self.font_data. Scaling and rasterization allocate internally but
        // only for cache misses, which is exactly what we want.
        let font = FontRef::from_index(&self.font_data, self.font_index as usize)?;
        let glyph_id: GlyphId = font.charmap().map(ch as u32);
        if glyph_id == 0 && ch != '\u{0}' {
            return None;
        }

        let mut scaler = self
            .scale_context
            .builder(font)
            .size(self.font_size)
            .hint(true)
            .build();

        // ColorOutline/ColorBitmap first means emoji fonts still work later —
        // we currently only sample the .r channel in the shader, so color
        // bitmaps would render as grayscale. That's acceptable until we wire
        // up a separate RGBA atlas tier.
        let image = Render::new(&[
            Source::ColorOutline(0),
            Source::ColorBitmap(StrikeWith::BestFit),
            Source::Outline,
        ])
        .format(Format::Alpha)
        .render(&mut scaler, glyph_id)?;

        if image.placement.width == 0 || image.placement.height == 0 {
            return None;
        }

        let w = image.placement.width as i32 + GLYPH_PADDING * 2;
        let h = image.placement.height as i32 + GLYPH_PADDING * 2;
        let allocation = self.allocator.allocate(size2(w, h))?;
        let rect = allocation.rectangle;
        let origin_x = rect.min.x + GLYPH_PADDING;
        let origin_y = rect.min.y + GLYPH_PADDING;

        // Only the alpha mask path is reliable for a single-channel atlas.
        // Anything else we just treat as opaque.
        let bytes_per_pixel: u32 = match image.content {
            Content::Mask => 1,
            Content::SubpixelMask => 4,
            Content::Color => 4,
        };

        if bytes_per_pixel == 1 {
            queue.write_texture(
                wgpu::TexelCopyTextureInfo {
                    texture: &self.texture,
                    mip_level: 0,
                    origin: wgpu::Origin3d {
                        x: origin_x as u32,
                        y: origin_y as u32,
                        z: 0,
                    },
                    aspect: wgpu::TextureAspect::All,
                },
                &image.data,
                wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(image.placement.width),
                    rows_per_image: Some(image.placement.height),
                },
                wgpu::Extent3d {
                    width: image.placement.width,
                    height: image.placement.height,
                    depth_or_array_layers: 1,
                },
            );
        } else {
            // Convert RGBA to alpha by taking max(r,g,b) — good enough for a
            // placeholder that won't hit in practice until we load a color
            // font.
            let src = image.data;
            let pixel_count = (image.placement.width * image.placement.height) as usize;
            let mut alpha = Vec::with_capacity(pixel_count);
            for px in 0..pixel_count {
                let base = px * 4;
                let r = src[base];
                let g = src[base + 1];
                let b = src[base + 2];
                alpha.push(r.max(g).max(b));
            }
            queue.write_texture(
                wgpu::TexelCopyTextureInfo {
                    texture: &self.texture,
                    mip_level: 0,
                    origin: wgpu::Origin3d {
                        x: origin_x as u32,
                        y: origin_y as u32,
                        z: 0,
                    },
                    aspect: wgpu::TextureAspect::All,
                },
                &alpha,
                wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(image.placement.width),
                    rows_per_image: Some(image.placement.height),
                },
                wgpu::Extent3d {
                    width: image.placement.width,
                    height: image.placement.height,
                    depth_or_array_layers: 1,
                },
            );
        }

        Some(GlyphRegion {
            atlas_x: origin_x as u16,
            atlas_y: origin_y as u16,
            width: image.placement.width as u16,
            height: image.placement.height as u16,
            bearing_x: image.placement.left as i16,
            bearing_y: image.placement.top as i16,
        })
    }

    /// Lookup-only variant — returns whatever is currently in the cache
    /// without attempting to rasterize. Safe to call while holding an
    /// immutable borrow of the atlas's other fields.
    pub fn get(&self, ch: char) -> Option<GlyphRegion> {
        self.cache.get(&GlyphKey { ch }).copied().flatten()
    }

    pub fn cached_glyph_count(&self) -> usize {
        self.cache.values().filter(|v| v.is_some()).count()
    }

    pub fn atlas_size(&self) -> u32 {
        ATLAS_SIZE
    }

    /// Re-rasterize the atlas at a fresh `scale_factor`. Clears the cache,
    /// resets the allocator, recomputes cell metrics, and pre-rasterizes
    /// ASCII. Called on a DPR change when dragging the window between
    /// displays of different scale.
    pub fn rebuild(&mut self, queue: &wgpu::Queue, scale_factor: f32) -> anyhow::Result<()> {
        let CellMetrics {
            font_size,
            cell_width,
            cell_height,
            baseline,
        } = font_config::cell_metrics(&self.font_data, self.font_index, self.config, scale_factor)?;

        self.font_size = font_size;
        self.cell_width = cell_width;
        self.cell_height = cell_height;
        self.baseline = baseline;
        self.cache.clear();
        self.allocator = BucketedAtlasAllocator::new(size2(ATLAS_SIZE as i32, ATLAS_SIZE as i32));
        self.scale_context = ScaleContext::new();

        tracing::info!(
            "atlas rebuilt at scale {scale_factor}: cell={:.1}x{:.1}, baseline={:.1}",
            cell_width,
            cell_height,
            baseline,
        );

        for code in 0x20u32..0x7Fu32 {
            if let Some(ch) = char::from_u32(code) {
                self.prepare(queue, ch);
            }
        }
        Ok(())
    }
}
