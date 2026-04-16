use std::io::{self, Read, Write};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crossterm::event::{self, Event, KeyCode, KeyEvent, KeyModifiers};
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use crossterm::ExecutableCommand;
use pane_protocol::{AgentUiMessage, OscParser, ParsedChunk};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use ratatui::layout::{Constraint, Direction, Layout};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Paragraph, Wrap};
use ratatui::Terminal;

struct AppState {
    terminal_lines: Vec<String>,
    agent_messages: Vec<String>,
    child_exited: bool,
}

fn format_agent_message(msg: &AgentUiMessage) -> Vec<String> {
    match msg {
        AgentUiMessage::Ready { agent, version } => {
            let v = version.as_deref().unwrap_or("?");
            vec![format!("✓ Ready: {} v{}", agent, v)]
        }
        AgentUiMessage::Status { phase, detail } => {
            let mut lines = vec![format!("● Status: {}", phase)];
            if let Some(d) = detail {
                lines.push(format!("  {}", d));
            }
            lines
        }
        AgentUiMessage::Progress { pct, message } => {
            let bar_width = 20;
            let filled = (bar_width * (*pct as usize)) / 100;
            let bar: String = "█".repeat(filled) + &"░".repeat(bar_width - filled);
            vec![format!("[{}] {}%", bar, pct), format!("  {}", message)]
        }
        AgentUiMessage::Finished { summary, exit_code } => {
            let code = exit_code.map_or("?".to_string(), |c| c.to_string());
            vec![format!("■ Finished (exit {}): {}", code, summary)]
        }
        AgentUiMessage::ToolCall { id, name, args } => {
            let args_str = serde_json::to_string_pretty(args).unwrap_or_default();
            let mut lines = vec![format!("⚡ Tool: {} [{}]", name, id)];
            for line in args_str.lines().take(5) {
                lines.push(format!("  {}", line));
            }
            lines
        }
        AgentUiMessage::ToolResult { id, error, .. } => {
            if let Some(e) = error {
                vec![format!("✗ Result [{}]: error: {}", id, e)]
            } else {
                vec![format!("✓ Result [{}]: ok", id)]
            }
        }
        AgentUiMessage::FileEdit { path, .. } => vec![format!("📝 Edit: {}", path)],
        AgentUiMessage::FileCreate { path } => vec![format!("📄 Create: {}", path)],
        AgentUiMessage::FileDelete { path } => vec![format!("🗑  Delete: {}", path)],
        AgentUiMessage::Approval { id, message, options } => {
            vec![format!("❓ Approval [{}]: {} {:?}", id, message, options)]
        }
        AgentUiMessage::Notification { level, message } => {
            vec![format!("[{}] {}", level.to_uppercase(), message)]
        }
        AgentUiMessage::Widget { widget_type, .. } => {
            vec![format!("⬡ Widget: {}", widget_type)]
        }
    }
}

