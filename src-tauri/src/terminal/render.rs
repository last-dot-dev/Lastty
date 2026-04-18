use std::fmt::Write as _;
use std::fs::OpenOptions;
use std::io::Write;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use alacritty_terminal::event::EventListener;
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::term::cell::Flags;
use alacritty_terminal::term::{Term, TermMode};
use alacritty_terminal::vte::ansi::{Color, NamedColor};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::render_sync::RenderCoordinator;

use super::manager::TerminalManager;
use super::session::SessionId;

const PERF_EMIT_INTERVAL: Duration = Duration::from_millis(250);

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct TerminalFrame {
    pub ansi: Vec<u8>,
    pub cursor_x: usize,
    pub cursor_y: usize,
    pub cursor_visible: bool,
    pub display_offset: usize,
    pub total_lines: usize,
    pub alternate_screen: bool,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct TerminalFrameEvent {
    pub session_id: String,
    pub frame: TerminalFrame,
}

struct FrameEmitMetrics {
    frame_ms: f64,
    ansi_bytes: usize,
}

fn emit_frame_for_session<R: Runtime>(
    app_handle: &AppHandle<R>,
    session_id: SessionId,
) -> Option<FrameEmitMetrics> {
    let manager = app_handle.state::<TerminalManager<R>>();
    let term_arc = manager.get(&session_id).map(|session| session.term.clone());
    drop(manager);

    let Some(term_arc) = term_arc else {
        return None;
    };

    let frame_start = Instant::now();
    let term = term_arc.lock();
    let frame = render_viewport(&term);
    let ansi_bytes = frame.ansi.len();
    app_handle
        .emit(
            "term:frame",
            TerminalFrameEvent {
                session_id: session_id.to_string(),
                frame,
            },
        )
        .ok()?;
    Some(FrameEmitMetrics {
        frame_ms: frame_start.elapsed().as_secs_f64() * 1000.0,
        ansi_bytes,
    })
}

pub fn spawn_frame_emitter<R: Runtime + 'static>(
    app_handle: AppHandle<R>,
    render_coordinator: Arc<RenderCoordinator>,
    initial_session_id: SessionId,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let trace_start = Instant::now();
        let mut perf_trace = OpenOptions::new()
            .create(true)
            .append(true)
            .open("/tmp/lastty-perf.jsonl")
            .ok();
        let mut avg_frame_ms = 0.0f64;
        let mut avg_ansi_bytes = 0.0f64;
        let mut frames_since_emit = 0u64;
        let mut last_perf_emit = Instant::now();
        let mut last_total_wakeups = 0u64;

        if let Some(metrics) = emit_frame_for_session(&app_handle, initial_session_id) {
            avg_frame_ms = metrics.frame_ms;
            avg_ansi_bytes = metrics.ansi_bytes as f64;
            frames_since_emit = 1;
        }
        let mut rendered_generation = render_coordinator.current_generation();

        loop {
            let dirty = render_coordinator.wait_for_next(rendered_generation);
            if let Some(metrics) = emit_frame_for_session(&app_handle, dirty.session_id) {
                rendered_generation = dirty.generation;
                avg_frame_ms = avg_frame_ms * 0.8 + metrics.frame_ms * 0.2;
                avg_ansi_bytes = avg_ansi_bytes * 0.8 + metrics.ansi_bytes as f64 * 0.2;
                frames_since_emit += 1;
                let emit_elapsed = last_perf_emit.elapsed();
                if emit_elapsed >= PERF_EMIT_INTERVAL {
                    let total_wakeups = render_coordinator.total_wakeups();
                    let wakeups_since_emit = total_wakeups.saturating_sub(last_total_wakeups);
                    let latest_generation = render_coordinator.current_generation();
                    let pending_updates = latest_generation.saturating_sub(rendered_generation);
                    let fps = frames_since_emit as f64 / emit_elapsed.as_secs_f64();
                    let payload = serde_json::json!({
                        "frame_ms": avg_frame_ms,
                        "fps": fps,
                        "ansi_bytes": avg_ansi_bytes,
                        "wakeups": wakeups_since_emit,
                        "generation": latest_generation,
                        "pending_updates": pending_updates,
                    });
                    app_handle.emit("perf:stats", payload.clone()).ok();
                    if let Some(file) = perf_trace.as_mut() {
                        let _ = writeln!(
                            file,
                            "{}",
                            serde_json::json!({
                                "ts_ms": trace_start.elapsed().as_millis(),
                                "frame_ms": avg_frame_ms,
                                "fps": fps,
                                "ansi_bytes": avg_ansi_bytes,
                                "wakeups": wakeups_since_emit,
                                "generation": latest_generation,
                                "pending_updates": pending_updates,
                            })
                        );
                    }
                    last_perf_emit = Instant::now();
                    last_total_wakeups = total_wakeups;
                    frames_since_emit = 0;
                }
            }
        }
    })
}

