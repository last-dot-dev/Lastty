use std::env;
use std::fs::File;
use std::io::{self, IsTerminal, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use crossterm::event::{
    self, Event as CrosstermEvent, KeyCode, KeyEvent, KeyEventKind, KeyModifiers,
};
use crossterm::execute;
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use pane_protocol::{AgentUiMessage, OscParser, ParsedChunk};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use ratatui::prelude::*;
use ratatui::widgets::{Block, Borders, Paragraph, Wrap};
use serde::Serialize;

const DEFAULT_COLS: u16 = 120;
const DEFAULT_ROWS: u16 = 32;
const SIDEBAR_WIDTH: u16 = 36;
const MAX_TERMINAL_CHARS: usize = 200_000;

#[derive(Debug, Clone, PartialEq, Eq)]
enum Mode {
    Tui,
    DumpJson(PathBuf),
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CliArgs {
    cols: u16,
    rows: u16,
    cwd: Option<PathBuf>,
    timeout: Option<Duration>,
    mode: Mode,
    command: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
struct ExitSummary {
    success: bool,
    code: u32,
    signal: Option<String>,
    timed_out: bool,
}

#[derive(Debug, Clone, Serialize)]
struct CaptureReport {
    command: Vec<String>,
    cwd: String,
    cols: u16,
    rows: u16,
    terminal_bytes: usize,
    malformed_osc_count: usize,
    terminal_output: String,
    agent_messages: Vec<AgentUiMessage>,
    exit: ExitSummary,
}

#[derive(Debug)]
enum PtyEvent {
    Terminal(Vec<u8>),
    Agent(AgentUiMessage),
    Malformed(Vec<u8>),
    ReaderError(String),
    ReaderDone,
}

#[derive(Default)]
struct SessionState {
    terminal_output: String,
    terminal_bytes: usize,
    malformed_osc_count: usize,
    agent_messages: Vec<AgentUiMessage>,
    reader_error: Option<String>,
}

impl SessionState {
    fn apply_terminal(&mut self, data: &[u8]) {
        self.terminal_bytes += data.len();
        let sanitized = sanitize_terminal_bytes(data);
        if sanitized.is_empty() {
            return;
        }
        self.terminal_output.push_str(&sanitized);
        trim_front(&mut self.terminal_output, MAX_TERMINAL_CHARS);
    }

    fn apply_agent(&mut self, message: AgentUiMessage) {
        self.agent_messages.push(message);
    }

    fn apply_event(&mut self, event: PtyEvent) {
        match event {
            PtyEvent::Terminal(data) => {
                self.apply_terminal(&data);
            }
            PtyEvent::Malformed(data) => {
                self.malformed_osc_count += 1;
                self.apply_terminal(&data);
            }
            PtyEvent::Agent(message) => self.apply_agent(message),
            PtyEvent::ReaderError(error) => {
                self.reader_error = Some(error);
            }
            PtyEvent::ReaderDone => {}
        }
    }
}

struct RunningSession {
    master: Box<dyn portable_pty::MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    events: Receiver<PtyEvent>,
}

struct TerminalUi {
    terminal: ratatui::Terminal<CrosstermBackend<std::io::Stdout>>,
}

impl TerminalUi {
    fn enter() -> Result<Self> {
        enable_raw_mode().context("enable raw mode")?;
        let mut stdout = io::stdout();
        execute!(stdout, EnterAlternateScreen).context("enter alternate screen")?;
        let backend = CrosstermBackend::new(stdout);
        let mut terminal = ratatui::Terminal::new(backend).context("create ratatui terminal")?;
        terminal.clear().context("clear ratatui terminal")?;
        Ok(Self { terminal })
    }
}

impl Drop for TerminalUi {
    fn drop(&mut self) {
        let _ = disable_raw_mode();
        let _ = execute!(self.terminal.backend_mut(), LeaveAlternateScreen);
        let _ = self.terminal.show_cursor();
    }
}

fn main() -> Result<()> {
    let parsed = parse_args(env::args())?;
    if parsed == CliParse::Help {
        print_help();
        return Ok(());
    }

    let args = parsed.expect_run();
    match &args.mode {
        Mode::DumpJson(path) => run_dump_mode(&args, path),
        Mode::Tui => run_tui_mode(&args),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum CliParse {
    Help,
    Run(CliArgs),
}

impl CliParse {
    fn expect_run(self) -> CliArgs {
        match self {
            Self::Run(args) => args,
            Self::Help => unreachable!("help path handled in main"),
        }
    }
}

fn parse_args<I>(args: I) -> Result<CliParse>
where
    I: IntoIterator<Item = String>,
{
    let mut iter = args.into_iter();
    let _program = iter.next();
    let mut cols = DEFAULT_COLS;
    let mut rows = DEFAULT_ROWS;
    let mut cwd = None;
    let mut timeout = None;
    let mut mode = Mode::Tui;
    let mut command = Vec::new();
    let mut after_separator = false;

    while let Some(arg) = iter.next() {
        if !after_separator {
            match arg.as_str() {
                "-h" | "--help" => return Ok(CliParse::Help),
                "--" => {
                    after_separator = true;
                    continue;
                }
                "--cols" => {
                    cols = parse_u16_flag("--cols", iter.next())?;
                    continue;
                }
                "--rows" => {
                    rows = parse_u16_flag("--rows", iter.next())?;
                    continue;
                }
                "--cwd" => {
                    cwd = Some(PathBuf::from(
                        iter.next()
                            .ok_or_else(|| anyhow!("missing value for --cwd"))?,
                    ));
                    continue;
                }
                "--timeout-ms" => {
                    let millis = parse_u64_flag("--timeout-ms", iter.next())?;
                    timeout = Some(Duration::from_millis(millis));
                    continue;
                }
                "--dump-json" => {
                    mode = Mode::DumpJson(PathBuf::from(
                        iter.next()
                            .ok_or_else(|| anyhow!("missing value for --dump-json"))?,
                    ));
                    continue;
                }
                _ if arg.starts_with('-') => bail!("unknown flag: {arg}"),
                _ => {}
            }
        }

        command.push(arg);
        command.extend(iter);
        break;
    }

    if command.is_empty() {
        command.push(default_shell());
    }

    Ok(CliParse::Run(CliArgs {
        cols,
        rows,
        cwd,
        timeout,
        mode,
        command,
    }))
}

fn parse_u16_flag(name: &str, value: Option<String>) -> Result<u16> {
    value
        .ok_or_else(|| anyhow!("missing value for {name}"))?
        .parse::<u16>()
        .with_context(|| format!("invalid value for {name}"))
}

fn parse_u64_flag(name: &str, value: Option<String>) -> Result<u64> {
    value
        .ok_or_else(|| anyhow!("missing value for {name}"))?
        .parse::<u64>()
        .with_context(|| format!("invalid value for {name}"))
}

fn default_shell() -> String {
    env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string())
}

fn print_help() {
    println!(
        "\
pane_cli: validate OSC 7770 agent UI traffic over a real PTY

Usage:
  cargo run -p lastty --bin pane_cli -- [flags] [--] [command...]

Flags:
  --cols <n>         Initial PTY columns (default: {DEFAULT_COLS})
  --rows <n>         Initial PTY rows (default: {DEFAULT_ROWS})
  --cwd <path>       Working directory for the spawned command
  --dump-json <path> Run headless and write a JSON capture report
  --timeout-ms <n>   Kill the child if it exceeds the timeout
  -h, --help         Show this help text

Interactive mode:
  The default mode launches a ratatui split view. Use Ctrl-Q to quit.
  Most keys are forwarded to the child PTY so you can interact with a shell.
"
    );
}

fn run_dump_mode(args: &CliArgs, output_path: &Path) -> Result<()> {
    let report = capture_session(args)?;
    if let Some(parent) = output_path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("create {}", parent.display()))?;
        }
    }
    let file =
        File::create(output_path).with_context(|| format!("create {}", output_path.display()))?;
    serde_json::to_writer_pretty(file, &report)
        .with_context(|| format!("write {}", output_path.display()))?;
    println!("{}", output_path.display());
    Ok(())
}

fn run_tui_mode(args: &CliArgs) -> Result<()> {
    if !io::stdout().is_terminal() {
        bail!("interactive mode requires a TTY; use --dump-json for headless verification");
    }

    let mut session = spawn_session(args)?;
    let mut ui = TerminalUi::enter()?;
    let mut state = SessionState::default();
    let mut exit: Option<ExitSummary> = None;
    let started_at = Instant::now();
    resize_pty_for_screen(&session.master)?;

    loop {
        drain_events(&session.events, &mut state);

        if exit.is_none() {
            if let Some(status) = session.child.try_wait().context("poll child status")? {
                exit = Some(exit_summary(status, false));
            } else if let Some(timeout) = args.timeout {
                if started_at.elapsed() >= timeout {
                    session.child.kill().context("kill timed out child")?;
                    let status = session.child.wait().context("wait for timed out child")?;
                    exit = Some(exit_summary(status, true));
                }
            }
        }

        ui.terminal
            .draw(|frame| draw_ui(frame, &state, &args.command, exit.as_ref()))
            .context("draw pane_cli UI")?;

        if event::poll(Duration::from_millis(33)).context("poll terminal events")? {
            match event::read().context("read terminal event")? {
                CrosstermEvent::Key(key)
                    if matches!(key.kind, KeyEventKind::Press | KeyEventKind::Repeat) =>
                {
                    if key.modifiers.contains(KeyModifiers::CONTROL)
                        && matches!(key.code, KeyCode::Char('q') | KeyCode::Char('Q'))
                    {
                        if exit.is_none() {
                            let _ = session.child.kill();
                        }
                        break;
                    }
                    if let Some(input) = key_to_pty_bytes(key) {
                        session
                            .writer
                            .write_all(&input)
                            .context("write keyboard input to PTY")?;
                        session.writer.flush().context("flush PTY input")?;
                    }
                }
                CrosstermEvent::Resize(_, _) => {
                    resize_pty_for_screen(&session.master)?;
                }
                _ => {}
            }
        }
    }

    Ok(())
}

fn capture_session(args: &CliArgs) -> Result<CaptureReport> {
    let mut session = spawn_session(args)?;
    let mut state = SessionState::default();
    let started_at = Instant::now();
    let mut reader_done = false;
    let exit = loop {
        match session.events.recv_timeout(Duration::from_millis(25)) {
            Ok(PtyEvent::ReaderDone) => {
                reader_done = true;
            }
            Ok(event) => state.apply_event(event),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                reader_done = true;
            }
        }

        if let Some(timeout) = args.timeout {
            if started_at.elapsed() >= timeout {
                session.child.kill().context("kill timed out child")?;
                let status = session.child.wait().context("wait for timed out child")?;
                break exit_summary(status, true);
            }
        }

        if let Some(status) = session.child.try_wait().context("poll child status")? {
            while let Ok(event) = session.events.try_recv() {
                if matches!(event, PtyEvent::ReaderDone) {
                    reader_done = true;
                    continue;
                }
                state.apply_event(event);
            }
            if !reader_done {
                loop {
                    match session.events.recv_timeout(Duration::from_millis(25)) {
                        Ok(PtyEvent::ReaderDone) => {
                            break;
                        }
                        Ok(event) => state.apply_event(event),
                        Err(mpsc::RecvTimeoutError::Timeout) => continue,
                        Err(mpsc::RecvTimeoutError::Disconnected) => {
                            break;
                        }
                    }
                }
            }
            break exit_summary(status, false);
        }
    };

    if let Some(error) = state.reader_error.take() {
        bail!("PTY reader error: {error}");
    }

    Ok(CaptureReport {
        command: args.command.clone(),
        cwd: resolve_cwd(args.cwd.as_deref())?.display().to_string(),
        cols: args.cols,
        rows: args.rows,
        terminal_bytes: state.terminal_bytes,
        malformed_osc_count: state.malformed_osc_count,
        terminal_output: state.terminal_output,
        agent_messages: state.agent_messages,
        exit,
    })
}

