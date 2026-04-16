pub mod atlas;
pub mod panes;
pub mod rects;

use std::time::{Duration, Instant};

use alacritty_terminal::event::EventListener;
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::index::Line;
use alacritty_terminal::term::cell::Flags as CellFlags;
use alacritty_terminal::term::Term;
use alacritty_terminal::term::TermDamage;
use alacritty_terminal::vte::ansi::{Color, NamedColor};
use bytemuck::{Pod, Zeroable};
use wgpu::util::DeviceExt;

use std::sync::{Arc, Mutex};

use self::atlas::GlyphAtlas;
use self::panes::GpuContext;
use self::rects::{rect_quad, RectVertex};

/// Default terminal background color (dark theme).
const BG_COLOR: wgpu::Color = wgpu::Color {
    r: 0.06,
    g: 0.06,
    b: 0.08,
    a: 1.0,
};

#[derive(Clone, PartialEq)]
pub struct TerminalSnapshot {
    rows: usize,
    changed_lines: Vec<(usize, Vec<CellInfo>)>,
    cursor_row: usize,
    cursor_col: usize,
}

impl TerminalSnapshot {
    pub fn changed_line_count(&self) -> usize {
        self.changed_lines.len()
    }
}

#[derive(Clone, PartialEq)]
struct CellInfo {
    col: usize,
    c: char,
    fg: [f32; 3],
    bg: [f32; 3],
    bold: bool,
}

/// One quad's worth of data pushed to the GPU per visible glyph.
#[repr(C)]
#[derive(Copy, Clone, Pod, Zeroable)]
struct GlyphInstance {
    pos: [f32; 2],
    size: [f32; 2],
    atlas_pos: [f32; 2],
    color: [f32; 4],
}

impl GlyphInstance {
    fn desc() -> wgpu::VertexBufferLayout<'static> {
        wgpu::VertexBufferLayout {
            array_stride: std::mem::size_of::<Self>() as wgpu::BufferAddress,
            step_mode: wgpu::VertexStepMode::Instance,
            attributes: &[
                wgpu::VertexAttribute {
                    offset: 0,
                    shader_location: 0,
                    format: wgpu::VertexFormat::Float32x2,
                },
                wgpu::VertexAttribute {
                    offset: 8,
                    shader_location: 1,
                    format: wgpu::VertexFormat::Float32x2,
                },
                wgpu::VertexAttribute {
                    offset: 16,
                    shader_location: 2,
                    format: wgpu::VertexFormat::Float32x2,
                },
                wgpu::VertexAttribute {
                    offset: 24,
                    shader_location: 3,
                    format: wgpu::VertexFormat::Float32x4,
                },
            ],
        }
    }
}

#[repr(C)]
#[derive(Copy, Clone, Pod, Zeroable)]
struct GlyphUniforms {
    screen_size: [f32; 2],
    atlas_size: [f32; 2],
}

pub struct TerminalRenderer {
    gpu: GpuContext,
    surface: Option<wgpu::Surface<'static>>,
    surface_config: Option<wgpu::SurfaceConfiguration>,

    // Rect rendering (cell backgrounds, cursor, selection).
    rect_pipeline: wgpu::RenderPipeline,

    // Glyph rendering (text).
    glyph_pipeline: wgpu::RenderPipeline,
    glyph_bind_group: wgpu::BindGroup,
    glyph_uniform_buffer: wgpu::Buffer,
    atlas: Arc<Mutex<GlyphAtlas>>,
    atlas_size: u32,

    // Font metrics (physical pixels). Cached from the atlas — kept in sync by
    // `resize()` when the scale factor changes.
    pub cell_width: f32,
    pub cell_height: f32,
    baseline: f32,

    // Dimensions (physical pixels).
    pub surface_width: u32,
    pub surface_height: u32,
    // Current DPR. Tracked so resize() can detect a display move and rebuild
    // the atlas at the new scale.
    pub scale_factor: f32,

    // Full grid snapshot kept up to date across frames. Damage updates only
    // touch the rows that changed, so keeping this avoids re-asking the Term
    // for undamaged rows — and gives us a stable source of truth to iterate
    // for both the rect and glyph passes.
    rows: Vec<Vec<CellInfo>>,

