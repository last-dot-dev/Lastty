pub mod atlas;
pub mod panes;
pub mod rects;

use std::ops::Range;
use std::sync::{Arc, Mutex};
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

use self::atlas::{GlyphAtlas, GlyphKey, StyleBits};
use self::panes::GpuContext;
use self::rects::{RectInstance, QUAD_INDICES};

/// Default terminal background color (dark theme).
const BG_COLOR: wgpu::Color = wgpu::Color {
    r: 0.06,
    g: 0.06,
    b: 0.08,
    a: 1.0,
};

const BG_COLOR_BYTES: [u8; 4] = [15, 15, 20, 255];
const CURSOR_COLOR: [u8; 4] = [204, 204, 204, 128];

#[derive(Clone, PartialEq)]
pub struct TerminalSnapshot {
    rows: usize,
    cols: usize,
    changed_lines: Vec<(usize, Vec<CellInfo>)>,
    cursor_row: usize,
    cursor_col: usize,
}

impl TerminalSnapshot {
    pub fn changed_line_count(&self) -> usize {
        self.changed_lines.len()
    }
}

#[derive(Copy, Clone, Default, PartialEq, Eq)]
struct CellInfo {
    c: char,
    fg: [u8; 4],
    bg: [u8; 4],
    style: StyleBits,
}

#[repr(C)]
#[derive(Copy, Clone, Default, Pod, Zeroable)]
struct GlyphInstance {
    cell: [u16; 2],
    atlas_pos: [u16; 2],
    glyph_size: [u16; 2],
    bearing: [i16; 2],
    color: [u8; 4],
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
                    format: wgpu::VertexFormat::Uint16x2,
                },
                wgpu::VertexAttribute {
                    offset: 4,
                    shader_location: 1,
                    format: wgpu::VertexFormat::Uint16x2,
                },
                wgpu::VertexAttribute {
                    offset: 8,
                    shader_location: 2,
                    format: wgpu::VertexFormat::Uint16x2,
                },
                wgpu::VertexAttribute {
                    offset: 12,
                    shader_location: 3,
                    format: wgpu::VertexFormat::Sint16x2,
                },
                wgpu::VertexAttribute {
                    offset: 16,
                    shader_location: 4,
                    format: wgpu::VertexFormat::Unorm8x4,
                },
            ],
        }
    }

    fn hidden(cell: [u16; 2]) -> Self {
        Self {
            cell,
            atlas_pos: [0, 0],
            glyph_size: [0, 0],
            bearing: [0, 0],
            color: [0, 0, 0, 0],
        }
    }

    fn visible(cell: [u16; 2], region: atlas::GlyphRegion, color: [u8; 4]) -> Self {
        Self {
            cell,
            atlas_pos: [region.atlas_x, region.atlas_y],
            glyph_size: [region.width, region.height],
            bearing: [region.bearing_x, region.bearing_y],
            color,
        }
    }

    fn is_visible(&self) -> bool {
        self.color[3] != 0
    }
}

#[repr(C)]
#[derive(Copy, Clone, Pod, Zeroable)]
struct RectUniforms {
    screen_size: [f32; 2],
    cell_size: [f32; 2],
}

#[repr(C)]
#[derive(Copy, Clone, Pod, Zeroable)]
struct GlyphUniforms {
    screen_size: [f32; 2],
    atlas_size: [f32; 2],
    cell_size: [f32; 2],
    baseline: f32,
    _padding: f32,
}

pub struct TerminalRenderer {
    gpu: GpuContext,
    surface: Option<wgpu::Surface<'static>>,
    surface_config: Option<wgpu::SurfaceConfiguration>,

    rect_pipeline: wgpu::RenderPipeline,
    rect_bind_group: wgpu::BindGroup,
    rect_uniform_buffer: wgpu::Buffer,

    glyph_pipeline: wgpu::RenderPipeline,
    glyph_bind_group: wgpu::BindGroup,
    glyph_uniform_buffer: wgpu::Buffer,
    quad_index_buffer: wgpu::Buffer,
    atlas: Arc<Mutex<GlyphAtlas>>,
    atlas_size: u32,

    pub cell_width: f32,
    pub cell_height: f32,
    baseline: f32,

    pub surface_width: u32,
    pub surface_height: u32,
    pub scale_factor: f32,

