use alacritty_terminal::event::EventListener;
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::term::cell::Flags;
use alacritty_terminal::term::{Term, TermMode};
use alacritty_terminal::vte::ansi::{Color, NamedColor};

#[derive(serde::Serialize, Clone)]
pub struct TerminalFrame {
    pub ansi: Vec<u8>,
    pub cursor_x: usize,
    pub cursor_y: usize,
    pub cursor_visible: bool,
    pub display_offset: usize,
    pub total_lines: usize,
    pub alternate_screen: bool,
}

#[derive(serde::Serialize, Clone)]
pub struct TerminalFrameEvent {
    pub session_id: String,
    pub frame: TerminalFrame,
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

    let mut out = String::with_capacity(num_cols * num_lines * 8);
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
                out.push_str("\x1b[0m\r\n");
                prev_fg = Color::Named(NamedColor::Foreground);
                prev_bg = Color::Named(NamedColor::Background);
                prev_flags = Flags::empty();
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
            out.push_str(&format!("\x1b[{};{}H", cy, cx));
        }
    } else if display_offset > 0 {
        out.push_str("\x1b[?25l");
    }

    TerminalFrame {
        ansi: out.into_bytes(),
        cursor_x: cursor.point.column.0,
        cursor_y: {
            let line = cursor.point.line.0 + display_offset as i32;
            if line >= 0 { line as usize } else { 0 }
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
                _ => if is_fg { 39 } else { 49 },
            };
            out.push_str(&format!(";{code}"));
        }
        Color::Indexed(idx) => {
            let prefix = if is_fg { 38 } else { 48 };
            out.push_str(&format!(";{prefix};5;{idx}"));
        }
        Color::Spec(rgb) => {
            let prefix = if is_fg { 38 } else { 48 };
            out.push_str(&format!(";{prefix};2;{};{};{}", rgb.r, rgb.g, rgb.b));
        }
    }
}
