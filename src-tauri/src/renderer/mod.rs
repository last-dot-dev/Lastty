pub mod atlas;
pub mod rects;

use std::time::{Duration, Instant};

use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::index::Line;
use alacritty_terminal::term::cell::Flags as CellFlags;
use alacritty_terminal::term::Term;
use alacritty_terminal::term::TermDamage;
use alacritty_terminal::vte::ansi::{Color, NamedColor};
use bytemuck::{Pod, Zeroable};
use wgpu::util::DeviceExt;

use self::atlas::GlyphAtlas;
use self::rects::{rect_quad, RectVertex};
use crate::terminal::event_proxy::EventProxy;

/// Default terminal background color (dark theme).
const BG_COLOR: wgpu::Color = wgpu::Color {
    r: 0.06,
    g: 0.06,
    b: 0.08,
    a: 1.0,
};

/// Font size in physical pixels. The surface is configured in physical pixels
/// (see `main.rs` → `window.inner_size()` which returns physical px on
/// Retina), so we rasterize at the same unit.
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
    device: wgpu::Device,
    queue: wgpu::Queue,
    surface: wgpu::Surface<'static>,
    surface_config: wgpu::SurfaceConfiguration,

    // Rect rendering (cell backgrounds, cursor, selection).
    rect_pipeline: wgpu::RenderPipeline,

    // Glyph rendering (text).
    glyph_pipeline: wgpu::RenderPipeline,
    glyph_bind_group: wgpu::BindGroup,
    glyph_uniform_buffer: wgpu::Buffer,
    atlas: GlyphAtlas,

    // Font metrics (pixels).
    pub cell_width: f32,
    pub cell_height: f32,

    // Dimensions.
    pub surface_width: u32,
    pub surface_height: u32,

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
                .map(|row| (row, snapshot_line(term, row, display_offset, content.colors)))
                .collect(),
            cursor_row: cursor.point.line.0 as usize,
            cursor_col: cursor.point.column.0,
        }
    }

    pub async fn new(
        instance: &wgpu::Instance,
        surface: wgpu::Surface<'static>,
        width: u32,
        height: u32,
    ) -> anyhow::Result<Self> {
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

        // Build the glyph atlas. This loads the system monospace font and
        // pre-rasterizes ASCII, giving us stable cell metrics before anything
        // else runs.
        let atlas = GlyphAtlas::new(&device, &queue, FONT_SIZE)?;
        let cell_width = atlas.cell_width;
        let cell_height = atlas.cell_height;

        // Uniforms for the glyph pipeline — just screen and atlas dimensions.
        let glyph_uniforms = GlyphUniforms {
            screen_size: [width.max(1) as f32, height.max(1) as f32],
            atlas_size: [atlas.atlas_size() as f32; 2],
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
                    resource: wgpu::BindingResource::TextureView(&atlas.texture_view),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::Sampler(&atlas.sampler),
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
            device,
            queue,
            surface,
            surface_config,
            rect_pipeline,
            glyph_pipeline,
            glyph_bind_group,
            glyph_uniform_buffer,
            atlas,
            cell_width,
            cell_height,
            surface_width: width,
            surface_height: height,
            rows: Vec::new(),
            last_glyph_count: 0,
        })
    }

    pub fn resize(&mut self, width: u32, height: u32) {
        if width > 0 && height > 0 {
            self.surface_width = width;
            self.surface_height = height;
            self.surface_config.width = width;
            self.surface_config.height = height;
            self.surface.configure(&self.device, &self.surface_config);

            let uniforms = GlyphUniforms {
                screen_size: [width as f32, height as f32],
                atlas_size: [self.atlas.atlas_size() as f32; 2],
            };
            self.queue.write_buffer(
                &self.glyph_uniform_buffer,
                0,
                bytemuck::bytes_of(&uniforms),
            );
        }
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
        self.atlas.cached_glyph_count()
    }

    pub fn render(&mut self, snapshot: &TerminalSnapshot) -> anyhow::Result<RenderMetrics> {
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
        let baseline = self.atlas.baseline;
        let sw = self.surface_width as f32;
        let sh = self.surface_height as f32;
        let default_bg = [BG_COLOR.r as f32, BG_COLOR.g as f32, BG_COLOR.b as f32];

        // Ensure every visible glyph has been rasterized into the atlas. We
        // do this up front (separate from instance building) so the borrow
        // checker allows a mutable borrow of the atlas here without keeping
        // it alive during the immutable iteration below.
        for cells in &self.rows {
            for cell in cells {
                let ch = if cell.c == '\0' { ' ' } else { cell.c };
                if ch == ' ' {
                    continue;
                }
                self.atlas.prepare(&self.queue, ch);
            }
        }
        let cache_update = cache_start.elapsed();

        let rect_start = Instant::now();

        // Build background rects and glyph instances in a single pass so we
        // iterate the grid once.
        let mut rect_vertices: Vec<RectVertex> = Vec::new();
        let mut glyph_instances: Vec<GlyphInstance> = Vec::new();

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
                // Atlas is already warm from the pass above — do a lookup-only
                // call here to avoid any chance of re-writing the texture.
                let Some(region) = self.atlas.get(ch) else {
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
            self.device
                .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("rect vertices"),
                    contents: bytemuck::cast_slice(&rect_vertices),
                    usage: wgpu::BufferUsages::VERTEX,
                })
        });
        let glyph_buffer = (!glyph_instances.is_empty()).then(|| {
            self.device
                .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("glyph instances"),
                    contents: bytemuck::cast_slice(&glyph_instances),
                    usage: wgpu::BufferUsages::VERTEX,
                })
        });
        let prepare = prepare_start.elapsed();

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

        self.queue.submit(std::iter::once(encoder.finish()));
        frame.present();

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