    rows: usize,
    cols: usize,
    cells: Vec<CellInfo>,
    glyph_instances: Vec<GlyphInstance>,
    rect_instances: Vec<RectInstance>,
    glyph_buffer: wgpu::Buffer,
    glyph_buffer_capacity: usize,
    rect_buffer: wgpu::Buffer,
    rect_buffer_capacity: usize,
    cursor_buffer: wgpu::Buffer,
    cursor_row: usize,
    cursor_col: usize,
    active_glyph_count: usize,

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
        let cols = term.columns();
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
            cols,
            changed_lines: changed_rows
                .into_iter()
                .filter(|row| *row < rows)
                .map(|row| {
                    (
                        row,
                        snapshot_line(term, row, cols, display_offset, content.colors),
                    )
                })
                .collect(),
            cursor_row: cursor.point.line.0 as usize,
            cursor_col: cursor.point.column.0,
        }
    }

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

    pub fn new_offscreen(
        gpu: GpuContext,
        width: u32,
        height: u32,
        atlas: Arc<Mutex<GlyphAtlas>>,
        scale_factor: f32,
    ) -> anyhow::Result<Self> {
        let device = gpu.device.clone();
        let format = gpu.format;
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

        let rect_uniform_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("rect uniforms"),
            contents: bytemuck::bytes_of(&RectUniforms {
                screen_size: [width.max(1) as f32, height.max(1) as f32],
                cell_size: [cell_width, cell_height],
            }),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        });
        let rect_bind_group_layout =
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("rect bind group layout"),
                entries: &[wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::VERTEX,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                }],
            });
        let rect_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("rect bind group"),
            layout: &rect_bind_group_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: rect_uniform_buffer.as_entire_binding(),
            }],
        });
        let rect_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("rect shader"),
            source: wgpu::ShaderSource::Wgsl(include_str!("shader.wgsl").into()),
        });
        let rect_pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("rect pipeline layout"),
            bind_group_layouts: &[Some(&rect_bind_group_layout)],
            immediate_size: 0,
        });
        let rect_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("rect pipeline"),
            layout: Some(&rect_pipeline_layout),
            vertex: wgpu::VertexState {
                module: &rect_shader,
                entry_point: Some("vs_rect"),
                buffers: &[RectInstance::desc()],
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

        let glyph_uniform_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("glyph uniforms"),
            contents: bytemuck::bytes_of(&GlyphUniforms {
                screen_size: [width.max(1) as f32, height.max(1) as f32],
                atlas_size: [atlas_size as f32; 2],
                cell_size: [cell_width, cell_height],
                baseline,
                _padding: 0.0,
            }),
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

        let quad_index_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("renderer quad indices"),
            contents: bytemuck::cast_slice(&QUAD_INDICES),
            usage: wgpu::BufferUsages::INDEX,
        });
        let glyph_buffer = create_instance_buffer::<GlyphInstance>(&device, "glyph instances", 1);
        let rect_buffer = create_instance_buffer::<RectInstance>(&device, "rect instances", 1);
        let cursor_buffer = create_instance_buffer::<RectInstance>(&device, "cursor instance", 1);

        Ok(Self {
            gpu,
            surface: None,
            surface_config: None,
            rect_pipeline,
            rect_bind_group,
            rect_uniform_buffer,
            glyph_pipeline,
            glyph_bind_group,
            glyph_uniform_buffer,
            quad_index_buffer,
            atlas,
            atlas_size,
            cell_width,
            cell_height,
            baseline,
            surface_width: width,
            surface_height: height,
            scale_factor,
            rows: 0,
            cols: 0,
            cells: Vec::new(),
            glyph_instances: Vec::new(),
            rect_instances: Vec::new(),
            glyph_buffer,
            glyph_buffer_capacity: 1,
            rect_buffer,
            rect_buffer_capacity: 1,
            cursor_buffer,
            cursor_row: 0,
            cursor_col: 0,
            active_glyph_count: 0,
            last_glyph_count: 0,
        })
    }

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
            self.rows = 0;
            self.cols = 0;
            self.cells.clear();
            self.glyph_instances.clear();
            self.rect_instances.clear();
            self.active_glyph_count = 0;
        }

        self.write_uniforms();
        Ok(())
    }

    pub fn grid_size(&self) -> (u16, u16) {
        let cols = (self.surface_width as f32 / self.cell_width).floor() as u16;
        let rows = (self.surface_height as f32 / self.cell_height).floor() as u16;
        (cols.max(1), rows.max(1))
    }

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
            wgpu::CurrentSurfaceTexture::Success(frame)
            | wgpu::CurrentSurfaceTexture::Suboptimal(frame) => frame,
            other => anyhow::bail!("failed to get surface texture: {other:?}"),
        };
        let view = frame.texture.create_view(&Default::default());
        let metrics = self.render_to_view(snapshot, &view)?;
        frame.present();
        Ok(metrics)
    }

    pub fn render_to_view(
        &mut self,
        snapshot: &TerminalSnapshot,
        view: &wgpu::TextureView,
    ) -> anyhow::Result<RenderMetrics> {
        let cache_start = Instant::now();

        let mut dirty_rows = self.ensure_grid(snapshot.rows, snapshot.cols);
        dirty_rows.extend(snapshot.changed_lines.iter().map(|(row, _)| *row));
        dirty_rows.sort_unstable();
        dirty_rows.dedup();

        {
            let mut atlas = self.atlas.lock().expect("glyph atlas mutex poisoned");
            for (row_idx, cells) in &snapshot.changed_lines {
                let row_start = self.row_start(*row_idx);
                if row_start >= self.cells.len() {
                    continue;
                }
                for (col, cell) in cells.iter().copied().enumerate().take(self.cols) {
                    let index = row_start + col;
                    self.cells[index] = cell;
                    let ch = display_char(cell.c);
                    if ch != ' ' {
                        atlas.prepare(
                            &self.gpu.queue,
                            GlyphKey {
                                ch,
                                style: cell.style,
                            },
                        );
                    }
                }
            }
        }

        {
            let atlas_handle = Arc::clone(&self.atlas);
            let atlas = atlas_handle.lock().expect("glyph atlas mutex poisoned");
            for row in &dirty_rows {
                self.rebuild_row(*row, &atlas);
            }
        }
        let cache_update = cache_start.elapsed();

        let rect_start = Instant::now();
        let dirty_ranges = coalesce_rows(&dirty_rows, self.cols);
        let rect_build = rect_start.elapsed();

        let prepare_start = Instant::now();
        for range in &dirty_ranges {
            self.write_instance_range(range.clone());
        }

        self.cursor_row = snapshot.cursor_row.min(self.rows.saturating_sub(1));
        self.cursor_col = snapshot.cursor_col.min(self.cols.saturating_sub(1));
        let cursor = RectInstance::solid(
            [self.cursor_col as u16, self.cursor_row as u16],
            CURSOR_COLOR,
        );
        self.gpu
            .queue
            .write_buffer(&self.cursor_buffer, 0, bytemuck::bytes_of(&cursor));
        let prepare = prepare_start.elapsed();

        let gpu_start = Instant::now();
        let mut encoder = self
            .gpu
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

            pass.set_index_buffer(self.quad_index_buffer.slice(..), wgpu::IndexFormat::Uint16);

            if self.rows != 0 && self.cols != 0 {
                let instance_count = (self.rows * self.cols) as u32;
                pass.set_pipeline(&self.rect_pipeline);
                pass.set_bind_group(0, &self.rect_bind_group, &[]);
                pass.set_vertex_buffer(0, self.rect_buffer.slice(..));
                pass.draw_indexed(0..QUAD_INDICES.len() as u32, 0, 0..instance_count);
            }

            pass.set_pipeline(&self.rect_pipeline);
            pass.set_bind_group(0, &self.rect_bind_group, &[]);
            pass.set_vertex_buffer(0, self.cursor_buffer.slice(..));
            pass.draw_indexed(0..QUAD_INDICES.len() as u32, 0, 0..1);

            if self.rows != 0 && self.cols != 0 {
                let instance_count = (self.rows * self.cols) as u32;
                pass.set_pipeline(&self.glyph_pipeline);
                pass.set_bind_group(0, &self.glyph_bind_group, &[]);
                pass.set_vertex_buffer(0, self.glyph_buffer.slice(..));
                pass.draw_indexed(0..QUAD_INDICES.len() as u32, 0, 0..instance_count);
            }
        }

        self.gpu.queue.submit(std::iter::once(encoder.finish()));

        self.last_glyph_count = self.active_glyph_count;

        Ok(RenderMetrics {
            cache_update,
            rect_build,
            prepare,
            gpu: gpu_start.elapsed(),
            text_areas: self.active_glyph_count,
        })
    }

    fn ensure_grid(&mut self, rows: usize, cols: usize) -> Vec<usize> {
        if self.rows == rows && self.cols == cols {
            return Vec::new();
        }

        self.rows = rows;
        self.cols = cols;
        let cell_count = rows.saturating_mul(cols).max(1);
        self.cells = vec![CellInfo::default(); cell_count];
        self.glyph_instances = (0..cell_count)
            .map(|index| GlyphInstance::hidden(cell_coord(index, cols.max(1))))
            .collect();
        self.rect_instances = (0..cell_count)
            .map(|index| RectInstance::hidden(cell_coord(index, cols.max(1))))
            .collect();
        self.active_glyph_count = 0;
        self.ensure_instance_capacity(cell_count);
        self.write_uniforms();
        (0..rows).collect()
    }

    fn ensure_instance_capacity(&mut self, cell_count: usize) {
        let capacity = cell_count.max(1);
        if capacity > self.glyph_buffer_capacity {
            self.glyph_buffer = create_instance_buffer::<GlyphInstance>(
                &self.gpu.device,
                "glyph instances",
                capacity,
            );
            self.glyph_buffer_capacity = capacity;
        }
        if capacity > self.rect_buffer_capacity {
            self.rect_buffer = create_instance_buffer::<RectInstance>(
                &self.gpu.device,
                "rect instances",
                capacity,
            );
            self.rect_buffer_capacity = capacity;
        }
    }

    fn rebuild_row(&mut self, row: usize, atlas: &GlyphAtlas) {
        if row >= self.rows {
            return;
        }
        let start = self.row_start(row);
        let end = start + self.cols;
        let old_visible = self.glyph_instances[start..end]
            .iter()
            .filter(|instance| instance.is_visible())
            .count();
        let mut new_visible = 0usize;

        for col in 0..self.cols {
            let index = start + col;
            let cell = self.cells[index];
            let coord = [col as u16, row as u16];

            self.rect_instances[index] = if cell.bg == BG_COLOR_BYTES {
                RectInstance::hidden(coord)
            } else {
                RectInstance::solid(coord, cell.bg)
            };

            let ch = display_char(cell.c);
            self.glyph_instances[index] = if ch == ' ' {
                GlyphInstance::hidden(coord)
            } else if let Some(region) = atlas.get(GlyphKey {
                ch,
                style: cell.style,
            }) {
                new_visible += 1;
                GlyphInstance::visible(coord, region, cell.fg)
            } else {
                GlyphInstance::hidden(coord)
            };
        }

        self.active_glyph_count = self.active_glyph_count + new_visible - old_visible;
    }

    fn row_start(&self, row: usize) -> usize {
        row * self.cols
    }

    fn write_instance_range(&self, range: Range<usize>) {
        if range.is_empty() {
            return;
        }
        self.gpu.queue.write_buffer(
            &self.glyph_buffer,
            (range.start * std::mem::size_of::<GlyphInstance>()) as u64,
            bytemuck::cast_slice(&self.glyph_instances[range.clone()]),
        );
        self.gpu.queue.write_buffer(
            &self.rect_buffer,
            (range.start * std::mem::size_of::<RectInstance>()) as u64,
            bytemuck::cast_slice(&self.rect_instances[range]),
        );
    }

    fn write_uniforms(&self) {
        self.gpu.queue.write_buffer(
            &self.rect_uniform_buffer,
            0,
            bytemuck::bytes_of(&RectUniforms {
                screen_size: [self.surface_width as f32, self.surface_height as f32],
                cell_size: [self.cell_width, self.cell_height],
            }),
        );
        self.gpu.queue.write_buffer(
            &self.glyph_uniform_buffer,
            0,
            bytemuck::bytes_of(&GlyphUniforms {
                screen_size: [self.surface_width as f32, self.surface_height as f32],
                atlas_size: [self.atlas_size as f32; 2],
                cell_size: [self.cell_width, self.cell_height],
                baseline: self.baseline,
                _padding: 0.0,
            }),
        );
    }
}

