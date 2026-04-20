use std::fmt::Write as _;
use std::fs::OpenOptions;
use std::io::Write;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use alacritty_terminal::event::EventListener;
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::index::{Column, Line};
use alacritty_terminal::term::cell::Flags;
use alacritty_terminal::term::{LineDamageBounds, Term, TermDamage, TermMode};
use alacritty_terminal::vte::ansi::{Color, NamedColor};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::render_sync::RenderCoordinator;

use super::manager::TerminalManager;
use super::session::SessionId;

const PERF_EMIT_INTERVAL: Duration = Duration::from_millis(250);
const MIN_FRAME_INTERVAL: Duration = Duration::from_millis(4);

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
    let term_arc = term_arc?;

    let frame_start = Instant::now();
    let mut term = term_arc.lock();
    let frame = render_viewport(&mut term);
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

        let mut last_emit: Option<Instant> = None;
        if let Some(metrics) = emit_frame_for_session(&app_handle, initial_session_id) {
            avg_frame_ms = metrics.frame_ms;
            avg_ansi_bytes = metrics.ansi_bytes as f64;
            frames_since_emit = 1;
            last_emit = Some(Instant::now());
        }
        let mut rendered_generation = render_coordinator.current_generation();

        loop {
            let dirty = render_coordinator.wait_for_next(rendered_generation);

            // Cap emit rate during bursts. Idle keystrokes pay no cost because
            // last_emit will be stale; back-to-back marks get coalesced into one
            // full-viewport render of the latest state.
            if let Some(last) = last_emit {
                let elapsed = last.elapsed();
                if elapsed < MIN_FRAME_INTERVAL {
                    thread::sleep(MIN_FRAME_INTERVAL - elapsed);
                }
            }

            let gen_at_render = render_coordinator.current_generation();
            if let Some(metrics) = emit_frame_for_session(&app_handle, dirty.session_id) {
                rendered_generation = gen_at_render;
                last_emit = Some(Instant::now());
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

/// Streaming render: returns a partial frame (just the damaged lines) when
/// alacritty's damage tracking allows it, falling back to a full repaint when
/// damage is global or scrollback is in view. Consumes the term's damage state.
pub fn render_viewport<T: EventListener>(term: &mut Term<T>) -> TerminalFrame {
    let damage_kind = match term.damage() {
        TermDamage::Full => DamageKind::Full,
        TermDamage::Partial(iter) => DamageKind::Partial(iter.collect()),
    };
    term.reset_damage();

    let display_offset = term.grid().display_offset();
    // Scrollback uses the full path: alacritty's per-line damage only covers
    // the live viewport, so off-screen content must be repainted entirely.
    let use_full = display_offset != 0 || matches!(damage_kind, DamageKind::Full);

    let body = if use_full {
        render_full(term)
    } else {
        match damage_kind {
            DamageKind::Partial(lines) if !lines.is_empty() => {
                render_partial(term, &lines, term.columns())
            }
            _ => String::with_capacity(32),
        }
    };

    finalize_frame(term, body)
}

/// Always renders the full visible grid. Used for initial frontend paint
/// (`commands.rs::get_terminal_frame`) where the receiver has no prior state
/// and a partial diff would leave most of the screen blank.
pub fn render_viewport_full<T: EventListener>(term: &Term<T>) -> TerminalFrame {
    finalize_frame(term, render_full(term))
}

fn finalize_frame<T: EventListener>(term: &Term<T>, mut out: String) -> TerminalFrame {
    let content = term.renderable_content();
    let cursor = content.cursor;
    let cursor_visible = content.mode.contains(TermMode::SHOW_CURSOR);
    let display_offset = content.display_offset;
    let alternate_screen = content.mode.contains(TermMode::ALT_SCREEN);
    let total_lines = term.grid().total_lines();

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

enum DamageKind {
    Full,
    Partial(Vec<LineDamageBounds>),
}

/// Full repaint path: emits clear-screen + every visible cell. Stable signature
/// taking `&Term` so benches can drive it without `&mut` access.
pub fn render_full<T: EventListener>(term: &Term<T>) -> String {
    let content = term.renderable_content();
    let num_cols = term.columns();
    let num_lines = term.screen_lines();
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

        push_cell_char(&mut out, cell);
    }

    out
}

pub fn render_partial<T: EventListener>(
    term: &Term<T>,
    damaged: &[LineDamageBounds],
    num_cols: usize,
) -> String {
    // Estimate output size from the actual damage extent (cells × ~6 bytes
    // for SGR + char) — better than a fixed grid-sized allocation for the
    // small, typical-case partial frames where this path matters.
    let damaged_cells: usize = damaged
        .iter()
        .map(|d| d.right.saturating_sub(d.left) + 1)
        .sum();
    let mut out = String::with_capacity(damaged_cells * 6 + damaged.len() * 16);

    let grid = term.grid();

    for bounds in damaged {
        let line = bounds.line;
        let left = bounds.left.min(num_cols.saturating_sub(1));
        let right = bounds.right.min(num_cols.saturating_sub(1));

        // Reset SGR at line start so attrs leaking in from prior frames are
        // cleared, then re-emit per-cell SGR as needed.
        let _ = write!(out, "\x1b[{};{}H\x1b[0m", line + 1, left + 1);

        let mut prev_fg = Color::Named(NamedColor::Foreground);
        let mut prev_bg = Color::Named(NamedColor::Background);
        let mut prev_flags = Flags::empty();

        let row = &grid[Line(line as i32)];
        for col in left..=right {
            let cell = &row[Column(col)];
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

            push_cell_char(&mut out, cell);
        }
    }

    out
}

fn push_cell_char(out: &mut String, cell: &alacritty_terminal::term::cell::Cell) {
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

    /// Walks the grid directly so callers can use it without consuming the
    /// term's damage state (which `render_viewport` does on every call).
    /// Honors `display_offset` so scrollback tests see history rows.
    fn viewport_text(term: &Term<VoidListener>) -> String {
        use alacritty_terminal::index::{Column, Line};
        use alacritty_terminal::term::cell::Flags;
        let cols = term.columns();
        let lines = term.screen_lines();
        let display_offset = term.grid().display_offset() as i32;
        let grid = term.grid();
        let mut out = String::new();
        for row_idx in 0..lines {
            if row_idx > 0 {
                out.push_str("\r\n");
            }
            let line = Line(row_idx as i32 - display_offset);
            let row = &grid[line];
            for col in 0..cols {
                let cell = &row[Column(col)];
                if cell.flags.contains(Flags::WIDE_CHAR_SPACER)
                    || cell.flags.contains(Flags::LEADING_WIDE_CHAR_SPACER)
                {
                    continue;
                }
                let c = cell.c;
                if c == '\0' || c.is_ascii_control() {
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
        }
        out
    }

    fn visible_text(term: &Term<VoidListener>) -> String {
        viewport_text(term)
            .split("\r\n")
            .map(str::trim_end)
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn render_viewport_hides_cursor_when_show_cursor_mode_is_disabled() {
        let mut term = term(8, 4);
        apply_escape_sequence(&mut term, b"\x1b[?25l");

        let frame = render_viewport(&mut term);
        let ansi = String::from_utf8(frame.ansi).expect("frame ansi should be valid utf-8");

        assert!(!frame.cursor_visible);
        assert!(ansi.contains("\x1b[?25l"));
    }

    #[test]
    fn render_viewport_reports_alternate_screen_mode() {
        let mut term = term(8, 4);
        apply_escape_sequence(&mut term, b"\x1b[?1049h");

        let frame = render_viewport(&mut term);

        assert!(frame.alternate_screen);
    }

    #[test]
    fn render_viewport_preserves_scrollback_when_viewport_is_scrolled_up() {
        let mut term = term(8, 3);
        apply_escape_sequence(&mut term, b"1\r\n2\r\n3\r\n4\r\n5");

        term.scroll_display(Scroll::Top);

        let frame = render_viewport(&mut term);
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

        let frame = render_viewport(&mut term);
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

        let frame = render_viewport(&mut term);
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

        let frame = render_viewport(&mut term);
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

        let frame = render_viewport(&mut term);
        let viewport = viewport_text(&term);

        assert_eq!(viewport, "e\u{301}x  \r\n    ");
        assert_eq!(visible_text(&term), "e\u{301}x\n");
        assert_eq!(frame.cursor_x, 2);
        assert_eq!(frame.cursor_y, 0);
    }
}
