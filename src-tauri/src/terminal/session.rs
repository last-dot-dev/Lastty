use std::borrow::Cow;
use std::collections::HashMap;
use std::fmt;
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use alacritty_terminal::event::WindowSize;
use alacritty_terminal::event_loop::{EventLoop, Msg};
use alacritty_terminal::sync::FairMutex;
use alacritty_terminal::term::{self, Term};
use alacritty_terminal::tty;
use pane_protocol::{AgentUiMessage, OscParser, ParsedChunk, PeerMessage};
use serde::Serialize;
use tauri::{Emitter, Manager, Runtime};
use uuid::Uuid;

use crate::adapters::{runner, AgentAdapter};
use crate::bus::{BusEvent, EventBus};
use crate::events::AgentUiEvent;
use crate::render_sync::RenderCoordinator;

use super::event_proxy::EventProxy;
use super::osc7::Osc7Scanner;

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

impl Default for SessionId {
    fn default() -> Self {
        Self::new()
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

#[derive(Debug, Clone, Serialize)]
pub struct SessionInfo {
    pub session_id: String,
    pub title: String,
    pub agent_id: Option<String>,
    pub cwd: String,
    pub prompt: Option<String>,
    pub prompt_summary: Option<String>,
    pub worktree_path: Option<String>,
    pub control_connected: bool,
    pub started_at_ms: u128,
    pub started_at_unix_ms: u128,
}

#[derive(Debug, Clone)]
pub struct CommandSpec {
    pub program: String,
    pub args: Vec<String>,
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

type EventLoopHandle<R> = thread::JoinHandle<(
    EventLoop<InterceptingPty<R>, EventProxy<R>>,
    alacritty_terminal::event_loop::State,
)>;

pub struct TerminalSession<R: Runtime = tauri::Wry> {
    pub id: SessionId,
    pub term: Arc<FairMutex<Term<EventProxy<R>>>>,
    pub event_tx: EventLoopSender,
    _event_loop_handle: EventLoopHandle<R>,
    pub status: SessionStatus,
    pub started_at: Instant,
    pub started_at_unix_ms: u128,
    pub title: Arc<Mutex<String>>,
    pub agent_id: Option<String>,
    pub cwd: Arc<Mutex<String>>,
    pub prompt: Option<String>,
    pub prompt_summary: Option<String>,
    pub worktree_path: Option<String>,
    pub attention_menu_active: Arc<AtomicBool>,
    control_socket_path: Option<std::path::PathBuf>,
    control_connected: Arc<AtomicBool>,
    #[cfg(unix)]
    control_stream: Arc<Mutex<Option<std::os::unix::net::UnixStream>>>,
    control_accept_alive: Arc<AtomicBool>,
}

pub type EventLoopSender = alacritty_terminal::event_loop::EventLoopSender;

#[derive(Debug, Clone, Default)]
pub struct SessionConfig {
    pub command: Option<CommandSpec>,
    pub cwd: PathBuf,
    pub env: HashMap<String, String>,
    pub cols: u16,
    pub rows: u16,
    pub agent_id: Option<String>,
    pub prompt_summary: Option<String>,
    pub prompt: Option<String>,
    pub worktree_path: Option<String>,
}

pub fn create_session<R: Runtime>(
    config: SessionConfig,
    render_coordinator: Arc<RenderCoordinator>,
    app: tauri::AppHandle<R>,
    adapter: Option<Box<dyn AgentAdapter>>,
) -> anyhow::Result<TerminalSession<R>> {
    let SessionConfig {
        command,
        cwd,
        env,
        cols,
        rows,
        agent_id,
        prompt_summary,
        prompt,
        worktree_path,
    } = config;

    let id = SessionId::new();
    let title = Arc::new(Mutex::new("shell".to_string()));
    let cwd_shared = Arc::new(Mutex::new(cwd.display().to_string()));
    let adapter_active = adapter.is_some();
    let control_connected = Arc::new(AtomicBool::new(false));
    let control_accept_alive = Arc::new(AtomicBool::new(true));
    #[cfg(unix)]
    let control_stream = Arc::new(Mutex::new(None));
    #[cfg(unix)]
    let control_socket_path = Some(std::env::temp_dir().join(format!("lastty-{}.sock", id)));
    #[cfg(not(unix))]
    let control_socket_path: Option<PathBuf> = None;

    // Channel for PtyWrite events (DSR responses, etc.)
    let (pty_write_tx, pty_write_rx) = mpsc::channel::<String>();

    let event_proxy = EventProxy {
        session_id: id,
        render_coordinator,
        pty_write_tx,
        app: app.clone(),
        title: title.clone(),
        workspace_path: Some(cwd.display().to_string()),
        worktree_path: worktree_path.clone(),
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
    let shell = if adapter_active {
        // Adapter mode: run a keepalive child that disables terminal echo
        // and cats its stdin to stdout. The adapter writes synthesized
        // OSC 7770 bytes into the PTY master, cat relays them to the
        // slave's stdout, and `ProtocolReader` parses them back out.
        Some(tty::Shell::new(
            "/bin/sh".to_string(),
            vec!["-c".to_string(), "stty -echo; exec cat".to_string()],
        ))
    } else {
        command.map(|c| tty::Shell::new(c.program, c.args))
    };
    let mut env = env;
    let cwd_display = cwd.display().to_string();
    env.insert("PWD".to_string(), cwd_display.clone());
    env.insert("LASTTY_SESSION_ID".to_string(), id.to_string());
    if let Some(agent_id) = agent_id.as_ref() {
        env.insert("LASTTY_AGENT_ID".to_string(), agent_id.clone());
    }
    if let Some(socket_path) = control_socket_path.as_ref() {
        env.insert(
            "PANE_CONTROL_SOCKET".to_string(),
            socket_path.to_string_lossy().to_string(),
        );
    }
    let pty_config = tty::Options {
        shell,
        working_directory: Some(cwd),
        env,
        ..Default::default()
    };

    let window_size = WindowSize {
        num_cols: cols,
        num_lines: rows,
        cell_width: 8,
        cell_height: 16,
    };
    let pty = tty::new(&pty_config, window_size, id.as_u64())?;
    let adapter_sink = if adapter_active {
        Some(pty.file().try_clone()?)
    } else {
        None
    };
    let pty = InterceptingPty::new(pty, app.clone(), id, cwd_shared.clone())?;

    #[cfg(unix)]
    if let Some(socket_path) = control_socket_path.clone() {
        let listener = std::os::unix::net::UnixListener::bind(&socket_path)?;
        listener.set_nonblocking(true)?;
        let control_stream = control_stream.clone();
        let control_connected = control_connected.clone();
        let control_accept_alive = control_accept_alive.clone();
        let socket_app = app.clone();
        let socket_session_id = id;
        thread::spawn(move || {
            while control_accept_alive.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        let _ = stream.set_nonblocking(false);
                        control_connected.store(true, Ordering::Relaxed);
                        if let Ok(reader_stream) = stream.try_clone() {
                            let reader_app = socket_app.clone();
                            thread::spawn(move || {
                                pump_control_socket(reader_stream, reader_app, socket_session_id);
                            });
                        }
                        *control_stream.lock().unwrap() = Some(stream);
                        break;
                    }
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                        thread::sleep(std::time::Duration::from_millis(50));
                    }
                    Err(_) => break,
                }
            }
            let _ = fs::remove_file(&socket_path);
        });
    }

