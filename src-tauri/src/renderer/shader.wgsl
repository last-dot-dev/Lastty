// Rect shader — cell backgrounds, cursor, selection
struct RectVertexInput {
    @location(0) position: vec2<f32>,
    @location(1) color: vec4<f32>,
};

struct RectVertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) color: vec4<f32>,
};

@vertex
fn vs_rect(in: RectVertexInput) -> RectVertexOutput {
    var out: RectVertexOutput;
    out.position = vec4<f32>(in.position, 0.0, 1.0);
    out.color = in.color;
    return out;
}

@fragment
fn fs_rect(in: RectVertexOutput) -> @location(0) vec4<f32> {
    return in.color;
}
