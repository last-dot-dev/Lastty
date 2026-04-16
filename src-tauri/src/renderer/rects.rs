use bytemuck::{Pod, Zeroable};

/// Vertex for rect rendering (cell backgrounds, cursor, selection).
#[repr(C)]
#[derive(Copy, Clone, Debug, Pod, Zeroable)]
pub struct RectVertex {
    pub position: [f32; 2],
    pub color: [f32; 4],
}

impl RectVertex {
    pub fn desc() -> wgpu::VertexBufferLayout<'static> {
        wgpu::VertexBufferLayout {
            array_stride: std::mem::size_of::<Self>() as wgpu::BufferAddress,
            step_mode: wgpu::VertexStepMode::Vertex,
            attributes: &[
                wgpu::VertexAttribute {
                    offset: 0,
                    shader_location: 0,
                    format: wgpu::VertexFormat::Float32x2,
                },
                wgpu::VertexAttribute {
                    offset: 8,
                    shader_location: 1,
                    format: wgpu::VertexFormat::Float32x4,
                },
            ],
        }
    }
}

/// Build a quad (two triangles) for a rect.
pub fn rect_quad(x: f32, y: f32, w: f32, h: f32, color: [f32; 4]) -> [RectVertex; 6] {
    [
        RectVertex { position: [x, y], color },
        RectVertex { position: [x + w, y], color },
        RectVertex { position: [x, y + h], color },
        RectVertex { position: [x + w, y], color },
        RectVertex { position: [x + w, y + h], color },
        RectVertex { position: [x, y + h], color },
    ]
}
