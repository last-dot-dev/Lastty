//! Per-pane wgpu surfaces.
//!
//! React owns layout; it pushes a list of pane rects via `update_pane_layout`.
//! Each pane gets a child NSView + wgpu surface + `TerminalRenderer`. Regions
//! outside any pane are simply uncovered, so the webview underneath shows
//! through with no scissor or transparency bookkeeping required.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crate::font_config::FontConfig;
use crate::terminal::session::SessionId;

use super::atlas::GlyphAtlas;
use super::TerminalRenderer;

#[cfg(target_os = "macos")]
use crate::platform::macos::MetalSubview;

/// The pane's last-known position and size in AppKit points plus its DPR.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PaneFrameRect {
    /// Top-left origin in AppKit points, relative to the window's content view.
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    /// Backing scale factor for the display the window is on.
    pub scale: f64,
}

impl PaneFrameRect {
    /// Physical-pixel size after applying the scale factor.
    pub fn physical_size(&self) -> (u32, u32) {
        let w = (self.width * self.scale).round().max(1.0) as u32;
        let h = (self.height * self.scale).round().max(1.0) as u32;
        (w, h)
    }
}

pub struct PaneSurface {
    #[cfg(target_os = "macos")]
    pub subview: MetalSubview,
    pub renderer: TerminalRenderer,
    pub frame: PaneFrameRect,
    pub rendered_generation: u64,
}

/// Shared wgpu device/queue/format. Cloned cheaply (each field is
/// reference-counted internally).
#[derive(Clone)]
pub struct GpuContext {
    pub instance: wgpu::Instance,
    pub adapter: wgpu::Adapter,
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
    pub format: wgpu::TextureFormat,
}

/// Registry of per-session wgpu surfaces. Lives in Tauri managed state
/// alongside `TerminalManager`. The renderer thread iterates this registry
/// to drive per-pane rendering.
pub struct PaneSurfaces {
    pub gpu: GpuContext,
    pub atlas: Arc<Mutex<GlyphAtlas>>,
    pub font_config: FontConfig,
    inner: Mutex<HashMap<SessionId, PaneSurface>>,
}

impl PaneSurfaces {
    pub fn new(gpu: GpuContext, atlas: GlyphAtlas, font_config: FontConfig) -> Self {
        Self {
            gpu,
            atlas: Arc::new(Mutex::new(atlas)),
            font_config,
            inner: Mutex::new(HashMap::new()),
        }
    }

    pub fn with<T>(&self, f: impl FnOnce(&HashMap<SessionId, PaneSurface>) -> T) -> T {
        let guard = self.inner.lock().expect("pane surfaces mutex poisoned");
        f(&guard)
    }

    pub fn with_mut<T>(&self, f: impl FnOnce(&mut HashMap<SessionId, PaneSurface>) -> T) -> T {
        let mut guard = self.inner.lock().expect("pane surfaces mutex poisoned");
        f(&mut guard)
    }

    /// Visit a single pane mutably, if it exists.
    pub fn with_pane_mut<T>(
        &self,
        session_id: &SessionId,
        f: impl FnOnce(&mut PaneSurface) -> T,
    ) -> Option<T> {
        let mut guard = self.inner.lock().expect("pane surfaces mutex poisoned");
        guard.get_mut(session_id).map(f)
    }

    pub fn session_ids(&self) -> Vec<SessionId> {
        self.inner
            .lock()
            .expect("pane surfaces mutex poisoned")
            .keys()
            .copied()
            .collect()
    }
}
