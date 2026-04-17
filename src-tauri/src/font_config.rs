//! Source of truth for terminal typography, shared between the wgpu renderer
//! and the xterm.js path.
//!
//! Both paths read the same family / size / line-height values through the
//! `get_font_config` IPC command so the visible grid layout matches
//! regardless of which renderer the user selects via `LASTTY_RENDERER`.

use std::sync::Arc;

use serde::Serialize;
use swash::FontRef;

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

/// Cell metrics derived from the font at a given DPR.
///
/// Kept in a single place so the wgpu atlas and any future xterm-side sizing
/// path agree on cell dimensions byte-for-byte.
#[derive(Clone, Copy, Debug)]
pub struct CellMetrics {
    pub font_size: f32,
    pub cell_width: f32,
    pub cell_height: f32,
    /// Distance from cell top to baseline.
    pub baseline: f32,
}

/// Compute cell metrics for the given font data at `scale_factor`.
pub fn cell_metrics(
    font_data: &[u8],
    font_index: u32,
    config: FontConfig,
    scale_factor: f32,
) -> anyhow::Result<CellMetrics> {
    let font_size = config.size_px * scale_factor;
    let font = FontRef::from_index(font_data, font_index as usize)
        .ok_or_else(|| anyhow::anyhow!("failed to parse font data"))?;
    let metrics = font.metrics(&[]).scale(font_size);
    let glyph_metrics = font.glyph_metrics(&[]).scale(font_size);
    let charmap = font.charmap();

    // Cell width: advance of an unambiguously full-width glyph in a monospace
    // font. 'M' is a conventional choice; fall back to 'x'.
    let probe = charmap.map('M' as u32);
    let advance = if probe != 0 {
        glyph_metrics.advance_width(probe)
    } else {
        glyph_metrics.advance_width(charmap.map('x' as u32))
    };
    let cell_width = advance.round().max(1.0);

    // Cell height matches xterm.js semantics: `font_size * line_height`. This
    // keeps both renderer paths laying out the same grid without the wgpu
    // side drifting to whatever happens to be in the font's hhea table. Any
    // extra vertical room shows up as padding around the glyph inside each
    // cell, which is exactly what xterm does.
    let cell_height = (font_size * config.line_height).ceil().max(1.0);

    // Center the glyph within the cell: pad above the font's ascent by half
    // the extra space.
    let natural_line = metrics.ascent + metrics.descent + metrics.leading;
    let extra = (cell_height - natural_line).max(0.0);
    let baseline = (metrics.ascent + extra * 0.5).round();

    Ok(CellMetrics {
        font_size,
        cell_width,
        cell_height,
        baseline,
    })
}

/// Resolve a monospace font on the host. Tries a fast-path direct read from
/// known macOS system-font paths first (avoiding `fontdb::load_system_fonts()`
/// which scans hundreds of files), then falls back to a generic fontdb query.
pub fn load_monospace_font(preferred_family: &str) -> anyhow::Result<(Arc<Vec<u8>>, u32)> {
    #[cfg(target_os = "macos")]
    {
        let fast_paths: &[(&str, &str, u32)] = &[
            ("Menlo", "/System/Library/Fonts/Menlo.ttc", 0),
            ("Monaco", "/System/Library/Fonts/Monaco.ttf", 0),
            ("SF Mono", "/System/Library/Fonts/SFNSMono.ttf", 0),
        ];
        for (family, path, index) in fast_paths {
            if !family.eq_ignore_ascii_case(preferred_family) {
                continue;
            }
            if let Ok(data) = std::fs::read(path) {
                tracing::info!(
                    "loaded monospace font (fast path): family={}, path={}, bytes={}, index={}",
                    family,
                    path,
                    data.len(),
                    index
                );
                return Ok((Arc::new(data), *index));
            }
        }
    }

    let mut db = fontdb::Database::new();
    db.load_system_fonts();

    let preferred = fontdb::Family::Name(preferred_family);
    let queries = [
        preferred,
        fontdb::Family::Monospace,
        fontdb::Family::Name("Menlo"),
        fontdb::Family::Name("SF Mono"),
        fontdb::Family::Name("Monaco"),
        fontdb::Family::Name("Courier New"),
    ];

    for family in &queries {
        let query = fontdb::Query {
            families: std::slice::from_ref(family),
            weight: fontdb::Weight::NORMAL,
            stretch: fontdb::Stretch::Normal,
            style: fontdb::Style::Normal,
        };
        if let Some(id) = db.query(&query) {
            if let Some((source, index)) = db.face_source(id) {
                let data = match source {
                    fontdb::Source::Binary(data) => data.as_ref().as_ref().to_vec(),
                    fontdb::Source::File(path) => std::fs::read(&path)?,
                    fontdb::Source::SharedFile(_, data) => data.as_ref().as_ref().to_vec(),
                };
                tracing::info!(
                    "loaded monospace font: family={:?}, bytes={}, index={}",
                    family,
                    data.len(),
                    index
                );
                return Ok((Arc::new(data), index));
            }
        }
    }

    anyhow::bail!("no monospace font available from the system font database")
}