fn spawn_session(args: &CliArgs) -> Result<RunningSession> {
    let pty_system = native_pty_system();
    let pty_pair = pty_system
        .openpty(PtySize {
            rows: args.rows,
            cols: args.cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .context("open PTY")?;

    let mut command = CommandBuilder::new(&args.command[0]);
    if args.command.len() > 1 {
        command.args(&args.command[1..]);
    }
    if let Some(cwd) = args.cwd.as_deref() {
        command.cwd(cwd);
    }
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    command.env("LASTTY_VALIDATOR", "1");

    let child = pty_pair
        .slave
        .spawn_command(command)
        .with_context(|| format!("spawn {}", shell_words(&args.command)))?;
    let writer = pty_pair.master.take_writer().context("open PTY writer")?;
    let reader = pty_pair
        .master
        .try_clone_reader()
        .context("open PTY reader")?;
    let events = spawn_reader(reader);

    Ok(RunningSession {
        master: pty_pair.master,
        writer,
        child,
        events,
    })
}

fn spawn_reader(mut reader: Box<dyn Read + Send>) -> Receiver<PtyEvent> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut parser = OscParser::new();
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => {
                    let _ = tx.send(PtyEvent::ReaderDone);
                    break;
                }
                Ok(n) => {
                    for chunk in parser.feed(&buf[..n]) {
                        let event = match chunk {
                            ParsedChunk::TerminalData(data) => PtyEvent::Terminal(data),
                            ParsedChunk::AgentMessage(message) => PtyEvent::Agent(message),
                            ParsedChunk::MalformedOsc(data) => PtyEvent::Malformed(data),
                        };
                        if tx.send(event).is_err() {
                            return;
                        }
                    }
                }
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error) => {
                    let _ = tx.send(PtyEvent::ReaderError(error.to_string()));
                    break;
                }
            }
        }
    });
    rx
}

