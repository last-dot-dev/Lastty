use std::ffi::c_void;
use std::ptr::NonNull;

use objc2::rc::Retained;
use objc2::{define_class, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{NSAutoresizingMaskOptions, NSView, NSWindow, NSWindowOrderingMode};
use objc2_foundation::{NSPoint, NSRect, NSSize};
use raw_window_handle::{
    AppKitDisplayHandle, AppKitWindowHandle, RawDisplayHandle, RawWindowHandle,
};

define_class!(
    /// An NSView subclass that renders normally but is transparent to all
    /// mouse/cursor events. Hit-testing returns nil so events fall through
    /// to whatever sibling view (e.g. the webview) sits underneath, which
    /// keeps the WKWebView as first responder for keyboard and mouse input.
    #[unsafe(super = NSView)]
    #[thread_kind = MainThreadOnly]
    #[name = "LasttyPassthroughView"]
    pub struct PassthroughView;

    impl PassthroughView {
        #[unsafe(method(hitTest:))]
        fn hit_test(&self, _point: NSPoint) -> *mut NSView {
            std::ptr::null_mut()
        }

        #[unsafe(method(acceptsFirstResponder))]
        fn accepts_first_responder(&self) -> bool {
            false
        }
    }
);

/// Opaque handle to the child NSView used as the wgpu render target.
///
/// The NSView's frame is in AppKit points; its backing CAMetalLayer's
/// `contentsScale` is pinned to the host window's `backingScaleFactor` so the
/// wgpu surface's physical pixel size matches `frame * scale`. Without that
/// pin, programmatically-created layers default to 1.0 on Retina and every
/// glyph renders at half scale.
pub struct MetalSubview {
    view: Retained<PassthroughView>,
}

unsafe impl Send for MetalSubview {}

impl MetalSubview {
    /// Set the backing NSView's frame from a **top-left-origin** rect in
    /// AppKit points. Converts to the parent's coord system (which on macOS
    /// is typically bottom-left-origin) and pins the layer's `contentsScale`
    /// to `scale`. Callers must never touch `contentsScale` directly.
    pub fn set_frame_points(&self, x: f64, y_top: f64, width: f64, height: f64, scale: f64) {
        let parent = unsafe { self.view.superview() };
        let rect = match parent.as_deref() {
            Some(parent) => flip_rect_to_parent(parent, x, y_top, width, height),
            None => NSRect::new(NSPoint::new(x, y_top), NSSize::new(width, height)),
        };
        self.view.setFrame(rect);
        self.apply_contents_scale(scale);
    }

    /// Apply `scale` to the backing layer. Safe to call at any time.
    pub fn apply_contents_scale(&self, scale: f64) {
        if let Some(layer) = self.view.layer() {
            layer.setContentsScale(scale);
        }
    }

    /// Detach the NSView from its parent. Called when a pane is removed so
    /// the parent view releases its retain and the backing layer goes away.
    pub fn remove_from_superview(&self) {
        self.view.removeFromSuperview();
    }

    /// Raw pointer to the NSView, for building wgpu surface handles.
    pub fn ns_view_ptr(&self) -> NonNull<c_void> {
        let ptr: *const PassthroughView = &*self.view;
        NonNull::new(ptr as *mut c_void).expect("retained NSView pointer is never null")
    }
}

/// Create a child NSView inside the given NSWindow's contentView.
///
/// The view sits above the webview in z-order so it's visible, but its
/// `hitTest:` is overridden to return nil — so mouse/keyboard events pass
/// through to the webview underneath. The webview keeps first responder
/// status and existing key_input/terminal_input IPC handlers continue to
/// work normally.
///
/// The view auto-resizes with its parent and its layer's `contentsScale` is
/// initialized from the window's `backingScaleFactor`.
///
/// # Safety
/// `ns_window_ptr` must be a valid pointer to an NSWindow.
pub unsafe fn create_metal_subview(ns_window_ptr: *mut c_void) -> MetalSubview {
    let mtm = MainThreadMarker::new().expect("must be called from the main thread");
    let ns_window: &NSWindow = unsafe { &*(ns_window_ptr as *const NSWindow) };
    let content_view = ns_window
        .contentView()
        .expect("NSWindow must have a contentView");

    let frame = content_view.frame();
    let scale = ns_window.backingScaleFactor();
    let view: Retained<PassthroughView> = unsafe {
        let alloc = PassthroughView::alloc(mtm);
        objc2::msg_send![alloc, initWithFrame: frame]
    };

    view.setWantsLayer(true);
    view.setAutoresizingMask(
        NSAutoresizingMaskOptions::ViewWidthSizable
            | NSAutoresizingMaskOptions::ViewHeightSizable,
    );

    // Place above the webview so the GPU output is visible. Input still
    // reaches the webview because PassthroughView returns nil from hitTest.
    let last_subview = content_view.subviews().lastObject();
    content_view.addSubview_positioned_relativeTo(
        &view,
        NSWindowOrderingMode::Above,
        last_subview.as_deref(),
    );

    // Layer is created lazily by AppKit once the view is in the window and
    // `wantsLayer` is set. Pin `contentsScale` so wgpu's physical-px surface
    // matches `points * scale` on Retina.
    if let Some(layer) = view.layer() {
        layer.setContentsScale(scale);
    }

    MetalSubview { view }
}

/// Create a child NSView inside the given NSWindow's contentView at a
/// specific rect (AppKit points). The view is sized and positioned exactly
/// — no autoresizing — so callers can place it underneath React's layout.
/// `contentsScale` is pinned to `scale`, which should come from the window's
/// `backingScaleFactor`.
///
/// # Safety
/// `ns_window_ptr` must be a valid pointer to an NSWindow.
pub unsafe fn create_pane_subview(
    ns_window_ptr: *mut c_void,
    x: f64,
    y_top: f64,
    width: f64,
    height: f64,
    scale: f64,
) -> MetalSubview {
    let mtm = MainThreadMarker::new().expect("must be called from the main thread");
    let ns_window: &NSWindow = unsafe { &*(ns_window_ptr as *const NSWindow) };
    let content_view = ns_window
        .contentView()
        .expect("NSWindow must have a contentView");

    let frame = flip_rect_to_parent(&content_view, x, y_top, width, height);
    let view: Retained<PassthroughView> = unsafe {
        let alloc = PassthroughView::alloc(mtm);
        objc2::msg_send![alloc, initWithFrame: frame]
    };

    view.setWantsLayer(true);

    let last_subview = content_view.subviews().lastObject();
    content_view.addSubview_positioned_relativeTo(
        &view,
        NSWindowOrderingMode::Above,
        last_subview.as_deref(),
    );

    if let Some(layer) = view.layer() {
        layer.setContentsScale(scale);
    }

    MetalSubview { view }
}

/// Convert a top-left-origin rect in `parent`'s coordinate space to the
/// `NSRect` that `view.setFrame` expects. Matches wry's `window_position`
/// helper — the shared contract keeps wgpu panes visually lined up with the
/// webview across macOS coordinate systems.
fn flip_rect_to_parent(
    parent: &NSView,
    x: f64,
    y_top: f64,
    width: f64,
    height: f64,
) -> NSRect {
    let y = if parent.isFlipped() {
        y_top
    } else {
        parent.bounds().size.height - y_top - height
    };
    NSRect::new(NSPoint::new(x, y), NSSize::new(width, height))
}

/// Create a `wgpu::Surface` targeting the given `MetalSubview`.
///
/// # Safety
/// The `MetalSubview` must outlive the returned surface.
pub unsafe fn create_wgpu_surface(
    instance: &wgpu::Instance,
    subview: &MetalSubview,
) -> Result<wgpu::Surface<'static>, wgpu::CreateSurfaceError> {
    let raw_window_handle =
        RawWindowHandle::AppKit(AppKitWindowHandle::new(subview.ns_view_ptr()));
    let raw_display_handle = RawDisplayHandle::AppKit(AppKitDisplayHandle::new());

    unsafe {
        instance.create_surface_unsafe(wgpu::SurfaceTargetUnsafe::RawHandle {
            raw_display_handle: Some(raw_display_handle),
            raw_window_handle,
        })
    }
}
