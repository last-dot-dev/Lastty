use std::path::Path;

const ESC: u8 = 0x1b;
const BEL: u8 = 0x07;
const MAX_PAYLOAD: usize = 4096;

#[derive(Debug, Clone, Copy, PartialEq)]
enum State {
    Normal,
    Escape,
    OscId,
    Payload,
    PayloadEsc,
}

/// Streaming OSC 7 sniffer.
///
/// Runs in parallel with terminal data passthrough: feed raw PTY bytes and
/// it returns any completed working-directory updates. Non-OSC-7 bytes are
/// ignored. State persists across feeds so sequences split across reads
/// still resolve correctly.
pub(crate) struct Osc7Scanner {
    state: State,
    id_buf: Vec<u8>,
    payload_buf: Vec<u8>,
}

impl Osc7Scanner {
    pub(crate) fn new() -> Self {
        Self {
            state: State::Normal,
            id_buf: Vec::new(),
            payload_buf: Vec::new(),
        }
    }

    pub(crate) fn feed(&mut self, data: &[u8]) -> Vec<String> {
        let mut out = Vec::new();
        for &byte in data {
            match self.state {
                State::Normal => {
                    if byte == ESC {
                        self.state = State::Escape;
                    }
                }
                State::Escape => {
                    if byte == b']' {
                        self.state = State::OscId;
                        self.id_buf.clear();
                    } else {
                        self.state = if byte == ESC {
                            State::Escape
                        } else {
                            State::Normal
                        };
                    }
                }
                State::OscId => {
                    if byte == b';' {
                        if self.id_buf == b"7" {
                            self.state = State::Payload;
                            self.payload_buf.clear();
                        } else {
                            self.reset();
                        }
                    } else if byte.is_ascii_digit() && self.id_buf.len() < 4 {
                        self.id_buf.push(byte);
                    } else {
                        self.reset();
                    }
                }
                State::Payload => {
                    if byte == BEL {
                        if let Some(path) = parse_uri(&self.payload_buf) {
                            out.push(path);
                        }
                        self.reset();
                    } else if byte == ESC {
                        self.state = State::PayloadEsc;
                    } else {
                        self.payload_buf.push(byte);
                        if self.payload_buf.len() > MAX_PAYLOAD {
                            self.reset();
                        }
                    }
                }
                State::PayloadEsc => {
                    if byte == b'\\' {
                        if let Some(path) = parse_uri(&self.payload_buf) {
                            out.push(path);
                        }
                        self.reset();
                    } else {
                        self.payload_buf.push(ESC);
                        self.payload_buf.push(byte);
                        self.state = State::Payload;
                        if self.payload_buf.len() > MAX_PAYLOAD {
                            self.reset();
                        }
                    }
                }
            }
        }
        out
    }

    fn reset(&mut self) {
        self.state = State::Normal;
        self.id_buf.clear();
        self.payload_buf.clear();
    }
}

fn parse_uri(payload: &[u8]) -> Option<String> {
    let text = std::str::from_utf8(payload).ok()?;
    let rest = text.strip_prefix("file://")?;
    let path_start = rest.find('/')?;
    let encoded = &rest[path_start..];
    let decoded = percent_decode(encoded)?;
    validate_path(&decoded).then_some(decoded)
}

fn percent_decode(input: &str) -> Option<String> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let byte = bytes[i];
        if byte == b'%' {
            if i + 2 >= bytes.len() {
                return None;
            }
            let hi = hex_digit(bytes[i + 1])?;
            let lo = hex_digit(bytes[i + 2])?;
            out.push((hi << 4) | lo);
            i += 3;
        } else {
            out.push(byte);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn hex_digit(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn validate_path(path: &str) -> bool {
    !path.is_empty() && !path.contains('\0') && Path::new(path).is_absolute()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_bel_terminated_osc7() {
        let mut scanner = Osc7Scanner::new();
        let out = scanner.feed(b"\x1b]7;file://host/Users/alice/code\x07");
        assert_eq!(out, vec!["/Users/alice/code".to_string()]);
    }

    #[test]
    fn parses_st_terminated_osc7() {
        let mut scanner = Osc7Scanner::new();
        let out = scanner.feed(b"\x1b]7;file:///tmp/foo\x1b\\");
        assert_eq!(out, vec!["/tmp/foo".to_string()]);
    }

    #[test]
    fn url_decodes_path() {
        let mut scanner = Osc7Scanner::new();
        let out = scanner.feed(b"\x1b]7;file://host/Users/alice/my%20code\x07");
        assert_eq!(out, vec!["/Users/alice/my code".to_string()]);
    }

    #[test]
    fn handles_split_across_feeds() {
        let mut scanner = Osc7Scanner::new();
        assert!(scanner.feed(b"\x1b]7;file://ho").is_empty());
        assert!(scanner.feed(b"st/tmp").is_empty());
        let out = scanner.feed(b"/bar\x07");
        assert_eq!(out, vec!["/tmp/bar".to_string()]);
    }

    #[test]
    fn ignores_other_osc_sequences() {
        let mut scanner = Osc7Scanner::new();
        let out = scanner.feed(b"\x1b]0;some title\x07\x1b]7770;{\"type\":\"x\"}\x07");
        assert!(out.is_empty());
    }

    #[test]
    fn ignores_non_file_scheme() {
        let mut scanner = Osc7Scanner::new();
        let out = scanner.feed(b"\x1b]7;https://example.com/\x07");
        assert!(out.is_empty());
    }

    #[test]
    fn rejects_uri_without_path() {
        let mut scanner = Osc7Scanner::new();
        let out = scanner.feed(b"\x1b]7;file://host\x07");
        assert!(out.is_empty());
    }

    #[test]
    fn rejects_path_with_null_byte() {
        let mut scanner = Osc7Scanner::new();
        let out = scanner.feed(b"\x1b]7;file://host/bad%00path\x07");
        assert!(out.is_empty());
    }

    #[test]
    fn rejects_malformed_percent_escape() {
        let mut scanner = Osc7Scanner::new();
        let out = scanner.feed(b"\x1b]7;file://host/broken%ZZ\x07");
        assert!(out.is_empty());
    }

    #[test]
    fn recovers_after_malformed_sequence() {
        let mut scanner = Osc7Scanner::new();
        scanner.feed(b"\x1b]7;not a uri\x07");
        let out = scanner.feed(b"\x1b]7;file:///valid/path\x07");
        assert_eq!(out, vec!["/valid/path".to_string()]);
    }

    #[test]
    fn empty_hostname_allowed() {
        let mut scanner = Osc7Scanner::new();
        let out = scanner.feed(b"\x1b]7;file:///only/slash\x07");
        assert_eq!(out, vec!["/only/slash".to_string()]);
    }
}