    // 3. Start event loop (PTY I/O thread)
    let event_loop = EventLoop::new(Arc::clone(&term), event_proxy, pty, false, false)?;
    let event_tx = event_loop.channel();
    let handle = event_loop.spawn();

    // 4. Spawn PtyWrite forwarder: reads DSR responses and sends them to PTY
    let pty_event_tx = event_tx.clone();
    thread::spawn(move || {
        while let Ok(text) = pty_write_rx.recv() {
            let _ = pty_event_tx.send(Msg::Input(Cow::Owned(text.into_bytes())));
        }
    });

    // 5. If an adapter is attached, spawn the real CLI process and pump
    //    its output through the PTY master.
    if let (Some(adapter), Some(sink)) = (adapter, adapter_sink) {
        if let Err(error) = runner::spawn_adapter(adapter, sink) {
            tracing::warn!(
                session_id = %id,
                %error,
                "failed to spawn adapter; session will run with an inert keepalive child"
            );
        }
    }

    Ok(TerminalSession {
        id,
        term,
        event_tx,
        _event_loop_handle: handle,
        status: SessionStatus::Running,
        started_at: Instant::now(),
        started_at_unix_ms: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis())
            .unwrap_or_default(),
        title,
        agent_id,
        cwd: cwd_shared,
        prompt,
        prompt_summary,
        worktree_path,
        attention_menu_active: Arc::new(AtomicBool::new(false)),
        control_socket_path,
        control_connected,
        #[cfg(unix)]
        control_stream,
        control_accept_alive,
    })
}

/// Reads newline-delimited `PeerMessage` JSON from the agent's control socket
/// and routes each message through the `PeerRouter`. Runs until the connection
/// closes or an unrecoverable read error occurs.
#[cfg(unix)]
fn pump_control_socket<R: Runtime>(
    stream: std::os::unix::net::UnixStream,
    app: tauri::AppHandle<R>,
    session_id: SessionId,
) {
    use std::io::BufRead;
    let reader = io::BufReader::new(stream);
    for line in reader.lines() {
        let Ok(line) = line else { break };
        let line = line.trim().to_string();
        if line.is_empty() {
            continue;
        }
        match serde_json::from_str::<PeerMessage>(&line) {
            Ok(msg) => {
                if let Some(router) = app.try_state::<std::sync::Arc<crate::peer::PeerRouter<R>>>()
                {
                    router.ingest_from_session(&session_id, msg);
                }
            }
            Err(error) => {
                tracing::debug!(%error, "control socket: malformed peer message, skipping line");
            }
        }
    }
}

