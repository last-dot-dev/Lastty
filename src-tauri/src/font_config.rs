//! Source of truth for terminal typography, shared between the wgpu renderer
//! and the xterm.js path.
//!
//! Both paths read the same family / size / line-height values through the
//! `get_font_config` IPC command so the visible grid layout matches
//! regardless of which renderer the user selects via `LASTTY_RENDERER`.

use serde::Serialize;

#[derive(Clone, Copy, Debug, Serialize)]
pub struct FontConfig {
    pub family: &'static str,
    /// Logical (CSS) pixels. The wgpu path multiplies by the window's scale
    /// factor to rasterize at native resolution; xterm.js uses the value
    /// directly because the browser handles DPI itself.
    pub size_px: f32,
    /// Multiplier applied to `size_px` — matches xterm.js / CSS semantics so
    /// the same value drives both paths.
    pub line_height: f32,
}

impl FontConfig {
    pub const DEFAULT: FontConfig = FontConfig {
        family: "Menlo",
        size_px: 14.0,
        line_height: 1.2,
    };
}