    // Track the last glyph count for metrics reporting.
    last_glyph_count: usize,
}

pub struct RenderMetrics {
    pub cache_update: Duration,
    pub rect_build: Duration,
    pub prepare: Duration,
    pub gpu: Duration,
    pub text_areas: usize,
}

impl TerminalRenderer {
    pub fn snapshot<T: EventListener>(term: &mut Term<T>) -> TerminalSnapshot {
        let rows = term.screen_lines();
        let damage = term.damage();
        let changed_rows: Vec<usize> = match damage {
            TermDamage::Full => (0..rows).collect(),
            TermDamage::Partial(lines) => lines.map(|line| line.line).collect(),
        };
        term.reset_damage();

        let content = term.renderable_content();
        let display_offset = content.display_offset;
        let cursor = content.cursor;
        TerminalSnapshot {
            rows,
            changed_lines: changed_rows
                .into_iter()
                .filter(|row| *row < rows)
                .map(|row| (row, snapshot_line(term, row, display_offset, content.colors)))
                .collect(),
            cursor_row: cursor.point.line.0 as usize,
            cursor_col: cursor.point.column.0,
        }
    }

    /// Build a per-pane renderer. `gpu` is shared across all panes; `atlas`
    /// is shared so each pane's renderer hits the same rasterization cache.
    /// The bind group captures the atlas's texture view/sampler at
    /// construction and stays valid across atlas rebuilds because rebuild
    /// keeps the same texture.
    pub fn new_for_pane(
        gpu: GpuContext,
        surface: wgpu::Surface<'static>,
        width: u32,
        height: u32,
        atlas: Arc<Mutex<GlyphAtlas>>,
        scale_factor: f32,
    ) -> anyhow::Result<Self> {
        let surface_caps = surface.get_capabilities(&gpu.adapter);
        let alpha_mode = if surface_caps
            .alpha_modes
            .contains(&wgpu::CompositeAlphaMode::Opaque)
        {
            wgpu::CompositeAlphaMode::Opaque
        } else {
            surface_caps.alpha_modes[0]
        };

        let surface_config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format: gpu.format,
            width,
            height,
            present_mode: wgpu::PresentMode::Fifo,
            alpha_mode,
            view_formats: vec![],
            desired_maximum_frame_latency: 2,
        };
        surface.configure(&gpu.device, &surface_config);

