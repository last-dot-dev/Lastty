struct Uniforms {
    screen_size: vec2<f32>,
    cell_size: vec2<f32>,
};

struct RectInstanceInput {
    @location(0) cell: vec2<u32>,
    @location(1) color: vec4<f32>,
};

struct RectVertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) color: vec4<f32>,
};

@group(0) @binding(0) var<uniform> u: Uniforms;

@vertex
fn vs_rect(
    @builtin(vertex_index) vertex_index: u32,
    instance: RectInstanceInput,
) -> RectVertexOutput {
    let corner = vec2<f32>(
        select(0.0, 1.0, (vertex_index & 1u) == 1u),
        select(0.0, 1.0, (vertex_index & 2u) == 2u),
    );
    let cell_origin = vec2<f32>(instance.cell) * u.cell_size;
    let pixel_pos = cell_origin + corner * u.cell_size;
    let ndc_x = (pixel_pos.x / u.screen_size.x) * 2.0 - 1.0;
    let ndc_y = 1.0 - (pixel_pos.y / u.screen_size.y) * 2.0;

    var out: RectVertexOutput;
    out.position = vec4<f32>(ndc_x, ndc_y, 0.0, 1.0);
    out.color = instance.color;
    return out;
}

@fragment
fn fs_rect(in: RectVertexOutput) -> @location(0) vec4<f32> {
    return in.color;
}
