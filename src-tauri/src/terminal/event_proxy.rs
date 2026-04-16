use std::borrow::Cow;
use std::sync::mpsc;

use alacritty_terminal::event::{Event, EventListener};
use alacritty_terminal::event_loop::Msg;
use tauri::{AppHandle, Emitter};

use super::session::{EventLoopSender, SessionId};

/// Bridges alacritty_terminal events to our app.
/// Implements EventListener which Term<T> requires.
#[derive(Clone)]
pub struct EventProxy {
    pub session_id: SessionId,
    /// Sender to notify the renderer that the grid changed.
    pub wakeup_tx: mpsc::Sender<SessionId>,
    /// Sender to write back to the PTY (for DSR responses etc.).
    pub pty_write_tx: mpsc::Sender<String>,
    /// Tauri app handle for emitting events to webview.
    pub app: AppHandle,
}

impl EventListener for EventProxy {
    fn send_event(&self, event: Event) {
        match event {
            Event::Wakeup => {
                let _ = self.wakeup_tx.send(self.session_id);
            }
            Event::PtyWrite(text) => {
                // Forward DSR responses and other pty-write-back requests.
                let _ = self.pty_write_tx.send(text);
            }
            Event::ChildExit(status) => {
                self.app
                    .emit(
                        "session:exit",
                        serde_json::json!({
                            "session_id": self.session_id.to_string(),
                            "code": status.code(),
                        }),
                    )
                    .ok();
            }
            Event::Title(title) => {
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