        let mut renderer = Self::new_offscreen(gpu, width, height, atlas, scale_factor)?;
        renderer.surface = Some(surface);
        renderer.surface_config = Some(surface_config);
        Ok(renderer)
    }

    /// Build a renderer that targets an external `wgpu::TextureView` rather
    /// than a window surface. Used by the renderer benchmark to measure the
    /// wgpu path without needing a real window.
    pub fn new_offscreen(
        gpu: GpuContext,
        width: u32,
        height: u32,
        atlas: Arc<Mutex<GlyphAtlas>>,
        scale_factor: f32,
    ) -> anyhow::Result<Self> {
        let device = gpu.device.clone();
        let format = gpu.format;

        // Rect pipeline for backgrounds, cursor, selection. Unchanged from
        // before the atlas refactor.
        let rect_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("rect shader"),
            source: wgpu::ShaderSource::Wgsl(include_str!("shader.wgsl").into()),
        });
        let rect_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("rect pipeline"),
            layout: None,
            vertex: wgpu::VertexState {
                module: &rect_shader,
                entry_point: Some("vs_rect"),
                buffers: &[RectVertex::desc()],
                compilation_options: Default::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &rect_shader,
                entry_point: Some("fs_rect"),
                targets: &[Some(wgpu::ColorTargetState {
                    format,
                    blend: Some(wgpu::BlendState::ALPHA_BLENDING),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                compilation_options: Default::default(),
            }),
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview_mask: None,
            cache: None,
        });

        // Pull cell metrics + atlas texture handles out of the shared atlas.
        // The bind group captures the texture view/sampler by clone so the
        // mutex can be released before the per-pane pipeline setup that
        // follows.
        let (cell_width, cell_height, baseline, atlas_size, atlas_texture_view, atlas_sampler) = {
            let atlas_guard = atlas.lock().expect("glyph atlas mutex poisoned");
            (
                atlas_guard.cell_width,
                atlas_guard.cell_height,
                atlas_guard.baseline,
                atlas_guard.atlas_size(),
                atlas_guard.texture_view.clone(),
                atlas_guard.sampler.clone(),
            )
        };

        let glyph_uniforms = GlyphUniforms {
            screen_size: [width.max(1) as f32, height.max(1) as f32],
            atlas_size: [atlas_size as f32; 2],
        };
        let glyph_uniform_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("glyph uniforms"),
            contents: bytemuck::bytes_of(&glyph_uniforms),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        });

        let glyph_bind_group_layout =
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("glyph bind group layout"),
                entries: &[
                    wgpu::BindGroupLayoutEntry {
                        binding: 0,
                        visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Uniform,
                            has_dynamic_offset: false,
                            min_binding_size: None,
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 1,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Texture {
                            sample_type: wgpu::TextureSampleType::Float { filterable: true },
                            view_dimension: wgpu::TextureViewDimension::D2,
                            multisampled: false,
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 2,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                        count: None,
                    },
                ],
            });

        let glyph_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("glyph bind group"),
            layout: &glyph_bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: glyph_uniform_buffer.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(&atlas_texture_view),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::Sampler(&atlas_sampler),
                },
            ],
        });

        let glyph_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("glyph shader"),
            source: wgpu::ShaderSource::Wgsl(include_str!("glyph_shader.wgsl").into()),
        });
        let glyph_pipeline_layout =
            device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("glyph pipeline layout"),
                bind_group_layouts: &[Some(&glyph_bind_group_layout)],
                immediate_size: 0,
            });
        let glyph_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("glyph pipeline"),
            layout: Some(&glyph_pipeline_layout),
            vertex: wgpu::VertexState {
                module: &glyph_shader,
                entry_point: Some("vs_main"),
                buffers: &[GlyphInstance::desc()],
                compilation_options: Default::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &glyph_shader,
                entry_point: Some("fs_main"),
                targets: &[Some(wgpu::ColorTargetState {
                    format,
                    blend: Some(wgpu::BlendState::ALPHA_BLENDING),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                compilation_options: Default::default(),
            }),
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview_mask: None,
            cache: None,
        });

        Ok(Self {
            gpu,
            surface: None,
            surface_config: None,
            rect_pipeline,
            glyph_pipeline,
            glyph_bind_group,
            glyph_uniform_buffer,
            atlas,
            atlas_size,
            cell_width,
            cell_height,
            baseline,
            surface_width: width,
            surface_height: height,
            scale_factor,
            rows: Vec::new(),
            last_glyph_count: 0,
        })
    }

    /// Resize the wgpu surface to a fresh (physical_width, physical_height,
    /// scale_factor) tuple. If the scale factor changed, the shared glyph
    /// atlas is rebuilt at the new DPR so glyphs stay crisp after a display
    /// move. The rebuild is coordinated across all panes by the caller.
    pub fn resize(&mut self, width: u32, height: u32, scale_factor: f32) -> anyhow::Result<()> {
        if width == 0 || height == 0 {
            return Ok(());
        }
        self.surface_width = width;
        self.surface_height = height;
        if let (Some(surface), Some(config)) = (&self.surface, self.surface_config.as_mut()) {
            config.width = width;
            config.height = height;
            surface.configure(&self.gpu.device, config);
        }

        if (scale_factor - self.scale_factor).abs() > f32::EPSILON {
            let mut atlas = self.atlas.lock().expect("glyph atlas mutex poisoned");
            atlas.rebuild(&self.gpu.queue, scale_factor)?;
            self.cell_width = atlas.cell_width;
            self.cell_height = atlas.cell_height;
            self.baseline = atlas.baseline;
            drop(atlas);
            self.scale_factor = scale_factor;
            self.rows.clear();
        }

        let uniforms = GlyphUniforms {
            screen_size: [width as f32, height as f32],
            atlas_size: [self.atlas_size as f32; 2],
        };
        self.gpu.queue.write_buffer(
            &self.glyph_uniform_buffer,
            0,
            bytemuck::bytes_of(&uniforms),
        );
        Ok(())
    }

    /// Calculate grid dimensions from surface size.
    pub fn grid_size(&self) -> (u16, u16) {
        let cols = (self.surface_width as f32 / self.cell_width).floor() as u16;
        let rows = (self.surface_height as f32 / self.cell_height).floor() as u16;
        (cols.max(1), rows.max(1))
    }

    /// Reports the number of cached glyphs in the atlas. Kept as
    /// `cached_line_count` for backwards compatibility with the perf stats
    /// pipeline, even though the semantics are now "glyphs not lines."
    pub fn cached_line_count(&self) -> usize {
        self.atlas
            .lock()
            .expect("glyph atlas mutex poisoned")
            .cached_glyph_count()
    }

    pub fn render(&mut self, snapshot: &TerminalSnapshot) -> anyhow::Result<RenderMetrics> {
        let surface = self
            .surface
            .as_ref()
            .expect("render() requires a surface; use render_to_view() for offscreen");
        let frame = match surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(tex)
            | wgpu::CurrentSurfaceTexture::Suboptimal(tex) => tex,
            other => {
                anyhow::bail!("failed to get surface texture: {:?}", other);
            }
        };
        let view = frame.texture.create_view(&Default::default());
        let metrics = self.render_to_view(snapshot, &view)?;
        frame.present();
        Ok(metrics)
    }

    /// Core render pass. Records + submits the GPU work against `view` and
    /// returns timing breakdowns. Shared between the surface-backed `render`
    /// path and the offscreen benchmark path.
    pub fn render_to_view(
        &mut self,
        snapshot: &TerminalSnapshot,
        view: &wgpu::TextureView,
    ) -> anyhow::Result<RenderMetrics> {
        let cache_start = Instant::now();

        // Apply snapshot damage into the persistent row buffer.
        if self.rows.len() != snapshot.rows {
            self.rows.resize_with(snapshot.rows, Vec::new);
        }
        for (row_idx, cells) in &snapshot.changed_lines {
            if *row_idx < self.rows.len() {
                self.rows[*row_idx] = cells.clone();
            }
        }

        let cell_w = self.cell_width;
        let cell_h = self.cell_height;
        let baseline = self.baseline;
        let sw = self.surface_width as f32;
        let sh = self.surface_height as f32;
        let default_bg = [BG_COLOR.r as f32, BG_COLOR.g as f32, BG_COLOR.b as f32];

        // Rasterize any new glyphs into the shared atlas before the draw
        // pass. The lock is held for the whole cache warm-up so a concurrent
        // pane's prepare() doesn't race, then released before we build the
        // vertex buffers — keeping the hot path lock-free.
        {
            let mut atlas = self.atlas.lock().expect("glyph atlas mutex poisoned");
            for cells in &self.rows {
                for cell in cells {
                    let ch = if cell.c == '\0' { ' ' } else { cell.c };
                    if ch == ' ' {
                        continue;
                    }
                    atlas.prepare(&self.gpu.queue, ch);
                }
            }
        }
        let cache_update = cache_start.elapsed();

        let rect_start = Instant::now();

        // Build background rects and glyph instances in a single pass so we
        // iterate the grid once.
        let mut rect_vertices: Vec<RectVertex> = Vec::new();
        let mut glyph_instances: Vec<GlyphInstance> = Vec::new();

        {
            let atlas = self.atlas.lock().expect("glyph atlas mutex poisoned");
            for (row_idx, cells) in self.rows.iter().enumerate() {
                let row_y = row_idx as f32 * cell_h;
                for cell in cells {
                    let cell_x = cell.col as f32 * cell_w;

                    // Background rect (skip default bg to save GPU work).
                    if cell.bg != default_bg {
                        let ndc_x = (cell_x / sw) * 2.0 - 1.0;
                        let ndc_y = 1.0 - ((row_y + cell_h) / sh) * 2.0;
                        let ndc_w = (cell_w / sw) * 2.0;
                        let ndc_h = (cell_h / sh) * 2.0;
                        rect_vertices.extend_from_slice(&rect_quad(
                            ndc_x,
                            ndc_y,
                            ndc_w,
                            ndc_h,
                            [cell.bg[0], cell.bg[1], cell.bg[2], 1.0],
                        ));
                    }

                    // Glyph instance.
                    let ch = if cell.c == '\0' { ' ' } else { cell.c };
                    if ch == ' ' {
                        continue;
                    }
                    // Atlas is already warm from the pass above — lookup-only
                    // call here to avoid any chance of re-writing the texture.
                    let Some(region) = atlas.get(ch) else {
                        continue;
                    };
                    let glyph_x = cell_x + region.bearing_x as f32;
                    let glyph_y = row_y + baseline - region.bearing_y as f32;
                    glyph_instances.push(GlyphInstance {
                        pos: [glyph_x, glyph_y],
                        size: [region.width as f32, region.height as f32],
                        atlas_pos: [region.atlas_x as f32, region.atlas_y as f32],
                        color: [cell.fg[0], cell.fg[1], cell.fg[2], 1.0],
                    });
                }
            }
        }

        // Cursor rect (semi-transparent overlay).
        let cursor_px = snapshot.cursor_col as f32 * cell_w;
        let cursor_py = snapshot.cursor_row as f32 * cell_h;
        let cursor_ndc_x = (cursor_px / sw) * 2.0 - 1.0;
        let cursor_ndc_y = 1.0 - ((cursor_py + cell_h) / sh) * 2.0;
        let cursor_ndc_w = (cell_w / sw) * 2.0;
        let cursor_ndc_h = (cell_h / sh) * 2.0;
        rect_vertices.extend_from_slice(&rect_quad(
            cursor_ndc_x,
            cursor_ndc_y,
            cursor_ndc_w,
            cursor_ndc_h,
            [0.8, 0.8, 0.8, 0.5],
        ));

        let rect_build = rect_start.elapsed();

        // Upload instance/vertex buffers. wgpu's buffer pool handles reuse,
        // so allocating per-frame here is cheap compared to the old
        // glyphon shape_until_scroll path.
        let prepare_start = Instant::now();
        let rect_buffer = (!rect_vertices.is_empty()).then(|| {
            self.gpu
                .device
                .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("rect vertices"),
                    contents: bytemuck::cast_slice(&rect_vertices),
                    usage: wgpu::BufferUsages::VERTEX,
                })
        });
        let glyph_buffer = (!glyph_instances.is_empty()).then(|| {
            self.gpu
                .device
                .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("glyph instances"),
                    contents: bytemuck::cast_slice(&glyph_instances),
                    usage: wgpu::BufferUsages::VERTEX,
                })
        });
        let prepare = prepare_start.elapsed();

        let gpu_start = Instant::now();
        let mut encoder =
            self.gpu
                .device
                .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                    label: Some("render encoder"),
                });

        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("terminal render pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(BG_COLOR),
                        store: wgpu::StoreOp::Store,
                    },
                    depth_slice: None,
                })],
                ..Default::default()
            });

            // Backgrounds first so glyphs render over them.
            if let Some(rect_buffer) = &rect_buffer {
                pass.set_pipeline(&self.rect_pipeline);
                pass.set_vertex_buffer(0, rect_buffer.slice(..));
                pass.draw(0..rect_vertices.len() as u32, 0..1);
            }

            // Single instanced draw call for all glyphs.
            if let Some(glyph_buffer) = &glyph_buffer {
                pass.set_pipeline(&self.glyph_pipeline);
                pass.set_bind_group(0, &self.glyph_bind_group, &[]);
                pass.set_vertex_buffer(0, glyph_buffer.slice(..));
                pass.draw(0..6, 0..glyph_instances.len() as u32);
            }
        }

        self.gpu.queue.submit(std::iter::once(encoder.finish()));

        self.last_glyph_count = glyph_instances.len();

        Ok(RenderMetrics {
            cache_update,
            rect_build,
            prepare,
            gpu: gpu_start.elapsed(),
            text_areas: glyph_instances.len(),
        })
    }
}

