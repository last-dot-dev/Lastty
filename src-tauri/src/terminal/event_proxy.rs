use std::sync::mpsc;
use std::sync::{Arc, Mutex};

use alacritty_terminal::event::{Event, EventListener};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::bus::{BusEvent, EventBus};
use crate::render_sync::RenderCoordinator;

use super::session::SessionId;

/// Bridges alacritty_terminal events to our app.
/// Implements EventListener which Term<T> requires.
pub struct EventProxy<R: Runtime = tauri::Wry> {
    pub session_id: SessionId,
    /// Notifier to mark the latest terminal state as dirty.
    pub render_coordinator: std::sync::Arc<RenderCoordinator>,
    /// Sender to write back to the PTY (for DSR responses etc.).
    pub pty_write_tx: mpsc::Sender<String>,
    /// Tauri app handle for emitting events to webview.
    pub app: AppHandle<R>,
    pub title: Arc<Mutex<String>>,
    pub workspace_path: Option<String>,
    pub worktree_path: Option<String>,
}

impl<R: Runtime> Clone for EventProxy<R> {
    fn clone(&self) -> Self {
        Self {
            session_id: self.session_id,
            render_coordinator: self.render_coordinator.clone(),
            pty_write_tx: self.pty_write_tx.clone(),
            app: self.app.clone(),
            title: self.title.clone(),
            workspace_path: self.workspace_path.clone(),
            worktree_path: self.worktree_path.clone(),
        }
    }
}

impl<R: Runtime> EventListener for EventProxy<R> {
    fn send_event(&self, event: Event) {
        match event {
            Event::Wakeup => {
                self.render_coordinator.mark_dirty(self.session_id);
            }
            Event::PtyWrite(text) => {
                // Forward DSR responses and other pty-write-back requests.
                let _ = self.pty_write_tx.send(text);
            }
            Event::ChildExit(status) => {
                if let (Some(workspace_path), Some(worktree_path)) =
                    (self.workspace_path.as_ref(), self.worktree_path.as_ref())
                {
                    let _ = std::process::Command::new("git")
                        .args(["worktree", "remove", "--force", worktree_path])
                        .current_dir(workspace_path)
                        .status();
                }
                self.app
                    .emit(
                        "session:exit",
                        serde_json::json!({
                            "session_id": self.session_id.to_string(),
                            "code": status.code(),
                        }),
                    )
                    .ok();
                self.app
                    .state::<EventBus<R>>()
                    .publish(BusEvent::SessionExited {
                        session_id: self.session_id.to_string(),
                        exit_code: status.code(),
                    });
            }
            Event::Title(title) => {
                *self.title.lock().unwrap() = title.clone();
                self.app
                    .emit(
                        "session:title",
                        serde_json::json!({
                            "session_id": self.session_id.to_string(),
                            "title": title,
                        }),
                    )
                    .ok();
            }
            _ => {}
        }
    }
}