fn create_instance_buffer<T: Pod>(
    device: &wgpu::Device,
    label: &'static str,
    capacity: usize,
) -> wgpu::Buffer {
    device.create_buffer(&wgpu::BufferDescriptor {
        label: Some(label),
        size: (capacity * std::mem::size_of::<T>()) as u64,
        usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    })
}

fn coalesce_rows(rows: &[usize], cols: usize) -> Vec<Range<usize>> {
    if rows.is_empty() || cols == 0 {
        return Vec::new();
    }

    let mut ranges = Vec::new();
    let mut start_row = rows[0];
    let mut prev_row = rows[0];
    for row in rows.iter().copied().skip(1) {
        if row == prev_row + 1 {
            prev_row = row;
            continue;
        }
        ranges.push(start_row * cols..(prev_row + 1) * cols);
        start_row = row;
        prev_row = row;
    }
    ranges.push(start_row * cols..(prev_row + 1) * cols);
    ranges
}

fn cell_coord(index: usize, cols: usize) -> [u16; 2] {
    [(index % cols) as u16, (index / cols) as u16]
}

fn display_char(c: char) -> char {
    if c == '\0' {
        ' '
    } else {
        c
    }
}

fn resolve_color(color: Color, colors: &alacritty_terminal::term::color::Colors) -> [u8; 4] {
    match color {
        Color::Named(name) => colors[name]
            .map(rgb_to_rgba)
            .unwrap_or_else(|| named_color_fallback(name)),
        Color::Indexed(idx) => colors[idx as usize]
            .map(rgb_to_rgba)
            .unwrap_or_else(|| ansi_256_color(idx)),
        Color::Spec(rgb) => [rgb.r, rgb.g, rgb.b, 255],
    }
}