/// Resolve a terminal color to RGB floats.
fn resolve_color(color: Color, colors: &alacritty_terminal::term::color::Colors) -> [f32; 3] {
    match color {
        Color::Named(name) => {
            if let Some(rgb) = colors[name] {
                [
                    rgb.r as f32 / 255.0,
                    rgb.g as f32 / 255.0,
                    rgb.b as f32 / 255.0,
                ]
            } else {
                named_color_fallback(name)
            }
        }
        Color::Indexed(idx) => {
            if let Some(rgb) = colors[idx as usize] {
                [
                    rgb.r as f32 / 255.0,
                    rgb.g as f32 / 255.0,
                    rgb.b as f32 / 255.0,
                ]
            } else {
                ansi_256_color(idx)
            }
        }
        Color::Spec(rgb) => [
            rgb.r as f32 / 255.0,
            rgb.g as f32 / 255.0,
            rgb.b as f32 / 255.0,
        ],
    }
}

fn named_color_fallback(name: NamedColor) -> [f32; 3] {
    match name {
        NamedColor::Black => [0.0, 0.0, 0.0],
        NamedColor::Red => [0.8, 0.0, 0.0],
        NamedColor::Green => [0.0, 0.8, 0.0],
        NamedColor::Yellow => [0.8, 0.8, 0.0],
        NamedColor::Blue => [0.0, 0.0, 0.8],
        NamedColor::Magenta => [0.8, 0.0, 0.8],
        NamedColor::Cyan => [0.0, 0.8, 0.8],
        NamedColor::White => [0.75, 0.75, 0.75],
        NamedColor::BrightBlack => [0.5, 0.5, 0.5],
        NamedColor::BrightRed => [1.0, 0.0, 0.0],
        NamedColor::BrightGreen => [0.0, 1.0, 0.0],
        NamedColor::BrightYellow => [1.0, 1.0, 0.0],
        NamedColor::BrightBlue => [0.0, 0.0, 1.0],
        NamedColor::BrightMagenta => [1.0, 0.0, 1.0],
        NamedColor::BrightCyan => [0.0, 1.0, 1.0],
        NamedColor::BrightWhite => [1.0, 1.0, 1.0],
        NamedColor::Foreground => [0.85, 0.85, 0.85],
        NamedColor::Background => [BG_COLOR.r as f32, BG_COLOR.g as f32, BG_COLOR.b as f32],
        _ => [0.85, 0.85, 0.85],
    }
}

