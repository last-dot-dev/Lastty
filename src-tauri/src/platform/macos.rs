use std::ffi::c_void;
use std::ptr::NonNull;

use objc2::rc::Retained;
use objc2::{define_class, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{NSAutoresizingMaskOptions, NSView, NSWindow, NSWindowOrderingMode};
use objc2_foundation::{NSPoint, NSRect};
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
/// Retains the view so it stays alive for the lifetime of this handle.
pub struct MetalSubview {
    view: Retained<PassthroughView>,
}

unsafe impl Send for MetalSubview {}

impl MetalSubview {
    /// Resize the backing NSView frame. Call this when the window resizes.
    pub fn set_frame(&self, x: f64, y: f64, width: f64, height: f64) {
        let rect = NSRect::new(
            NSPoint::new(x, y),
            objc2_foundation::NSSize::new(width, height),
        );
        self.view.setFrame(rect);
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
/// The view auto-resizes with its parent.
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
    let view: Retained<PassthroughView> = unsafe {
        let alloc = PassthroughView::alloc(mtm);
        objc2::msg_send![alloc, initWithFrame: frame]
    };

    view.setWantsLayer(true);
    view.setAutoresizingMask(
        NSAutoresizingMaskOptions::ViewWidthSizable | NSAutoresizingMaskOptions::ViewHeightSizable,
    );

    // Place above the webview so the GPU output is visible. Input still
    // reaches the webview because PassthroughView returns nil from hitTest.
    let last_subview = content_view.subviews().lastObject();
    content_view.addSubview_positioned_relativeTo(
        &view,
        NSWindowOrderingMode::Above,
        last_subview.as_deref(),
    );

    MetalSubview { view }
}

/// Create a `wgpu::Surface` targeting the given `MetalSubview`.
///
/// # Safety
/// The `MetalSubview` must outlive the returned surface.
pub unsafe fn create_wgpu_surface(
    instance: &wgpu::Instance,
    subview: &MetalSubview,
) -> Result<wgpu::Surface<'static>, wgpu::CreateSurfaceError> {
    let raw_window_handle = RawWindowHandle::AppKit(AppKitWindowHandle::new(subview.ns_view_ptr()));
    let raw_display_handle = RawDisplayHandle::AppKit(AppKitDisplayHandle::new());

    unsafe {
        instance.create_surface_unsafe(wgpu::SurfaceTargetUnsafe::RawHandle {
            raw_display_handle: Some(raw_display_handle),
            raw_window_handle,
        })
    }
}
