pub mod rects;

use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::term::cell::Flags as CellFlags;
use alacritty_terminal::term::Term;
use alacritty_terminal::vte::ansi::{Color, NamedColor};
use glyphon::{
    Attrs, Buffer, Cache, Color as GlyphonColor, Family, FontSystem, Metrics, Resolution, Shaping,
    SwashCache, TextArea, TextAtlas, TextBounds, TextRenderer, Viewport, Weight as GlyphonWeight,
};
use wgpu::util::DeviceExt;

use self::rects::{rect_quad, RectVertex};
use crate::terminal::event_proxy::EventProxy;

/// Default terminal background color (dark theme).
const BG_COLOR: wgpu::Color = wgpu::Color {
    r: 0.06,
    g: 0.06,
    b: 0.08,
    a: 1.0,
};

const FONT_SIZE: f32 = 18.0;

pub struct TerminalRenderer {
    device: wgpu::Device,
    queue: wgpu::Queue,
    surface: wgpu::Surface<'static>,
    surface_config: wgpu::SurfaceConfiguration,

    // Text rendering (glyphon)
    font_system: FontSystem,
    swash_cache: SwashCache,
    atlas: TextAtlas,
    text_renderer: TextRenderer,
    viewport: Viewport,
    cache: Cache,

    // Rect rendering (cell backgrounds, cursor)
    rect_pipeline: wgpu::RenderPipeline,

    // Font metrics
    pub cell_width: f32,
    pub cell_height: f32,

    // Dimensions
    pub surface_width: u32,
    pub surface_height: u32,
}

