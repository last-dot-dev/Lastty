pub mod rects;

use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::index::Line;
use alacritty_terminal::term::cell::Flags as CellFlags;
use alacritty_terminal::term::Term;
use alacritty_terminal::term::TermDamage;
use alacritty_terminal::vte::ansi::{Color, NamedColor};
use glyphon::{
    Attrs, Buffer, Cache, Color as GlyphonColor, Family, FontSystem, Metrics, Resolution, Shaping,
    SwashCache, TextArea, TextAtlas, TextBounds, TextRenderer, Viewport, Weight as GlyphonWeight,
};
use std::time::{Duration, Instant};
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

struct CachedLine {
    cells: Vec<CellInfo>,
    buffer: Buffer,
}

#[derive(Clone, Copy, PartialEq)]
struct LineStyle {
    fg: [u8; 3],
    bold: bool,
}

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
    line_cache: Vec<Option<CachedLine>>,
    layout_dirty: bool,
}

pub struct RenderMetrics {
    pub cache_update: Duration,
    pub rect_build: Duration,
    pub prepare: Duration,
    pub gpu: Duration,
    pub text_areas: usize,
}

impl TerminalRenderer {
    pub fn snapshot(term: &mut Term<EventProxy>) -> TerminalSnapshot {
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
                .map(|row| {
                    (
                        row,
                        snapshot_line(term, row, display_offset, content.colors),
                    )
                })
                .collect(),
            cursor_row: cursor.point.line.0 as usize,
            cursor_col: cursor.point.column.0,
        }
    }

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
            alpha_mode: if surface_caps
                .alpha_modes
                .contains(&wgpu::CompositeAlphaMode::Opaque)
            {
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
        let text_renderer =
            TextRenderer::new(&mut atlas, &device, wgpu::MultisampleState::default(), None);

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
            line_cache: Vec::new(),
            layout_dirty: true,
        })
    }

    pub fn resize(&mut self, width: u32, height: u32) {
        if width > 0 && height > 0 {
            self.surface_width = width;
            self.surface_height = height;
            self.surface_config.width = width;
            self.surface_config.height = height;
            self.surface.configure(&self.device, &self.surface_config);
            self.layout_dirty = true;
        }
    }

    /// Calculate grid dimensions from surface size.
    pub fn grid_size(&self) -> (u16, u16) {
        let cols = (self.surface_width as f32 / self.cell_width).floor() as u16;
        let rows = (self.surface_height as f32 / self.cell_height).floor() as u16;
        (cols.max(1), rows.max(1))
    }

    pub fn cached_line_count(&self) -> usize {
        self.line_cache.iter().filter(|line| line.is_some()).count()
    }

    /// Render the terminal grid.
    pub fn render(&mut self, snapshot: &TerminalSnapshot) -> anyhow::Result<RenderMetrics> {
        let cache_start = Instant::now();
        let cell_w = self.cell_width;
        let cell_h = self.cell_height;
        let sw = self.surface_width as f32;
        let sh = self.surface_height as f32;
        let default_bg = [BG_COLOR.r as f32, BG_COLOR.g as f32, BG_COLOR.b as f32];
        // Build glyphon text buffers per line with per-cell colors.
        if self.line_cache.len() != snapshot.rows {
            self.line_cache.resize_with(snapshot.rows, || None);
            self.layout_dirty = true;
        }
        let metrics = Metrics::new(FONT_SIZE, cell_h);

        for (row_idx, cells) in &snapshot.changed_lines {
            if cells.is_empty() || cells.iter().all(|ci| ci.c == ' ' || ci.c == '\0') {
                self.line_cache[*row_idx] = None;
                continue;
            }

            let needs_rebuild = self.layout_dirty
                || self.line_cache[*row_idx]
                    .as_ref()
                    .map(|cached| cached.cells != *cells)
                    .unwrap_or(true);

            if needs_rebuild {
                let mut buffer = self.line_cache[*row_idx]
                    .take()
                    .map(|cached| cached.buffer)
                    .unwrap_or_else(|| Buffer::new(&mut self.font_system, metrics));
                buffer.set_size(&mut self.font_system, Some(sw), Some(cell_h));

                if let Some(line_style) = uniform_line_style(cells) {
                    let text = build_line_text(cells);
                    let attrs = Attrs::new()
                        .family(Family::Monospace)
                        .color(GlyphonColor::rgb(
                            line_style.fg[0],
                            line_style.fg[1],
                            line_style.fg[2],
                        ))
                        .weight(if line_style.bold {
                            GlyphonWeight::BOLD
                        } else {
                            GlyphonWeight::NORMAL
                        });
                    buffer.set_text(&mut self.font_system, &text, &attrs, Shaping::Basic, None);
                } else {
                    let mut spans: Vec<(String, Attrs)> = Vec::new();
                    let mut last_col = 0usize;
                    let mut run_text = String::new();
                    let mut run_style: Option<LineStyle> = None;

                    for ci in cells {
                        if ci.col > last_col {
                            flush_run(&mut spans, &mut run_text, &mut run_style);
                            spans.push((
                                " ".repeat(ci.col - last_col),
                                Attrs::new().family(Family::Monospace),
                            ));
                        }

                        let c = if ci.c == '\0' { ' ' } else { ci.c };
                        let style = cell_style(ci);

                        if run_style != Some(style) {
                            flush_run(&mut spans, &mut run_text, &mut run_style);
                            run_style = Some(style);
                        }

                        run_text.push(c);
                        last_col = ci.col + 1;
                    }

                    flush_run(&mut spans, &mut run_text, &mut run_style);

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
                }

                buffer.shape_until_scroll(&mut self.font_system, false);

                self.line_cache[*row_idx] = Some(CachedLine {
                    cells: cells.clone(),
                    buffer,
                });
            }
        }
        self.layout_dirty = false;
        let cache_update = cache_start.elapsed();

        let rect_start = Instant::now();
        let mut rect_vertices: Vec<RectVertex> = Vec::new();
        for (row_idx, maybe_cached) in self.line_cache.iter().enumerate() {
            let Some(cached) = maybe_cached.as_ref() else {
                continue;
            };
            for cell in &cached.cells {
                if cell.bg != default_bg {
                    let px = cell.col as f32 * cell_w;
                    let py = row_idx as f32 * cell_h;
                    let ndc_x = (px / sw) * 2.0 - 1.0;
                    let ndc_y = 1.0 - ((py + cell_h) / sh) * 2.0;
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
            }
        }

        // Draw cursor
        let cursor_row = snapshot.cursor_row;
        let cursor_col = snapshot.cursor_col;
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
        let rect_build = rect_start.elapsed();

        // Update viewport
        self.viewport.update(
            &self.queue,
            Resolution {
                width: self.surface_width,
                height: self.surface_height,
            },
        );

        // Build TextAreas from line buffers
        let text_areas: Vec<TextArea> = self
            .line_cache
            .iter()
            .enumerate()
            .filter_map(|(row_idx, cached)| cached.as_ref().map(|cached| (row_idx, cached)))
            .map(|(row_idx, cached)| TextArea {
                buffer: &cached.buffer,
                left: 0.0,
                top: row_idx as f32 * cell_h,
                scale: 1.0,
                bounds: TextBounds {
                    left: 0,
                    top: 0,
                    right: self.surface_width as i32,
                    bottom: self.surface_height as i32,
                },
                default_color: GlyphonColor::rgb(220, 220, 220),
                custom_glyphs: &[],
            })
            .collect();
        let text_areas_len = text_areas.len();

        // Prepare text
        let prepare_start = Instant::now();
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
        let prepare = prepare_start.elapsed();

        // Get surface and render
        let gpu_start = Instant::now();
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

        Ok(RenderMetrics {
            cache_update,
            rect_build,
            prepare,
            gpu: gpu_start.elapsed(),
            text_areas: text_areas_len,
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

fn snapshot_line(
    term: &Term<EventProxy>,
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

fn cell_style(cell: &CellInfo) -> LineStyle {
    LineStyle {
        fg: [
            (cell.fg[0] * 255.0) as u8,
            (cell.fg[1] * 255.0) as u8,
            (cell.fg[2] * 255.0) as u8,
        ],
        bold: cell.bold,
    }
}

fn attrs_for_style(style: LineStyle) -> Attrs<'static> {
    Attrs::new()
        .family(Family::Monospace)
        .color(GlyphonColor::rgb(style.fg[0], style.fg[1], style.fg[2]))
        .weight(if style.bold {
            GlyphonWeight::BOLD
        } else {
            GlyphonWeight::NORMAL
        })
}

fn uniform_line_style(cells: &[CellInfo]) -> Option<LineStyle> {
    let first = cells.first()?;
    let style = cell_style(first);
    cells
        .iter()
        .all(|cell| cell_style(cell) == style)
        .then_some(style)
}

fn build_line_text(cells: &[CellInfo]) -> String {
    let mut text = String::with_capacity(cells.len());
    let mut last_col = 0usize;

    for cell in cells {
        if cell.col > last_col {
            push_spaces(&mut text, cell.col - last_col);
        }
        text.push(if cell.c == '\0' { ' ' } else { cell.c });
        last_col = cell.col + 1;
    }

    text
}

fn flush_run(
    spans: &mut Vec<(String, Attrs<'static>)>,
    run_text: &mut String,
    run_style: &mut Option<LineStyle>,
) {
    if run_text.is_empty() {
        return;
    }

    let style = run_style.take().unwrap_or(LineStyle {
        fg: [220, 220, 220],
        bold: false,
    });
    spans.push((std::mem::take(run_text), attrs_for_style(style)));
}

fn push_spaces(text: &mut String, count: usize) {
    text.extend(std::iter::repeat_n(' ', count));
}
