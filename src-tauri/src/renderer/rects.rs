use bytemuck::{Pod, Zeroable};

pub const QUAD_INDICES: [u16; 6] = [0, 1, 2, 2, 1, 3];

/// Instanced rect payload for cell backgrounds and overlays.
#[repr(C)]
#[derive(Copy, Clone, Debug, Default, Pod, Zeroable)]
pub struct RectInstance {
    pub cell: [u16; 2],
    pub color: [u8; 4],
}

impl RectInstance {
    pub fn desc() -> wgpu::VertexBufferLayout<'static> {
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
                    format: wgpu::VertexFormat::Unorm8x4,
                },
            ],
        }
    }

    pub fn hidden(cell: [u16; 2]) -> Self {
        Self {
            cell,
            color: [0, 0, 0, 0],
        }
    }

    pub fn solid(cell: [u16; 2], color: [u8; 4]) -> Self {
        Self { cell, color }
    }
}