fn draw_ui(
    frame: &mut Frame,
    state: &SessionState,
    command: &[String],
    exit: Option<&ExitSummary>,
) {
    let areas = Layout::horizontal([Constraint::Min(20), Constraint::Length(SIDEBAR_WIDTH)])
        .split(frame.area());
    let terminal_text =
        Paragraph::new(tail_lines(&state.terminal_output, areas[0].height as usize))
            .block(
                Block::default()
                    .borders(Borders::ALL)
                    .title(format!(" Terminal | {} ", shell_words(command))),
            )
            .wrap(Wrap { trim: false });
    frame.render_widget(terminal_text, areas[0]);

    let status_text = sidebar_text(state, exit, areas[1].height as usize);
    let sidebar = Paragraph::new(status_text)
        .block(Block::default().borders(Borders::ALL).title(" Agent UI "))
        .wrap(Wrap { trim: false });
    frame.render_widget(sidebar, areas[1]);
}

fn sidebar_text(state: &SessionState, exit: Option<&ExitSummary>, max_height: usize) -> String {
    let mut sections = Vec::new();

    sections.push(match exit {
        Some(exit) => format!(
            "Exit: {} (code {}){}",
            if exit.success { "success" } else { "failure" },
            exit.code,
            match (&exit.signal, exit.timed_out) {
                (Some(signal), true) => format!(", signal {signal}, timed out"),
                (Some(signal), false) => format!(", signal {signal}"),
                (None, true) => ", timed out".to_string(),
                (None, false) => String::new(),
            }
        ),
        None => "Exit: running".to_string(),
    });

    sections.push(format!("Malformed OSC: {}", state.malformed_osc_count));

    let rendered_messages = state
        .agent_messages
        .iter()
        .rev()
        .take(max_height.saturating_sub(4) / 4)
        .collect::<Vec<_>>();

    if rendered_messages.is_empty() {
        sections.push("No agent messages yet.".to_string());
    } else {
        sections.extend(
            rendered_messages
                .into_iter()
                .rev()
                .map(format_agent_message),
        );
    }

    sections.join("\n\n")
}