pub fn render_viewport<T: EventListener>(term: &Term<T>) -> TerminalFrame {
    let content = term.renderable_content();
    let num_cols = term.columns();
    let num_lines = term.screen_lines();
    let cursor = content.cursor;
    let cursor_visible = content.mode.contains(TermMode::SHOW_CURSOR);
    let display_offset = content.display_offset;
    let alternate_screen = content.mode.contains(TermMode::ALT_SCREEN);
    let total_lines = term.grid().total_lines();

    let mut out = String::with_capacity(num_cols * num_lines * 10);
    out.push_str("\x1b[H\x1b[2J");

    let mut prev_fg = Color::Named(NamedColor::Foreground);
    let mut prev_bg = Color::Named(NamedColor::Background);
    let mut prev_flags = Flags::empty();
    let mut current_line: i32 = i32::MIN;

    for indexed in content.display_iter {
        let point = indexed.point;
        let cell = indexed.cell;

        if point.line.0 != current_line {
            if current_line != i32::MIN {
                out.push_str("\r\n");
            }
            current_line = point.line.0;
        }

        if cell.flags.contains(Flags::WIDE_CHAR_SPACER)
            || cell.flags.contains(Flags::LEADING_WIDE_CHAR_SPACER)
        {
            continue;
        }

        let needs_sgr = cell.fg != prev_fg || cell.bg != prev_bg || cell.flags != prev_flags;
        if needs_sgr {
            emit_sgr(&mut out, cell.fg, cell.bg, cell.flags);
            prev_fg = cell.fg;
            prev_bg = cell.bg;
            prev_flags = cell.flags;
        }

        let c = cell.c;
        if c == '\0' || c == ' ' || c.is_ascii_control() {
            out.push(' ');
        } else {
            out.push(c);
        }

        if let Some(zerowidth) = cell.zerowidth() {
            for &zw in zerowidth {
                out.push(zw);
            }
        }
    }

    out.push_str("\x1b[0m");

    if cursor_visible && display_offset == 0 {
        out.push_str("\x1b[?25h");
        let cursor_viewport_line = cursor.point.line.0;
        if cursor_viewport_line >= 0 {
            let cy = cursor_viewport_line as usize + 1;
            let cx = cursor.point.column.0 + 1;
            let _ = write!(out, "\x1b[{};{}H", cy, cx);
        }
    } else {
        out.push_str("\x1b[?25l");
    }

    TerminalFrame {
        ansi: out.into_bytes(),
        cursor_x: cursor.point.column.0,
        cursor_y: {
            let line = cursor.point.line.0 + display_offset as i32;
            if line >= 0 {
                line as usize
            } else {
                0
            }
        },
        cursor_visible,
        display_offset,
        total_lines,
        alternate_screen,
    }
}