impl TerminalRenderer {
    pub async fn new(
        window: impl Into<wgpu::SurfaceTarget<'static>>,
        width: u32,
        height: u32,
    ) -> anyhow::Result<Self> {
        let instance = wgpu::Instance::default();
        let surface = instance.create_surface(window.into())?;

        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                compatible_surface: Some(&surface),
                ..Default::default()
            })
            .await?;

        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor::default())
            .await?;

        let surface_caps = surface.get_capabilities(&adapter);
        let format = surface_caps
            .formats
            .iter()
            .find(|f| f.is_srgb())
            .copied()
            .unwrap_or(surface_caps.formats[0]);

        let surface_config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format,
            width,
            height,
            present_mode: wgpu::PresentMode::Fifo,
            alpha_mode: if surface_caps.alpha_modes.contains(&wgpu::CompositeAlphaMode::Opaque) {
                wgpu::CompositeAlphaMode::Opaque
            } else {
                surface_caps.alpha_modes[0]
            },
            view_formats: vec![],
            desired_maximum_frame_latency: 2,
        };
        surface.configure(&device, &surface_config);

        // Load shader for rect rendering
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("rect shader"),
            source: wgpu::ShaderSource::Wgsl(include_str!("shader.wgsl").into()),
        });

        let rect_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("rect pipeline"),
            layout: None,
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs_rect"),
                buffers: &[RectVertex::desc()],
                compilation_options: Default::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
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

        // Initialize glyphon text rendering
        let mut font_system = FontSystem::new();
        let swash_cache = SwashCache::new();
        let cache = Cache::new(&device);
        let viewport = Viewport::new(&device, &cache);
        let mut atlas = TextAtlas::new(&device, &queue, &cache, format);
        let text_renderer = TextRenderer::new(
            &mut atlas,
            &device,
            wgpu::MultisampleState::default(),
            None,
        );

        // Measure cell size using a monospace glyph
        let line_height = (FONT_SIZE * 1.4).ceil();
        let metrics = Metrics::new(FONT_SIZE, line_height);
        let mut measure_buf = Buffer::new(&mut font_system, metrics);
        measure_buf.set_size(&mut font_system, Some(1000.0), Some(line_height));
        measure_buf.set_text(
            &mut font_system,
            "M",
            &Attrs::new().family(Family::Monospace),
            Shaping::Basic,
            None,
        );
        measure_buf.shape_until_scroll(&mut font_system, false);

        let cell_width = measure_buf
            .layout_runs()
            .next()
            .and_then(|run| run.glyphs.first())
            .map(|g| g.w)
            .unwrap_or(FONT_SIZE * 0.6);
        let cell_height = line_height;

        tracing::info!(
            "font metrics: cell_width={:.1}, cell_height={:.1}",
            cell_width,
            cell_height
        );

        Ok(Self {
            device,
            queue,
            surface,
            surface_config,
            font_system,
            swash_cache,
            atlas,
            text_renderer,
            viewport,
            cache,
            rect_pipeline,
            cell_width,
            cell_height,
            surface_width: width,
            surface_height: height,
        })
    }

    pub fn resize(&mut self, width: u32, height: u32) {
        if width > 0 && height > 0 {
            self.surface_width = width;
            self.surface_height = height;
            self.surface_config.width = width;
            self.surface_config.height = height;
            self.surface.configure(&self.device, &self.surface_config);
        }
    }

    /// Calculate grid dimensions from surface size.
    pub fn grid_size(&self) -> (u16, u16) {
        let cols = (self.surface_width as f32 / self.cell_width).floor() as u16;
        let rows = (self.surface_height as f32 / self.cell_height).floor() as u16;
        (cols.max(1), rows.max(1))
    }

    /// Render the terminal grid.
    pub fn render(&mut self, term: &Term<EventProxy>) -> anyhow::Result<()> {
        let content = term.renderable_content();

        let cell_w = self.cell_width;
        let cell_h = self.cell_height;
        let sw = self.surface_width as f32;
        let sh = self.surface_height as f32;
        let rows = term.screen_lines();

        let mut rect_vertices: Vec<RectVertex> = Vec::new();

        // Group cells by row. Each cell: (col, char, fg_rgb, bold, italic)
        struct CellInfo {
            col: usize,
            c: char,
            fg: [f32; 3],
            bold: bool,
            italic: bool,
        }
        let mut lines: Vec<Vec<CellInfo>> = (0..rows).map(|_| Vec::new()).collect();

        for indexed in content.display_iter {
            let cell = indexed.cell;
            let point = indexed.point;
            let row = point.line.0 as usize;
            let col = point.column.0;

            if row >= rows {
                continue;
            }

            // Cell background
            let bg = resolve_color(cell.bg, content.colors);
            let default_bg = [BG_COLOR.r as f32, BG_COLOR.g as f32, BG_COLOR.b as f32];
            if bg != default_bg {
                let px = col as f32 * cell_w;
                let py = row as f32 * cell_h;
                let ndc_x = (px / sw) * 2.0 - 1.0;
                let ndc_y = 1.0 - ((py + cell_h) / sh) * 2.0;
                let ndc_w = (cell_w / sw) * 2.0;
                let ndc_h = (cell_h / sh) * 2.0;
                rect_vertices.extend_from_slice(&rect_quad(ndc_x, ndc_y, ndc_w, ndc_h, [
                    bg[0], bg[1], bg[2], 1.0,
                ]));
            }

            lines[row].push(CellInfo {
                col,
                c: cell.c,
                fg: resolve_color(cell.fg, content.colors),
                bold: cell.flags.contains(CellFlags::BOLD),
                italic: cell.flags.contains(CellFlags::ITALIC),
            });
        }

        // Draw cursor
        let cursor = &content.cursor;
        let cursor_row = cursor.point.line.0 as usize;
        let cursor_col = cursor.point.column.0;
        let cursor_px = cursor_col as f32 * cell_w;
        let cursor_py = cursor_row as f32 * cell_h;
        let cursor_ndc_x = (cursor_px / sw) * 2.0 - 1.0;
        let cursor_ndc_y = 1.0 - ((cursor_py + cell_h) / sh) * 2.0;
        let cursor_ndc_w = (cell_w / sw) * 2.0;
        let cursor_ndc_h = (cell_h / sh) * 2.0;
        rect_vertices.extend_from_slice(&rect_quad(
            cursor_ndc_x,
            cursor_ndc_y,
            cursor_ndc_w,
            cursor_ndc_h,
            [0.8, 0.8, 0.8, 0.7],
        ));

        // Build glyphon text buffers per line with per-cell colors.
        let mut line_buffers: Vec<(Buffer, f32, f32)> = Vec::new();
        let metrics = Metrics::new(FONT_SIZE, cell_h);

        for (row_idx, cells) in lines.iter().enumerate() {
            if cells.is_empty() || cells.iter().all(|ci| ci.c == ' ' || ci.c == '\0') {
                continue;
            }

            let mut sorted_cells: Vec<&CellInfo> = cells.iter().collect();
            sorted_cells.sort_by_key(|ci| ci.col);

            // Build per-character spans with individual colors.
            let mut spans: Vec<(String, Attrs)> = Vec::new();
            let mut last_col = 0usize;

            for ci in &sorted_cells {
                // Fill gaps with spaces (default color).
                if ci.col > last_col {
                    let gap: String = std::iter::repeat(' ').take(ci.col - last_col).collect();
                    spans.push((gap, Attrs::new().family(Family::Monospace)));
                }

                let c = if ci.c == '\0' { ' ' } else { ci.c };
                let fg_u8 = [
                    (ci.fg[0] * 255.0) as u8,
                    (ci.fg[1] * 255.0) as u8,
                    (ci.fg[2] * 255.0) as u8,
                ];
                let attrs = Attrs::new()
                    .family(Family::Monospace)
                    .color(GlyphonColor::rgb(fg_u8[0], fg_u8[1], fg_u8[2]))
                    .weight(if ci.bold { GlyphonWeight::BOLD } else { GlyphonWeight::NORMAL });

                let mut s = String::new();
                s.push(c);
                spans.push((s, attrs));
                last_col = ci.col + 1;
            }

            let mut buffer = Buffer::new(&mut self.font_system, metrics);
            buffer.set_size(&mut self.font_system, Some(sw), Some(cell_h));

            let default_attrs = Attrs::new().family(Family::Monospace);
            let span_refs: Vec<(&str, Attrs)> =
                spans.iter().map(|(s, a)| (s.as_str(), a.clone())).collect();
            buffer.set_rich_text(
                &mut self.font_system,
                span_refs,
                &default_attrs,
                Shaping::Basic,
                None,
            );
            buffer.shape_until_scroll(&mut self.font_system, false);

            let y = row_idx as f32 * cell_h;
            line_buffers.push((buffer, 0.0, y));
        }

        // Update viewport
        self.viewport.update(
            &self.queue,
            Resolution {
                width: self.surface_width,
                height: self.surface_height,
            },
        );

        // Build TextAreas from line buffers
        let text_areas: Vec<TextArea> = line_buffers
            .iter()
            .map(|(buffer, x, y)| {
                // Get primary color from the line.
                TextArea {
                    buffer,
                    left: *x,
                    top: *y,
                    scale: 1.0,
                    bounds: TextBounds {
                        left: 0,
                        top: 0,
                        right: self.surface_width as i32,
                        bottom: self.surface_height as i32,
                    },
                    default_color: GlyphonColor::rgb(220, 220, 220),
                    custom_glyphs: &[],
                }
            })
            .collect();

        // Prepare text
        self.text_renderer
            .prepare(
                &self.device,
                &self.queue,
                &mut self.font_system,
                &mut self.atlas,
                &self.viewport,
                text_areas,
                &mut self.swash_cache,
            )
            .map_err(|e| anyhow::anyhow!("text prepare error: {:?}", e))?;

        // Get surface and render
        let frame = match self.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(tex)
            | wgpu::CurrentSurfaceTexture::Suboptimal(tex) => tex,
            other => {
                anyhow::bail!("failed to get surface texture: {:?}", other);
            }
        };
        let view = frame.texture.create_view(&Default::default());
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("render encoder"),
            });

        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("terminal render pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(BG_COLOR),
                        store: wgpu::StoreOp::Store,
                    },
                    depth_slice: None,
                })],
                ..Default::default()
            });

            // Draw cell backgrounds + cursor
            if !rect_vertices.is_empty() {
                let rect_buffer =
                    self.device
                        .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                            label: Some("rect vertices"),
                            contents: bytemuck::cast_slice(&rect_vertices),
                            usage: wgpu::BufferUsages::VERTEX,
                        });
                pass.set_pipeline(&self.rect_pipeline);
                pass.set_vertex_buffer(0, rect_buffer.slice(..));
                pass.draw(0..rect_vertices.len() as u32, 0..1);
            }

            // Draw text via glyphon
            self.text_renderer
                .render(&self.atlas, &self.viewport, &mut pass)
                .map_err(|e| anyhow::anyhow!("text render error: {:?}", e))?;
        }

        self.queue.submit(std::iter::once(encoder.finish()));
        frame.present();

        self.atlas.trim();

        Ok(())
    }
}

/// Resolve a terminal color to RGB floats.
fn resolve_color(
    color: Color,
    colors: &alacritty_terminal::term::color::Colors,
) -> [f32; 3] {
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
        let to_f = |v: u8| if v == 0 { 0.0 } else { (55.0 + 40.0 * v as f32) / 255.0 };
        return [to_f(r), to_f(g), to_f(b)];
    }
    let v = (8 + 10 * (idx - 232)) as f32 / 255.0;
    [v, v, v]
}
