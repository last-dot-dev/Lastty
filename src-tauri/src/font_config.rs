//! Terminal typography shared with the frontend via `get_font_config`.

use serde::Serialize;

#[derive(Clone, Copy, Debug, Serialize)]
pub struct FontConfig {
    pub family: &'static str,
    /// Logical (CSS) pixels.
    pub size_px: f32,
    /// Multiplier applied to `size_px` — matches xterm.js / CSS semantics.
    pub line_height: f32,
}

impl FontConfig {
    pub const DEFAULT: FontConfig = FontConfig {
        family: "Menlo",
        size_px: 14.0,
        line_height: 1.2,
    };
}