fn format_agent_message(message: &AgentUiMessage) -> String {
    match message {
        AgentUiMessage::Ready { agent, version } => match version {
            Some(version) => format!("Ready\nagent: {agent}\nversion: {version}"),
            None => format!("Ready\nagent: {agent}"),
        },
        AgentUiMessage::Status { phase, detail } => match detail {
            Some(detail) => format!("Status\nphase: {phase}\ndetail: {detail}"),
            None => format!("Status\nphase: {phase}"),
        },
        AgentUiMessage::Progress { pct, message } => {
            format!("Progress\npct: {pct}\nmessage: {message}")
        }
        AgentUiMessage::Finished { summary, exit_code } => match exit_code {
            Some(exit_code) => format!("Finished\nexit: {exit_code}\nsummary: {summary}"),
            None => format!("Finished\nsummary: {summary}"),
        },
        AgentUiMessage::ToolCall {
            id,
            name,
            args,
            parent_id,
        } => {
            let mut body = format!(
                "Tool Call\nid: {id}\n{name} {}",
                truncate_text(&json_value_text(args), 120)
            );
            if let Some(parent) = parent_id {
                body.push_str(&format!("\nparent: {parent}"));
            }
            body
        }
        AgentUiMessage::ToolResult {
            id,
            result,
            error,
            parent_id,
        } => {
            let mut body = format!(
                "Tool Result\nid: {id}\n{}",
                truncate_text(&json_value_text(result), 120)
            );
            if let Some(error) = error {
                body.push_str(&format!("\nerror: {error}"));
            }
            if let Some(parent) = parent_id {
                body.push_str(&format!("\nparent: {parent}"));
            }
            body
        }
        AgentUiMessage::FileEdit { path, diff } => match diff {
            Some(diff) => format!("File Edit\npath: {path}\n{}", truncate_text(diff, 120)),
            None => format!("File Edit\npath: {path}"),
        },
        AgentUiMessage::FileCreate { path } => format!("File Create\npath: {path}"),
        AgentUiMessage::FileDelete { path } => format!("File Delete\npath: {path}"),
        AgentUiMessage::Approval {
            id,
            message,
            options,
        } => format!(
            "Approval\nid: {id}\n{}\noptions: {}",
            truncate_text(message, 120),
            options.join(", ")
        ),
        AgentUiMessage::Notification { level, message } => format!(
            "Notification\nlevel: {level}\n{}",
            truncate_text(message, 120)
        ),
        AgentUiMessage::Widget { widget_type, props } => format!(
            "Widget\ntype: {widget_type}\n{}",
            truncate_text(&json_value_text(props), 120)
        ),
    }
}

