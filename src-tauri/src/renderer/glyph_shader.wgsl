// Instanced glyph renderer.
//
// One draw call per frame emits 6 vertices * N_glyphs. Each instance carries
// the cell's pixel position, the glyph's atlas region, and the foreground
// color. The fragment shader samples the R8 atlas as a coverage mask and
// tints it with the instance color.

struct Uniforms {
    // Destination surface size in pixels.
    screen_size: vec2<f32>,
    // Atlas texture size in pixels — used to convert atlas-pixel coords to
    // normalized [0,1] UVs.
    atlas_size: vec2<f32>,
};

struct Instance {
    // Pixel coordinate of the glyph's top-left on screen (cell_origin + bearing).
    @location(0) pos: vec2<f32>,
    // Glyph pixel size.
    @location(1) size: vec2<f32>,
    // Atlas pixel coord of the glyph's top-left.
    @location(2) atlas_pos: vec2<f32>,
    // RGBA foreground color (0..1).
    @location(3) color: vec4<f32>,
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
    @builtin(vertex_index) vi: u32,
    instance: Instance,
) -> VsOut {
    // Two triangles forming a quad: 0,1,2 then 2,1,3 (triangle-strip layout
    // emulated via indexed positions). Corner table:
    //   0 = top-left   (0,0)
    //   1 = top-right  (1,0)
    //   2 = bot-left   (0,1)
    //   3 = bot-right  (1,1)
    let corner_idx = array<u32, 6>(0u, 1u, 2u, 2u, 1u, 3u);
    let idx = corner_idx[vi];
    let corner = vec2<f32>(
        select(0.0, 1.0, (idx & 1u) == 1u),
        select(0.0, 1.0, (idx & 2u) == 2u),
    );

    let pixel_pos = instance.pos + corner * instance.size;

    // Convert pixel → NDC. Y is flipped so that pixel_y=0 is the top of the
    // screen, matching our CPU-side layout.
    let ndc_x = (pixel_pos.x / u.screen_size.x) * 2.0 - 1.0;
    let ndc_y = 1.0 - (pixel_pos.y / u.screen_size.y) * 2.0;

    let atlas_pixel = instance.atlas_pos + corner * instance.size;
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