/// Convert a crossterm key event into bytes to forward to the PTY.
fn key_to_bytes(key: &KeyEvent) -> Option<Vec<u8>> {
    let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
    match key.code {
        KeyCode::Char(c) if ctrl => {
            // Ctrl+A = 0x01, Ctrl+B = 0x02, ..., Ctrl+Z = 0x1A
            let byte = (c as u8).wrapping_sub(b'a').wrapping_add(1);
            if byte <= 26 {
                Some(vec![byte])
            } else {
                None
            }
        }
        KeyCode::Char(c) => {
            let mut buf = [0u8; 4];
            let s = c.encode_utf8(&mut buf);
            Some(s.as_bytes().to_vec())
        }
        KeyCode::Enter => Some(vec![b'\r']),
        KeyCode::Backspace => Some(vec![0x7f]),
        KeyCode::Tab => Some(vec![b'\t']),
        KeyCode::Esc => Some(vec![0x1b]),
        KeyCode::Up => Some(b"\x1b[A".to_vec()),
        KeyCode::Down => Some(b"\x1b[B".to_vec()),
        KeyCode::Right => Some(b"\x1b[C".to_vec()),
        KeyCode::Left => Some(b"\x1b[D".to_vec()),
        _ => None,
    }
}

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() {
        eprintln!("Usage: pane-cli <command> [args...]");
        eprintln!("Example: pane-cli python test_agent.py");
        std::process::exit(1);
    }

    let pty_system = native_pty_system();
    let pair = pty_system.openpty(PtySize {
        rows: 24,
        cols: 80,
        pixel_width: 0,
        pixel_height: 0,
    })?;

    let mut cmd = CommandBuilder::new(&args[0]);
    for arg in &args[1..] {
        cmd.arg(arg);
    }
    cmd.cwd(std::env::current_dir()?);

    let mut child = pair.slave.spawn_command(cmd)?;
    drop(pair.slave);

    let state = Arc::new(Mutex::new(AppState {
        terminal_lines: Vec::new(),
        agent_messages: Vec::new(),
        child_exited: false,
    }));

    // PTY reader thread.
    let reader_state = Arc::clone(&state);
    let mut reader = pair.master.try_clone_reader()?;
    let _reader_handle = std::thread::spawn(move || {
        let mut parser = OscParser::new();
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => {
                    let mut s = reader_state.lock().unwrap();
                    s.child_exited = true;
                    break;
                }
                Ok(n) => {
                    let chunks = parser.feed(&buf[..n]);
                    let mut s = reader_state.lock().unwrap();
                    for chunk in chunks {
                        match chunk {
                            ParsedChunk::TerminalData(data) => {
                                let text = String::from_utf8_lossy(&data);
                                for line in text.split('\n') {
                                    if s.terminal_lines.is_empty()
                                        || s.terminal_lines.last().map_or(false, |l| {
                                            l.ends_with('\n') || text.starts_with('\n')
                                        })
                                    {
                                        s.terminal_lines.push(line.to_string());
                                    } else if let Some(last) = s.terminal_lines.last_mut() {
                                        last.push_str(line);
                                    }
                                }
                            }
                            ParsedChunk::AgentMessage(msg) => {
                                let formatted = format_agent_message(&msg);
                                s.agent_messages.extend(formatted);
                                s.agent_messages.push(String::new());
                            }
                            ParsedChunk::MalformedOsc(data) => {
                                let text = String::from_utf8_lossy(&data);
                                s.terminal_lines
                                    .push(format!("[malformed OSC] {}", text));
                            }
                        }
                    }
                }
            }
        }
    });

    // Get writer for forwarding keystrokes to PTY.
    let mut pty_writer = pair.master.take_writer()?;

    // Set up terminal for ratatui.
    enable_raw_mode()?;
    let mut stdout = io::stdout();
    stdout.execute(EnterAlternateScreen)?;
    let backend = ratatui::backend::CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;

    let mut waiting_for_quit = false;

    // Main UI loop.
    loop {
        let (term_lines, agent_lines, exited) = {
            let s = state.lock().unwrap();
            (
                s.terminal_lines.clone(),
                s.agent_messages.clone(),
                s.child_exited,
            )
        };

        let show_exit_hint = waiting_for_quit;

        terminal.draw(|f| {
            let chunks = Layout::default()
                .direction(Direction::Horizontal)
                .constraints([Constraint::Percentage(65), Constraint::Percentage(35)])
                .split(f.area());

            // Terminal output panel.
            let title = if show_exit_hint {
                " Terminal Output (process exited — press q to quit) "
            } else {
                " Terminal Output "
            };
            let term_text: Vec<Line> = term_lines
                .iter()
                .map(|l| Line::from(l.as_str()))
                .collect();
            let term_block = Block::default()
                .title(title)
                .borders(Borders::ALL)
                .border_style(if show_exit_hint {
                    Style::default().fg(Color::Yellow)
                } else {
                    Style::default().fg(Color::DarkGray)
                });
            let term_paragraph = Paragraph::new(term_text)
                .block(term_block)
                .wrap(Wrap { trim: false })
                .scroll((
                    term_lines
                        .len()
                        .saturating_sub(chunks[0].height as usize - 2)
                        as u16,
                    0,
                ));
            f.render_widget(term_paragraph, chunks[0]);

            // Agent UI panel.
            let agent_text: Vec<Line> = agent_lines
                .iter()
                .map(|l| {
                    if l.starts_with('✓') {
                        Line::from(Span::styled(
                            l.as_str(),
                            Style::default().fg(Color::Green),
                        ))
                    } else if l.starts_with('●') {
                        Line::from(Span::styled(
                            l.as_str(),
                            Style::default().fg(Color::Cyan),
                        ))
                    } else if l.starts_with('⚡') {
                        Line::from(Span::styled(
                            l.as_str(),
                            Style::default().fg(Color::Yellow),
                        ))
                    } else if l.starts_with('✗') || l.starts_with('■') {
                        Line::from(Span::styled(
                            l.as_str(),
                            Style::default().fg(Color::Red),
                        ))
                    } else if l.starts_with('❓') {
                        Line::from(Span::styled(
                            l.as_str(),
                            Style::default()
                                .fg(Color::Magenta)
                                .add_modifier(Modifier::BOLD),
                        ))
                    } else {
                        Line::from(l.as_str())
                    }
                })
                .collect();
            let agent_block = Block::default()
                .title(" Agent UI ")
                .borders(Borders::ALL)
                .border_style(Style::default().fg(Color::Cyan));
            let agent_paragraph = Paragraph::new(agent_text)
                .block(agent_block)
                .wrap(Wrap { trim: false })
                .scroll((
                    agent_lines
                        .len()
                        .saturating_sub(chunks[1].height as usize - 2)
                        as u16,
                    0,
                ));
            f.render_widget(agent_paragraph, chunks[1]);
        })?;

        // Handle input.
        if event::poll(Duration::from_millis(50))? {
            if let Event::Key(key) = event::read()? {
                // Ctrl+C or q always quits.
                if key.code == KeyCode::Char('c')
                    && key.modifiers.contains(KeyModifiers::CONTROL)
                {
                    break;
                }
                if waiting_for_quit && key.code == KeyCode::Char('q') {
                    break;
                }

                // Forward keystrokes to the PTY while the child is alive.
                if !waiting_for_quit {
                    if let Some(bytes) = key_to_bytes(&key) {
                        let _ = pty_writer.write_all(&bytes);
                    }
                }
            }
        }

        // Once the child exits, switch to "waiting for quit" mode.
        if exited && !waiting_for_quit {
            waiting_for_quit = true;
        }
    }

    // Cleanup.
    disable_raw_mode()?;
    io::stdout().execute(LeaveAlternateScreen)?;

    let _ = child.kill();
    let _ = child.wait();

    println!("pane-cli exited.");
    Ok(())
}