fn emit_sgr(out: &mut String, fg: Color, bg: Color, flags: Flags) {
    out.push_str("\x1b[0");

    if flags.contains(Flags::BOLD) {
        out.push_str(";1");
    }
    if flags.contains(Flags::DIM) {
        out.push_str(";2");
    }
    if flags.contains(Flags::ITALIC) {
        out.push_str(";3");
    }
    if flags.contains(Flags::UNDERLINE) {
        out.push_str(";4");
    }
    if flags.contains(Flags::DOUBLE_UNDERLINE) {
        out.push_str(";21");
    }
    if flags.contains(Flags::UNDERCURL) {
        out.push_str(";4:3");
    }
    if flags.contains(Flags::DOTTED_UNDERLINE) {
        out.push_str(";4:4");
    }
    if flags.contains(Flags::DASHED_UNDERLINE) {
        out.push_str(";4:5");
    }
    if flags.contains(Flags::INVERSE) {
        out.push_str(";7");
    }
    if flags.contains(Flags::HIDDEN) {
        out.push_str(";8");
    }
    if flags.contains(Flags::STRIKEOUT) {
        out.push_str(";9");
    }

    emit_color_sgr(out, fg, true);
    emit_color_sgr(out, bg, false);
    out.push('m');
}

fn emit_color_sgr(out: &mut String, color: Color, is_fg: bool) {
    match color {
        Color::Named(name) => {
            let code = match name {
                NamedColor::Black => 30,
                NamedColor::Red => 31,
                NamedColor::Green => 32,
                NamedColor::Yellow => 33,
                NamedColor::Blue => 34,
                NamedColor::Magenta => 35,
                NamedColor::Cyan => 36,
                NamedColor::White => 37,
                NamedColor::BrightBlack => 90,
                NamedColor::BrightRed => 91,
                NamedColor::BrightGreen => 92,
                NamedColor::BrightYellow => 93,
                NamedColor::BrightBlue => 94,
                NamedColor::BrightMagenta => 95,
                NamedColor::BrightCyan => 96,
                NamedColor::BrightWhite => 97,
                NamedColor::Foreground => 39,
                NamedColor::Background => 49,
                _ => {
                    if is_fg {
                        39
                    } else {
                        49
                    }
                }
            };
            let _ = write!(out, ";{code}");
        }
        Color::Indexed(idx) => {
            let prefix = if is_fg { 38 } else { 48 };
            let _ = write!(out, ";{prefix};5;{idx}");
        }
        Color::Spec(rgb) => {
            let prefix = if is_fg { 38 } else { 48 };
            let _ = write!(out, ";{prefix};2;{};{};{}", rgb.r, rgb.g, rgb.b);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::render_viewport;
    use alacritty_terminal::event::VoidListener;
    use alacritty_terminal::grid::{Dimensions, Scroll};
    use alacritty_terminal::term::{Config, Term};
    use alacritty_terminal::vte::ansi::{Processor, StdSyncHandler};

    struct TestSize {
        columns: usize,
        screen_lines: usize,
    }

    impl Dimensions for TestSize {
        fn total_lines(&self) -> usize {
            self.screen_lines
        }

        fn screen_lines(&self) -> usize {
            self.screen_lines
        }

        fn columns(&self) -> usize {
            self.columns
        }
    }

    fn term(columns: usize, screen_lines: usize) -> Term<VoidListener> {
        let size = TestSize {
            columns,
            screen_lines,
        };
        Term::new(Config::default(), &size, VoidListener)
    }

    fn apply_escape_sequence(term: &mut Term<VoidListener>, bytes: &[u8]) {
        let mut parser = Processor::<StdSyncHandler>::new();
        parser.advance(term, bytes);
    }

    fn render_text(term: &Term<VoidListener>) -> String {
        String::from_utf8(render_viewport(term).ansi).expect("frame ansi should be valid utf-8")
    }

    fn viewport_text(term: &Term<VoidListener>) -> String {
        strip_csi(&render_text(term))
    }

    fn visible_text(term: &Term<VoidListener>) -> String {
        viewport_text(term)
            .split("\r\n")
            .map(str::trim_end)
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn strip_csi(input: &str) -> String {
        let mut out = String::with_capacity(input.len());
        let mut chars = input.chars().peekable();

        while let Some(ch) = chars.next() {
            if ch == '\u{1b}' {
                if matches!(chars.peek(), Some('[')) {
                    chars.next();
                    for next in chars.by_ref() {
                        if ('@'..='~').contains(&next) {
                            break;
                        }
                    }
                }
                continue;
            }

            out.push(ch);
        }

        out
    }

    #[test]
    fn render_viewport_hides_cursor_when_show_cursor_mode_is_disabled() {
        let mut term = term(8, 4);
        apply_escape_sequence(&mut term, b"\x1b[?25l");

        let frame = render_viewport(&term);
        let ansi = String::from_utf8(frame.ansi).expect("frame ansi should be valid utf-8");

        assert!(!frame.cursor_visible);
        assert!(ansi.contains("\x1b[?25l"));
    }

    #[test]
    fn render_viewport_reports_alternate_screen_mode() {
        let mut term = term(8, 4);
        apply_escape_sequence(&mut term, b"\x1b[?1049h");

        let frame = render_viewport(&term);

        assert!(frame.alternate_screen);
    }

    #[test]
    fn render_viewport_preserves_scrollback_when_viewport_is_scrolled_up() {
        let mut term = term(8, 3);
        apply_escape_sequence(&mut term, b"1\r\n2\r\n3\r\n4\r\n5");

        term.scroll_display(Scroll::Top);

        let frame = render_viewport(&term);
        let visible = visible_text(&term);
        let ansi = String::from_utf8(frame.ansi).expect("frame ansi should be valid utf-8");

        assert_eq!(frame.display_offset, 2);
        assert!(frame.total_lines >= 5);
        assert!(visible.contains("1\n2\n3"));
        assert!(!visible.contains("5"));
        assert!(ansi.contains("\x1b[?25l"));
    }

    #[test]
    fn render_viewport_reflects_resize_that_pulls_history_back_into_view() {
        let mut term = term(8, 3);
        apply_escape_sequence(&mut term, b"1\r\n2\r\n3\r\n4");

        let before = visible_text(&term);
        assert!(before.contains("2\n3\n4"));
        assert!(!before.contains("1\n2\n3\n4"));

        term.resize(TestSize {
            columns: 8,
            screen_lines: 4,
        });

        let frame = render_viewport(&term);
        let visible = visible_text(&term);

        assert_eq!(frame.display_offset, 0);
        assert!(frame.total_lines >= 4);
        assert_eq!(frame.cursor_y, 3);
        assert!(visible.contains("1\n2\n3\n4"));
    }

    #[test]
    fn render_viewport_preserves_wide_char_cells_without_extra_spacers() {
        let mut term = term(4, 2);
        apply_escape_sequence(&mut term, "😀x".as_bytes());

        let frame = render_viewport(&term);
        let viewport = viewport_text(&term);

        assert_eq!(viewport, "😀x \r\n    ");
        assert_eq!(visible_text(&term), "😀x\n");
        assert_eq!(frame.cursor_x, 3);
        assert_eq!(frame.cursor_y, 0);
    }

    #[test]
    fn render_viewport_wraps_wide_chars_cleanly_at_line_boundaries() {
        let mut term = term(2, 2);
        apply_escape_sequence(&mut term, "A😀".as_bytes());

        let frame = render_viewport(&term);
        let viewport = viewport_text(&term);

        assert_eq!(viewport, "A\r\n😀");
        assert_eq!(visible_text(&term), "A\n😀");
        assert_eq!(frame.cursor_x, 0);
        assert_eq!(frame.cursor_y, 1);
    }

    #[test]
    fn render_viewport_preserves_combining_marks_in_cell_output() {
        let mut term = term(4, 2);
        apply_escape_sequence(&mut term, "e\u{301}x".as_bytes());

        let frame = render_viewport(&term);
        let viewport = viewport_text(&term);

        assert_eq!(viewport, "e\u{301}x  \r\n    ");
        assert_eq!(visible_text(&term), "e\u{301}x\n");
        assert_eq!(frame.cursor_x, 2);
        assert_eq!(frame.cursor_y, 0);
    }
}