impl<R: Runtime> TerminalSession<R> {
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
        self.control_accept_alive.store(false, Ordering::Relaxed);
        if let Some(socket_path) = self.control_socket_path.as_ref() {
            let _ = fs::remove_file(socket_path);
        }
        let _ = self.event_tx.send(Msg::Shutdown);
    }

    pub fn send_control_message(&self, message: &str) -> Result<(), String> {
        #[cfg(unix)]
        {
            let mut guard = self.control_stream.lock().unwrap();
            let Some(stream) = guard.as_mut() else {
                return Err("agent control socket not connected".to_string());
            };
            stream
                .write_all(message.as_bytes())
                .and_then(|_| stream.write_all(b"\n"))
                .map_err(|error| error.to_string())
        }
        #[cfg(not(unix))]
        {
            let _ = message;
            Err("control socket unsupported on this platform".to_string())
        }
    }

    pub fn info(&self) -> SessionInfo {
        SessionInfo {
            session_id: self.id.to_string(),
            title: self.title.lock().unwrap().clone(),
            agent_id: self.agent_id.clone(),
            cwd: self.cwd.lock().unwrap().clone(),
            prompt: self.prompt.clone(),
            prompt_summary: self.prompt_summary.clone(),
            worktree_path: self.worktree_path.clone(),
            control_connected: self.control_connected.load(Ordering::Relaxed),
            started_at_ms: self.started_at_unix_ms,
            started_at_unix_ms: self.started_at_unix_ms,
        }
    }
}

struct InterceptingPty<R: Runtime = tauri::Wry> {
    inner: tty::Pty,
    reader: ProtocolReader<R>,
    writer: File,
}

impl<R: Runtime> InterceptingPty<R> {
    fn new(
        inner: tty::Pty,
        app: tauri::AppHandle<R>,
        session_id: SessionId,
        cwd: Arc<Mutex<String>>,
    ) -> io::Result<Self> {
        let reader = ProtocolReader::new(inner.file().try_clone()?, app, session_id, cwd);
        let writer = inner.file().try_clone()?;
        Ok(Self {
            inner,
            reader,
            writer,
        })
    }
}

impl<R: Runtime> tty::EventedReadWrite for InterceptingPty<R> {
    type Reader = ProtocolReader<R>;
    type Writer = File;

    unsafe fn register(
        &mut self,
        poll: &Arc<polling::Poller>,
        interest: polling::Event,
        poll_opts: polling::PollMode,
    ) -> io::Result<()> {
        unsafe { self.inner.register(poll, interest, poll_opts) }
    }

    fn reregister(
        &mut self,
        poll: &Arc<polling::Poller>,
        interest: polling::Event,
        poll_opts: polling::PollMode,
    ) -> io::Result<()> {
        self.inner.reregister(poll, interest, poll_opts)
    }

    fn deregister(&mut self, poll: &Arc<polling::Poller>) -> io::Result<()> {
        self.inner.deregister(poll)
    }

    fn reader(&mut self) -> &mut Self::Reader {
        &mut self.reader
    }

    fn writer(&mut self) -> &mut Self::Writer {
        &mut self.writer
    }
}

impl<R: Runtime> tty::EventedPty for InterceptingPty<R> {
    fn next_child_event(&mut self) -> Option<tty::ChildEvent> {
        self.inner.next_child_event()
    }
}

impl<R: Runtime> alacritty_terminal::event::OnResize for InterceptingPty<R> {
    fn on_resize(&mut self, window_size: WindowSize) {
        self.inner.on_resize(window_size);
    }
}

struct ProtocolReader<R: Runtime = tauri::Wry> {
    source: File,
    parser: OscParser,
    osc7: Osc7Scanner,
    cwd: Arc<Mutex<String>>,
    pending_terminal: std::collections::VecDeque<u8>,
    app: tauri::AppHandle<R>,
    session_id: SessionId,
}

impl<R: Runtime> ProtocolReader<R> {
    fn new(
        source: File,
        app: tauri::AppHandle<R>,
        session_id: SessionId,
        cwd: Arc<Mutex<String>>,
    ) -> Self {
        Self {
            source,
            parser: OscParser::new(),
            osc7: Osc7Scanner::new(),
            cwd,
            pending_terminal: std::collections::VecDeque::new(),
            app,
            session_id,
        }
    }