fn rgb_to_rgba(rgb: alacritty_terminal::vte::ansi::Rgb) -> [u8; 4] {
    [rgb.r, rgb.g, rgb.b, 255]
}

fn named_color_fallback(name: NamedColor) -> [u8; 4] {
    match name {
        NamedColor::Black => [0, 0, 0, 255],
        NamedColor::Red => [204, 0, 0, 255],
        NamedColor::Green => [0, 204, 0, 255],
        NamedColor::Yellow => [204, 204, 0, 255],
        NamedColor::Blue => [0, 0, 204, 255],
        NamedColor::Magenta => [204, 0, 204, 255],
        NamedColor::Cyan => [0, 204, 204, 255],
        NamedColor::White => [191, 191, 191, 255],
        NamedColor::BrightBlack => [128, 128, 128, 255],
        NamedColor::BrightRed => [255, 0, 0, 255],
        NamedColor::BrightGreen => [0, 255, 0, 255],
        NamedColor::BrightYellow => [255, 255, 0, 255],
        NamedColor::BrightBlue => [0, 0, 255, 255],
        NamedColor::BrightMagenta => [255, 0, 255, 255],
        NamedColor::BrightCyan => [0, 255, 255, 255],
        NamedColor::BrightWhite => [255, 255, 255, 255],
        NamedColor::Foreground => [217, 217, 217, 255],
        NamedColor::Background => BG_COLOR_BYTES,
        _ => [217, 217, 217, 255],
    }
}

