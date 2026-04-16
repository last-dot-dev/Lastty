use std::borrow::Cow;
use std::collections::HashMap;
use std::fmt;
use std::path::Path;
use std::sync::mpsc;
use std::sync::Arc;
use std::thread;

use alacritty_terminal::event::WindowSize;
use alacritty_terminal::event_loop::{EventLoop, Msg};
use alacritty_terminal::sync::FairMutex;
use alacritty_terminal::term::{self, Term};
use alacritty_terminal::tty;
use uuid::Uuid;

use crate::render_sync::RenderCoordinator;

use super::event_proxy::EventProxy;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct SessionId(Uuid);

impl SessionId {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }

    pub fn parse(s: &str) -> Result<Self, String> {
        Uuid::parse_str(s)
            .map(Self)
            .map_err(|e| format!("invalid session id: {}", e))
    }

    pub fn as_u64(&self) -> u64 {
        self.0.as_u128() as u64
    }
}

impl fmt::Display for SessionId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum SessionStatus {
    Running,
    Exited(i32),
}

/// Dimensions helper that implements the Dimensions trait for Term::new.
pub struct TermDimensions {
    pub cols: usize,
    pub lines: usize,
}

impl alacritty_terminal::grid::Dimensions for TermDimensions {
    fn total_lines(&self) -> usize {
        self.lines
    }

    fn screen_lines(&self) -> usize {
        self.lines
    }

    fn columns(&self) -> usize {
        self.cols
    }
}

pub struct TerminalSession {
    pub id: SessionId,
    pub term: Arc<FairMutex<Term<EventProxy>>>,
    pub event_tx: EventLoopSender,
    _event_loop_handle: thread::JoinHandle<(EventLoop<tty::Pty, EventProxy>, alacritty_terminal::event_loop::State)>,
    pub status: SessionStatus,
}

pub type EventLoopSender = alacritty_terminal::event_loop::EventLoopSender;

pub fn create_session(
    command: Option<&str>,
    cwd: &Path,
    env: &HashMap<String, String>,
    cols: u16,
    rows: u16,
    render_coordinator: Arc<RenderCoordinator>,
    app: tauri::AppHandle,
) -> anyhow::Result<TerminalSession> {
    let id = SessionId::new();

    // Channel for PtyWrite events (DSR responses, etc.)
    let (pty_write_tx, pty_write_rx) = mpsc::channel::<String>();

    let event_proxy = EventProxy {
        session_id: id,
        render_coordinator,
        pty_write_tx,
        app,
    };

    // 1. Configure terminal
    let config = term::Config::default();
    let dimensions = TermDimensions {
        cols: cols as usize,
        lines: rows as usize,
    };
    let term = Term::new(config, &dimensions, event_proxy.clone());
    let term = Arc::new(FairMutex::new(term));

    // 2. Configure and open PTY
    let shell = command.map(|c| tty::Shell::new(c.to_string(), vec![]));
    let pty_config = tty::Options {
        shell,
        working_directory: Some(cwd.to_path_buf()),
        env: env.clone(),
        ..Default::default()
    };

    let window_size = WindowSize {
        num_cols: cols,
        num_lines: rows,
        cell_width: 8,
        cell_height: 16,
    };
    let pty = tty::new(&pty_config, window_size, id.as_u64())?;

    // 3. Start event loop (PTY I/O thread)
    let event_loop = EventLoop::new(
        Arc::clone(&term),
        event_proxy,
        pty,
        false,
        false,
    )?;
    let event_tx = event_loop.channel();
    let handle = event_loop.spawn();

    // 4. Spawn PtyWrite forwarder: reads DSR responses and sends them to PTY
    let pty_event_tx = event_tx.clone();
    thread::spawn(move || {
        while let Ok(text) = pty_write_rx.recv() {
            let _ = pty_event_tx.send(Msg::Input(Cow::Owned(text.into_bytes())));
        }
    });

    Ok(TerminalSession {
        id,
        term,
        event_tx,
        _event_loop_handle: handle,
        status: SessionStatus::Running,
    })
}

impl TerminalSession {
    pub fn write(&self, data: &[u8]) -> Result<(), String> {
        self.event_tx
            .send(Msg::Input(Cow::Owned(data.to_vec())))
            .map_err(|_| "session closed".to_string())
    }

    pub fn resize(&self, cols: u16, rows: u16, cell_w: u16, cell_h: u16) -> Result<(), String> {
        let size = WindowSize {
            num_cols: cols,
            num_lines: rows,
            cell_width: cell_w,
            cell_height: cell_h,
        };
        self.event_tx
            .send(Msg::Resize(size))
            .map_err(|_| "session closed".to_string())?;

        let dimensions = TermDimensions {
            cols: cols as usize,
            lines: rows as usize,
        };
        let mut term = self.term.lock();
        term.resize(dimensions);
        Ok(())
    }

    pub fn shutdown(&self) {
        let _ = self.event_tx.send(Msg::Shutdown);
    }
}