    fn drain_pending(&mut self, buf: &mut [u8]) -> usize {
        let count = buf.len().min(self.pending_terminal.len());
        for slot in buf.iter_mut().take(count) {
            *slot = self.pending_terminal.pop_front().unwrap_or_default();
        }
        count
    }

    fn update_cwd(&self, new_cwd: String) {
        {
            let mut guard = self.cwd.lock().unwrap();
            if *guard == new_cwd {
                return;
            }
            *guard = new_cwd.clone();
        }
        self.app
            .state::<EventBus<R>>()
            .publish(BusEvent::SessionCwdChanged {
                session_id: self.session_id.to_string(),
                cwd: new_cwd,
            });
    }

    fn handle_chunks(&mut self, chunks: Vec<ParsedChunk>) {
        for chunk in chunks {
            match chunk {
                ParsedChunk::TerminalData(bytes) | ParsedChunk::MalformedOsc(bytes) => {
                    self.app
                        .state::<EventBus<R>>()
                        .publish(BusEvent::PtyOutput {
                            session_id: self.session_id.to_string(),
                            bytes: bytes.clone(),
                        });
                    self.pending_terminal.extend(bytes);
                }
                ParsedChunk::AgentMessage(message) => {
                    emit_agent_ui(&self.app, self.session_id, message);
                }
            }
        }
    }
}

impl<R: Runtime> Read for ProtocolReader<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if !self.pending_terminal.is_empty() {
            return Ok(self.drain_pending(buf));
        }

        let mut raw = vec![0u8; buf.len().max(4096)];
        match self.source.read(&mut raw) {
            Ok(0) => Ok(0),
            Ok(read) => {
                for new_cwd in self.osc7.feed(&raw[..read]) {
                    self.update_cwd(new_cwd);
                }
                let chunks = self.parser.feed(&raw[..read]);
                self.handle_chunks(chunks);
                if !self.pending_terminal.is_empty() {
                    return Ok(self.drain_pending(buf));
                }
                // All bytes were OSC agent messages — no terminal data to return.
                // Signal WouldBlock so the EventLoop can process queued Msg::Input
                // before we re-enter the PTY read. Avoids blocking on macOS where
                // the cloned PTY fd may not return EAGAIN despite O_NONBLOCK.
                Err(io::Error::from(io::ErrorKind::WouldBlock))
            }
            Err(error) => Err(error),
        }
    }
}

fn emit_agent_ui<R: Runtime>(
    app: &tauri::AppHandle<R>,
    session_id: SessionId,
    message: AgentUiMessage,
) {
    let session_id_text = session_id.to_string();
    let agent_id = app
        .try_state::<crate::terminal::manager::TerminalManager<R>>()
        .and_then(|manager| {
            manager
                .get(&session_id)
                .and_then(|session| session.agent_id.clone())
        });
    let bus_event = match &message {
        AgentUiMessage::Status { phase, detail } => Some(BusEvent::AgentStatus {
            session_id: session_id_text.clone(),
            agent_id: agent_id.clone(),
            phase: phase.clone(),
            detail: detail.clone(),
        }),
        AgentUiMessage::ToolCall { name, args, .. } => Some(BusEvent::AgentToolCall {
            session_id: session_id_text.clone(),
            agent_id: agent_id.clone(),
            tool: name.clone(),
            args: args.clone(),
        }),
        AgentUiMessage::FileEdit { path, .. }
        | AgentUiMessage::FileCreate { path }
        | AgentUiMessage::FileDelete { path } => Some(BusEvent::AgentFileEdit {
            session_id: session_id_text.clone(),
            agent_id: agent_id.clone(),
            path: path.clone(),
        }),
        AgentUiMessage::Finished { summary, exit_code } => Some(BusEvent::AgentFinished {
            session_id: session_id_text.clone(),
            agent_id,
            summary: summary.clone(),
            exit_code: *exit_code,
        }),
        AgentUiMessage::Peer(peer_msg) => {
            if let Some(router) = app.try_state::<std::sync::Arc<crate::peer::PeerRouter<R>>>() {
                router.ingest_from_session(&session_id, peer_msg.clone());
            }
            // Peer messages ride their own BusEvent channel and frontend store.
            // Skip the agent:ui emit so reducers that don't know about Peer
            // don't clobber per-session agent state.
            return;
        }
        _ => None,
    };
    let message_value = serde_json::to_value(&message).unwrap_or(serde_json::Value::Null);
    let payload = AgentUiEvent {
        session_id: session_id_text.clone(),
        message: message_value.clone(),
    };
    let _ = app.emit("agent:ui", payload);
    app.state::<EventBus<R>>()
        .record_agent_ui_message(&session_id_text, &message_value);
    if let Some(bus_event) = bus_event {
        app.state::<EventBus<R>>().publish(bus_event);
    }
}
