struct Uniforms {
    screen_size: vec2<f32>,
    atlas_size: vec2<f32>,
    cell_size: vec2<f32>,
    baseline: f32,
};

struct Instance {
    @location(0) cell: vec2<u32>,
    @location(1) atlas_pos: vec2<u32>,
    @location(2) glyph_size: vec2<u32>,
    @location(3) bearing: vec2<i32>,
    @location(4) color: vec4<f32>,
};

struct VsOut {
    @builtin(position) clip_pos: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) color: vec4<f32>,
};

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var atlas_tex: texture_2d<f32>;
@group(0) @binding(2) var atlas_samp: sampler;

@vertex
fn vs_main(
    @builtin(vertex_index) vertex_index: u32,
    instance: Instance,
) -> VsOut {
    let corner = vec2<f32>(
        select(0.0, 1.0, (vertex_index & 1u) == 1u),
        select(0.0, 1.0, (vertex_index & 2u) == 2u),
    );
    let cell_origin = vec2<f32>(instance.cell) * u.cell_size;
    let glyph_origin = cell_origin + vec2<f32>(
        f32(instance.bearing.x),
        u.baseline - f32(instance.bearing.y),
    );
    let glyph_extent = vec2<f32>(instance.glyph_size);
    let pixel_pos = glyph_origin + corner * glyph_extent;
    let ndc_x = (pixel_pos.x / u.screen_size.x) * 2.0 - 1.0;
    let ndc_y = 1.0 - (pixel_pos.y / u.screen_size.y) * 2.0;

    let atlas_pixel = vec2<f32>(instance.atlas_pos) + corner * glyph_extent;
    let uv = atlas_pixel / u.atlas_size;

    var out: VsOut;
    out.clip_pos = vec4<f32>(ndc_x, ndc_y, 0.0, 1.0);
    out.uv = uv;
    out.color = instance.color;
    return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
    let alpha = textureSample(atlas_tex, atlas_samp, in.uv).r;
    return vec4<f32>(in.color.rgb, in.color.a * alpha);
}