fn json_value_text(value: &serde_json::Value) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "<invalid json>".to_string())
}

fn truncate_text(text: &str, max_chars: usize) -> String {
    let truncated = text.chars().take(max_chars).collect::<String>();
    if text.chars().count() > max_chars {
        format!("{truncated}...")
    } else {
        truncated
    }
}

fn tail_lines(text: &str, max_lines: usize) -> String {
    if max_lines == 0 {
        return String::new();
    }
    let mut lines = text.lines().collect::<Vec<_>>();
    if lines.len() > max_lines.saturating_sub(2) {
        let keep = max_lines.saturating_sub(2);
        lines = lines.split_off(lines.len() - keep);
    }
    if text.ends_with('\n') {
        lines.push("");
    }
    lines.join("\n")
}

fn shell_words(command: &[String]) -> String {
    command
        .iter()
        .map(|part| {
            if part.contains(' ') {
                format!("{part:?}")
            } else {
                part.clone()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn resolve_cwd(cwd: Option<&Path>) -> Result<PathBuf> {
    match cwd {
        Some(path) => Ok(path
            .canonicalize()
            .with_context(|| format!("resolve {}", path.display()))?),
        None => Ok(env::current_dir().context("resolve current directory")?),
    }
}

fn resize_pty_for_screen(master: &Box<dyn portable_pty::MasterPty + Send>) -> Result<()> {
    let (width, height) = crossterm::terminal::size().context("read terminal size")?;
    let pty_size = pty_size_for_window(width, height);
    master.resize(pty_size).context("resize PTY")?;
    Ok(())
}

fn pty_size_for_window(width: u16, height: u16) -> PtySize {
    let areas = Layout::horizontal([Constraint::Min(20), Constraint::Length(SIDEBAR_WIDTH)])
        .split(Rect::new(0, 0, width.max(1), height.max(1)));
    let inner = areas[0].inner(Margin {
        vertical: 1,
        horizontal: 1,
    });
    PtySize {
        rows: inner.height.max(1),
        cols: inner.width.max(1),
        pixel_width: 0,
        pixel_height: 0,
    }
}

fn sanitize_terminal_bytes(bytes: &[u8]) -> String {
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            0x1b => {
                i += 1;
                if i >= bytes.len() {
                    break;
                }
                match bytes[i] {
                    b'[' => {
                        i += 1;
                        while i < bytes.len() {
                            let byte = bytes[i];
                            i += 1;
                            if (0x40..=0x7e).contains(&byte) {
                                break;
                            }
                        }
                    }
                    b']' => {
                        i += 1;
                        while i < bytes.len() {
                            if bytes[i] == 0x07 {
                                i += 1;
                                break;
                            }
                            if bytes[i] == 0x1b && bytes.get(i + 1) == Some(&b'\\') {
                                i += 2;
                                break;
                            }
                            i += 1;
                        }
                    }
                    _ => {
                        i += 1;
                    }
                }
            }
            b'\r' => {
                if bytes.get(i + 1) == Some(&b'\n') {
                    i += 1;
                    continue;
                }
                if out.last() != Some(&b'\n') {
                    out.push(b'\n');
                }
                i += 1;
            }
            b'\n' | b'\t' => {
                out.push(bytes[i]);
                i += 1;
            }
            byte if byte.is_ascii_control() => {
                i += 1;
            }
            _ => {
                out.push(bytes[i]);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn trim_front(text: &mut String, max_len: usize) {
    if text.len() <= max_len {
        return;
    }
    let overflow = text.len() - max_len;
    let cut = text
        .char_indices()
        .find_map(|(idx, _)| (idx >= overflow).then_some(idx))
        .unwrap_or(text.len());
    text.drain(..cut);
}

fn key_to_pty_bytes(key: KeyEvent) -> Option<Vec<u8>> {
    let mut bytes = Vec::new();
    let alt = key.modifiers.contains(KeyModifiers::ALT);
    let control = key.modifiers.contains(KeyModifiers::CONTROL);

    if alt {
        bytes.push(0x1b);
    }

    let mapped = match key.code {
        KeyCode::Char(c) if control => control_char(c).map(|byte| vec![byte]),
        KeyCode::Char(c) => Some(c.to_string().into_bytes()),
        KeyCode::Enter => Some(vec![b'\r']),
        KeyCode::Tab => Some(vec![b'\t']),
        KeyCode::BackTab => Some(b"\x1b[Z".to_vec()),
        KeyCode::Backspace => Some(vec![0x7f]),
        KeyCode::Esc => Some(vec![0x1b]),
        KeyCode::Left => Some(b"\x1b[D".to_vec()),
        KeyCode::Right => Some(b"\x1b[C".to_vec()),
        KeyCode::Up => Some(b"\x1b[A".to_vec()),
        KeyCode::Down => Some(b"\x1b[B".to_vec()),
        KeyCode::Home => Some(b"\x1b[H".to_vec()),
        KeyCode::End => Some(b"\x1b[F".to_vec()),
        KeyCode::Delete => Some(b"\x1b[3~".to_vec()),
        KeyCode::Insert => Some(b"\x1b[2~".to_vec()),
        KeyCode::PageUp => Some(b"\x1b[5~".to_vec()),
        KeyCode::PageDown => Some(b"\x1b[6~".to_vec()),
        _ => None,
    }?;

    bytes.extend(mapped);
    Some(bytes)
}

fn control_char(c: char) -> Option<u8> {
    match c {
        '@' | ' ' => Some(0x00),
        'a'..='z' => Some((c as u8) - b'a' + 1),
        'A'..='Z' => Some((c as u8) - b'A' + 1),
        '[' => Some(0x1b),
        '\\' => Some(0x1c),
        ']' => Some(0x1d),
        '^' => Some(0x1e),
        '_' => Some(0x1f),
        _ => None,
    }
}

fn drain_events(events: &Receiver<PtyEvent>, state: &mut SessionState) {
    while let Ok(event) = events.try_recv() {
        if matches!(event, PtyEvent::ReaderDone) {
            continue;
        }
        state.apply_event(event);
    }
}

fn exit_summary(status: portable_pty::ExitStatus, timed_out: bool) -> ExitSummary {
    ExitSummary {
        success: status.success(),
        code: status.exit_code(),
        signal: status.signal().map(ToOwned::to_owned),
        timed_out,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn parse_dump_mode_and_separator_command() {
        let parsed = parse_args([
            "pane_cli".to_string(),
            "--cols".to_string(),
            "140".to_string(),
            "--rows".to_string(),
            "40".to_string(),
            "--dump-json".to_string(),
            "/tmp/pane-cli.json".to_string(),
            "--".to_string(),
            "python3".to_string(),
            "-c".to_string(),
            "print('ok')".to_string(),
        ])
        .unwrap();

        assert_eq!(
            parsed,
            CliParse::Run(CliArgs {
                cols: 140,
                rows: 40,
                cwd: None,
                timeout: None,
                mode: Mode::DumpJson(PathBuf::from("/tmp/pane-cli.json")),
                command: vec![
                    "python3".to_string(),
                    "-c".to_string(),
                    "print('ok')".to_string()
                ],
            })
        );
    }

    #[test]
    fn sanitize_terminal_bytes_strips_ansi_sequences() {
        let bytes = b"\x1b[31mhello\x1b[0m\r\nworld\x1b]0;title\x07";
        assert_eq!(sanitize_terminal_bytes(bytes), "hello\nworld");
    }

    #[test]
    fn capture_session_collects_terminal_output_and_agent_messages() {
        let args = CliArgs {
            cols: 80,
            rows: 24,
            cwd: None,
            timeout: Some(Duration::from_secs(5)),
            mode: Mode::DumpJson(PathBuf::from("/tmp/unused.json")),
            command: vec![
                "python3".to_string(),
                "-c".to_string(),
                r#"import sys, json
sys.stdout.write("hello from pty\n")
sys.stdout.write("\033]7770;" + json.dumps({"type":"Status","data":{"phase":"testing","detail":"capture"}}) + "\a")
sys.stdout.write("\033]7770;" + json.dumps({"type":"Notification","data":{"level":"info","message":"done"}}) + "\a")
sys.stdout.flush()
"#
                .to_string(),
            ],
        };

        let report = capture_session(&args).unwrap();

        assert!(report.exit.success);
        assert!(report.terminal_output.contains("hello from pty"));
        assert_eq!(report.malformed_osc_count, 0);
        assert_eq!(report.agent_messages.len(), 2);
        assert_eq!(
            report.agent_messages[0],
            AgentUiMessage::Status {
                phase: "testing".to_string(),
                detail: Some("capture".to_string()),
            }
        );
        assert_eq!(
            report.agent_messages[1],
            AgentUiMessage::Notification {
                level: "info".to_string(),
                message: "done".to_string(),
            }
        );
    }
}