fn ansi_256_color(idx: u8) -> [u8; 4] {
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
        let to_u8 = |v: u8| if v == 0 { 0 } else { 55 + 40 * v };
        return [to_u8(r), to_u8(g), to_u8(b), 255];
    }
    let v = 8 + 10 * (idx - 232);
    [v, v, v, 255]
}

fn snapshot_line<T: EventListener>(
    term: &Term<T>,
    row: usize,
    cols: usize,
    display_offset: usize,
    colors: &alacritty_terminal::term::color::Colors,
) -> Vec<CellInfo> {
    let line = Line(row as i32 - display_offset as i32);
    (&term.grid()[line])
        .into_iter()
        .take(cols)
        .map(|cell| CellInfo {
            c: cell.c,
            fg: resolve_color(cell.fg, colors),
            bg: resolve_color(cell.bg, colors),
            style: StyleBits::default()
                .with_bold(cell.flags.contains(CellFlags::BOLD))
                .with_italic(cell.flags.contains(CellFlags::ITALIC))
                .with_underline(cell.flags.intersects(
                    CellFlags::UNDERLINE
                        | CellFlags::DOUBLE_UNDERLINE
                        | CellFlags::UNDERCURL
                        | CellFlags::DOTTED_UNDERLINE
                        | CellFlags::DASHED_UNDERLINE,
                )),
        })
        .collect()
}
