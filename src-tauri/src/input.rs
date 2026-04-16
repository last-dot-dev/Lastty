use alacritty_terminal::term::TermMode;

pub fn key_requires_mode_lookup(code: &str) -> bool {
    matches!(
        code,
        "ArrowUp" | "ArrowDown" | "ArrowRight" | "ArrowLeft" | "Home" | "End"
    )
}

/// Translate a keyboard event from the webview into terminal byte sequences.
pub fn key_to_bytes(
    key: &str,
    code: &str,
    ctrl: bool,
    alt: bool,
    shift: bool,
    _meta: bool,
    mode: Option<TermMode>,
) -> Option<Vec<u8>> {
    // Handle ctrl+key combinations.
    if ctrl {
        if let Some(b) = ctrl_key(key) {
            if alt {
                return Some(vec![0x1b, b]);
            }
            return Some(vec![b]);
        }
    }

    // Handle special keys.
    let app_cursor = mode
        .map(|value| value.contains(TermMode::APP_CURSOR))
        .unwrap_or(false);
    let modifiers = csi_modifier(shift, alt, ctrl);

    let bytes: Option<Vec<u8>> = match code {
        "Enter" | "NumpadEnter" => Some(vec![0x0d]),
        "Backspace" => {
            if alt {
                Some(vec![0x1b, 0x7f])
            } else {
                Some(vec![0x7f])
            }
        }
        "Tab" => {
            if shift {
                Some(b"\x1b[Z".to_vec())
            } else {
                Some(vec![0x09])
            }
        }
        "Escape" => Some(vec![0x1b]),
        "ArrowUp" => Some(cursor_key_bytes('A', app_cursor, modifiers)),
        "ArrowDown" => Some(cursor_key_bytes('B', app_cursor, modifiers)),
        "ArrowRight" => Some(cursor_key_bytes('C', app_cursor, modifiers)),
        "ArrowLeft" => Some(cursor_key_bytes('D', app_cursor, modifiers)),
        "Home" => Some(home_end_bytes('H', app_cursor, modifiers)),
        "End" => Some(home_end_bytes('F', app_cursor, modifiers)),
        "Insert" => Some(b"\x1b[2~".to_vec()),
        "Delete" => Some(b"\x1b[3~".to_vec()),
        "PageUp" => Some(b"\x1b[5~".to_vec()),
        "PageDown" => Some(b"\x1b[6~".to_vec()),
        "F1" => Some(b"\x1bOP".to_vec()),
        "F2" => Some(b"\x1bOQ".to_vec()),
        "F3" => Some(b"\x1bOR".to_vec()),
        "F4" => Some(b"\x1bOS".to_vec()),
        "F5" => Some(b"\x1b[15~".to_vec()),
        "F6" => Some(b"\x1b[17~".to_vec()),
        "F7" => Some(b"\x1b[18~".to_vec()),
        "F8" => Some(b"\x1b[19~".to_vec()),
        "F9" => Some(b"\x1b[20~".to_vec()),
        "F10" => Some(b"\x1b[21~".to_vec()),
        "F11" => Some(b"\x1b[23~".to_vec()),
        "F12" => Some(b"\x1b[24~".to_vec()),
        _ => None,
    };

    if bytes.is_some() {
        return bytes;
    }

    // Regular character input.
    if key.len() == 1 {
        let c = key.chars().next().unwrap();
        if alt {
            let mut buf = vec![0x1b];
            let mut char_buf = [0u8; 4];
            buf.extend_from_slice(c.encode_utf8(&mut char_buf).as_bytes());
            Some(buf)
        } else {
            let mut char_buf = [0u8; 4];
            let s = c.encode_utf8(&mut char_buf);
            Some(s.as_bytes().to_vec())
        }
    } else {
        // Multi-character key name that we don't handle (e.g., "Shift", "Control").
        None
    }
}

fn csi_modifier(shift: bool, alt: bool, ctrl: bool) -> Option<u8> {
    let modifiers = (shift as u8) | ((alt as u8) << 1) | ((ctrl as u8) << 2);
    (modifiers != 0).then_some(modifiers + 1)
}

fn cursor_key_bytes(final_byte: char, app_cursor: bool, modifier: Option<u8>) -> Vec<u8> {
    if let Some(modifier) = modifier {
        return format!("\x1b[1;{modifier}{final_byte}").into_bytes();
    }

    match (app_cursor, final_byte) {
        (true, 'A') => b"\x1bOA".to_vec(),
        (true, 'B') => b"\x1bOB".to_vec(),
        (true, 'C') => b"\x1bOC".to_vec(),
        (true, 'D') => b"\x1bOD".to_vec(),
        (_, byte) => format!("\x1b[{byte}").into_bytes(),
    }
}

