use std::ffi::c_void;
use std::ptr::NonNull;

use objc2::rc::Retained;
use objc2::{MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{NSAutoresizingMaskOptions, NSView, NSWindow, NSWindowOrderingMode};
use objc2_foundation::NSRect;
use raw_window_handle::{
    AppKitDisplayHandle, AppKitWindowHandle, RawDisplayHandle, RawWindowHandle,
};

/// Opaque handle to the child NSView used as the wgpu render target.
/// Retains the view so it stays alive for the lifetime of this handle.
pub struct MetalSubview {
    view: Retained<NSView>,
}

unsafe impl Send for MetalSubview {}

impl MetalSubview {
    /// Resize the backing NSView frame. Call this when the window resizes.
    pub fn set_frame(&self, x: f64, y: f64, width: f64, height: f64) {
        let rect = NSRect::new(
            objc2_foundation::NSPoint::new(x, y),
            objc2_foundation::NSSize::new(width, height),
        );
        self.view.setFrame(rect);
    }

    /// Raw pointer to the NSView, for building wgpu surface handles.
    pub fn ns_view_ptr(&self) -> NonNull<c_void> {
        let ptr: *const NSView = &*self.view;
        NonNull::new(ptr as *mut c_void).expect("retained NSView pointer is never null")
    }
}

/// Create a child NSView inside the given NSWindow's contentView.
///
/// The view is set to auto-resize with its parent so it tracks window size
/// changes automatically. Returns the retained view handle.
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
    let view = NSView::initWithFrame(NSView::alloc(mtm), frame);
    view.setWantsLayer(true);
    view.setAutoresizingMask(
        NSAutoresizingMaskOptions::ViewWidthSizable
            | NSAutoresizingMaskOptions::ViewHeightSizable,
    );

    // Insert below the webview so the webview can overlay transparent UI on top.
    let first_subview = content_view.subviews().firstObject();
    content_view.addSubview_positioned_relativeTo(
        &view,
        NSWindowOrderingMode::Below,
        first_subview.as_deref(),
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