fn ansi_256_color(idx: u8) -> [f32; 3] {
    if idx < 16 {
        let name = match idx {
            0 => NamedColor::Black,
            1 => NamedColor::Red,
            2 => NamedColor::Green,
            3 => NamedColor::Yellow,
            4 => NamedColor::Blue,
            5 => NamedColor::Magenta,
            6 => NamedColor::Cyan,
            7 => NamedColor::White,
            8 => NamedColor::BrightBlack,
            9 => NamedColor::BrightRed,
            10 => NamedColor::BrightGreen,
            11 => NamedColor::BrightYellow,
            12 => NamedColor::BrightBlue,
            13 => NamedColor::BrightMagenta,
            14 => NamedColor::BrightCyan,
            15 => NamedColor::BrightWhite,
            _ => unreachable!(),
        };
        return named_color_fallback(name);
    }
    if idx < 232 {
        let idx = idx - 16;
        let r = (idx / 36) % 6;
        let g = (idx / 6) % 6;
        let b = idx % 6;
        let to_f = |v: u8| {
            if v == 0 {
                0.0
            } else {
                (55.0 + 40.0 * v as f32) / 255.0
            }
        };
        return [to_f(r), to_f(g), to_f(b)];
    }
    let v = (8 + 10 * (idx - 232)) as f32 / 255.0;
    [v, v, v]
}

fn snapshot_line<T: EventListener>(
    term: &Term<T>,
    row: usize,
    display_offset: usize,
    colors: &alacritty_terminal::term::color::Colors,
) -> Vec<CellInfo> {
    let line = Line(row as i32 - display_offset as i32);
    (&term.grid()[line])
        .into_iter()
        .enumerate()
        .map(|(col, cell)| CellInfo {
            col,
            c: cell.c,
            fg: resolve_color(cell.fg, colors),
            bg: resolve_color(cell.bg, colors),
            bold: cell.flags.contains(CellFlags::BOLD),
        })
        .collect()
}