fn home_end_bytes(final_byte: char, app_cursor: bool, modifier: Option<u8>) -> Vec<u8> {
    if let Some(modifier) = modifier {
        return format!("\x1b[1;{modifier}{final_byte}").into_bytes();
    }

    match (app_cursor, final_byte) {
        (true, 'H') => b"\x1bOH".to_vec(),
        (true, 'F') => b"\x1bOF".to_vec(),
        (_, byte) => format!("\x1b[{byte}").into_bytes(),
    }
}

/// Map ctrl+key to control code byte.
fn ctrl_key(key: &str) -> Option<u8> {
    if key.len() != 1 {
        return None;
    }
    let c = key.chars().next().unwrap();
    match c {
        'a'..='z' => Some(c as u8 - b'a' + 1),
        'A'..='Z' => Some(c as u8 - b'A' + 1),
        '[' | '{' => Some(0x1b),
        '\\' | '|' => Some(0x1c),
        ']' | '}' => Some(0x1d),
        '^' | '~' => Some(0x1e),
        '_' | '/' => Some(0x1f),
        '@' | ' ' => Some(0x00),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::{key_requires_mode_lookup, key_to_bytes};
    use alacritty_terminal::term::TermMode;

    #[test]
    fn mode_lookup_is_limited_to_app_cursor_keys() {
        assert!(key_requires_mode_lookup("ArrowUp"));
        assert!(key_requires_mode_lookup("Home"));
        assert!(!key_requires_mode_lookup("Tab"));
        assert!(!key_requires_mode_lookup("KeyA"));
    }

    #[test]
    fn arrows_use_csi_modifier_sequences_without_app_cursor() {
        assert_bytes("ArrowUp", true, false, false, b"\x1b[1;2A");
        assert_bytes("ArrowDown", false, true, false, b"\x1b[1;3B");
        assert_bytes("ArrowRight", false, false, true, b"\x1b[1;5C");
        assert_bytes("ArrowLeft", true, true, false, b"\x1b[1;4D");
    }

    #[test]
    fn arrows_ignore_app_cursor_mode_once_modifiers_are_present() {
        let app_cursor = Some(TermMode::APP_CURSOR);
        assert_bytes_with_mode("ArrowUp", true, false, false, app_cursor, b"\x1b[1;2A");
        assert_bytes_with_mode("ArrowRight", false, true, false, app_cursor, b"\x1b[1;3C");
        assert_bytes_with_mode("ArrowLeft", false, false, true, app_cursor, b"\x1b[1;5D");
    }

    #[test]
    fn home_and_end_follow_xterm_modifier_sequences() {
        assert_bytes("Home", true, false, false, b"\x1b[1;2H");
        assert_bytes("End", false, true, false, b"\x1b[1;3F");
        assert_bytes_with_mode(
            "Home",
            false,
            false,
            true,
            Some(TermMode::APP_CURSOR),
            b"\x1b[1;5H",
        );
        assert_bytes_with_mode(
            "End",
            true,
            true,
            false,
            Some(TermMode::APP_CURSOR),
            b"\x1b[1;4F",
        );
    }

    #[test]
    fn app_cursor_mode_only_changes_unmodified_navigation_keys() {
        assert_bytes_with_mode(
            "ArrowUp",
            false,
            false,
            false,
            Some(TermMode::APP_CURSOR),
            b"\x1bOA",
        );
        assert_bytes_with_mode(
            "Home",
            false,
            false,
            false,
            Some(TermMode::APP_CURSOR),
            b"\x1bOH",
        );
        assert_bytes_with_mode(
            "End",
            false,
            false,
            false,
            Some(TermMode::APP_CURSOR),
            b"\x1bOF",
        );
    }

    #[test]
    fn tab_preserves_existing_forward_and_reverse_tab_behavior() {
        assert_bytes("Tab", false, false, false, b"\t");
        assert_bytes("Tab", true, false, false, b"\x1b[Z");
        assert_bytes("Tab", false, true, false, b"\t");
        assert_bytes("Tab", false, false, true, b"\t");
        assert_bytes_with_mode(
            "Tab",
            true,
            false,
            false,
            Some(TermMode::APP_CURSOR),
            b"\x1b[Z",
        );
    }

    fn assert_bytes(code: &str, shift: bool, alt: bool, ctrl: bool, expected: &[u8]) {
        assert_bytes_with_mode(code, shift, alt, ctrl, None, expected);
    }

    fn assert_bytes_with_mode(
        code: &str,
        shift: bool,
        alt: bool,
        ctrl: bool,
        mode: Option<TermMode>,
        expected: &[u8],
    ) {
        let bytes =
            key_to_bytes(code, code, ctrl, alt, shift, false, mode).expect("key should map");
        assert_eq!(bytes, expected);
    }
}
