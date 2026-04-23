//! Installed-font enumeration and byte loading exposed to the frontend.
//!
//! `list_monospace_fonts` powers the settings picker. `read_font_bytes` ships
//! the raw TTF/OTF bytes for a selected family so the frontend can register it
//! as a bytes-based `FontFace` — `local()` sources are invisible to WKWebView's
//! `<canvas>`, but bytes-based ones are, which is what xterm's `CanvasAddon`
//! needs to render user-installed fonts.
//!
//! macOS is the only supported platform. Other targets get empty results.

#[cfg(target_os = "macos")]
mod imp {
    use core_text::font::new_from_name;
    use core_text::font_manager::copy_available_font_family_names;
    use std::fs;

    const MONOSPACE_TRAIT: u32 = 1 << 10;

    pub fn list_monospace_fonts() -> Vec<String> {
        let families = copy_available_font_family_names();
        let mut names: Vec<String> = families
            .iter()
            .filter_map(|cf| {
                let name = cf.to_string();
                if name.starts_with('.') {
                    return None;
                }
                let font = new_from_name(&name, 14.0).ok()?;
                (font.symbolic_traits() & MONOSPACE_TRAIT != 0).then_some(name)
            })
            .collect();
        names.sort_by_key(|a| a.to_lowercase());
        names.dedup();
        names
    }

    pub fn read_font_bytes(family: &str) -> Result<Vec<u8>, String> {
        let font =
            new_from_name(family, 14.0).map_err(|_| format!("font family not found: {family}"))?;
        let url = font
            .url()
            .ok_or_else(|| format!("font has no file URL: {family}"))?;
        let path = url
            .to_path()
            .ok_or_else(|| format!("font URL is not a file path: {family}"))?;
        fs::read(&path).map_err(|e| format!("read {}: {e}", path.display()))
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    pub fn list_monospace_fonts() -> Vec<String> {
        Vec::new()
    }

    pub fn read_font_bytes(_family: &str) -> Result<Vec<u8>, String> {
        Err("font byte loading is only supported on macOS".to_string())
    }
}

pub use imp::{list_monospace_fonts, read_font_bytes};

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[test]
    fn returns_common_mac_monospace_fonts() {
        let fonts = list_monospace_fonts();
        assert!(!fonts.is_empty());
        assert!(fonts.iter().any(|f| f == "Menlo"));
    }

    #[test]
    fn reads_menlo_bytes() {
        let bytes = read_font_bytes("Menlo").expect("menlo should be readable");
        assert!(
            bytes.len() > 1000,
            "font file should be non-trivial in size"
        );
    }
}
