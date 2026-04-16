use alacritty_terminal::term::TermMode;

/// Translate a keyboard event from the webview into terminal byte sequences.
pub fn key_to_bytes(
    key: &str,
    code: &str,
    ctrl: bool,
    alt: bool,
    shift: bool,
    _meta: bool,
    mode: TermMode,
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
    let app_cursor = mode.contains(TermMode::APP_CURSOR);

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
        "ArrowUp" => Some(if app_cursor { b"\x1bOA" } else { b"\x1b[A" }.to_vec()),
        "ArrowDown" => Some(if app_cursor { b"\x1bOB" } else { b"\x1b[B" }.to_vec()),
        "ArrowRight" => Some(if app_cursor { b"\x1bOC" } else { b"\x1b[C" }.to_vec()),
        "ArrowLeft" => Some(if app_cursor { b"\x1bOD" } else { b"\x1b[D" }.to_vec()),
        "Home" => Some(if app_cursor { b"\x1bOH" } else { b"\x1b[H" }.to_vec()),
        "End" => Some(if app_cursor { b"\x1bOF" } else { b"\x1b[F" }.to_vec()),
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
