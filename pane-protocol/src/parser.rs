use crate::constants::{BEL, ESC, MAX_PAYLOAD_SIZE, OSC_AGENT_TO_APP};
use crate::message::AgentUiMessage;

/// A chunk of parsed PTY output.
#[derive(Debug, Clone, PartialEq)]
pub enum ParsedChunk {
    /// Regular terminal data — forward to the terminal emulator.
    TerminalData(Vec<u8>),
    /// A successfully parsed agent UI message.
    AgentMessage(AgentUiMessage),
    /// An OSC 7770 sequence with invalid JSON — forward as terminal data.
    MalformedOsc(Vec<u8>),
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum State {
    Normal,
    Escape,
    OscId,
    OscPayload,
    OscStTerminator,
}

/// Streaming OSC 7770 parser.
///
/// Holds state between calls to [`feed`] so it can handle OSC sequences
/// split across multiple read boundaries.
pub struct OscParser {
    state: State,
    osc_id_buf: Vec<u8>,
    payload_buf: Vec<u8>,
    /// Bytes accumulated before the current state that need to be
    /// re-emitted as terminal data if the sequence turns out to not be ours.
    escape_buf: Vec<u8>,
}

impl OscParser {
    pub fn new() -> Self {
        Self {
            state: State::Normal,
            osc_id_buf: Vec::new(),
            payload_buf: Vec::new(),
            escape_buf: Vec::new(),
        }
    }

    /// Feed a raw PTY read buffer into the parser.
    ///
    /// Returns a list of parsed chunks. Terminal data chunks are coalesced
    /// where possible.
    pub fn feed(&mut self, data: &[u8]) -> Vec<ParsedChunk> {
        let mut chunks = Vec::new();
        let mut terminal_buf = Vec::new();

        for &byte in data {
            match self.state {
                State::Normal => {
                    if byte == ESC {
                        self.state = State::Escape;
                        self.escape_buf.clear();
                        self.escape_buf.push(byte);
                    } else {
                        terminal_buf.push(byte);
                    }
                }

                State::Escape => {
                    if byte == b']' {
                        self.escape_buf.push(byte);
                        self.state = State::OscId;
                        self.osc_id_buf.clear();
                    } else {
                        // Not an OSC sequence — emit the ESC + this byte as terminal data.
                        self.escape_buf.push(byte);
                        terminal_buf.extend_from_slice(&self.escape_buf);
                        self.escape_buf.clear();
                        self.state = State::Normal;
                    }
                }

                State::OscId => {
                    if byte == b';' {
                        if self.osc_id_buf == OSC_AGENT_TO_APP.as_bytes() {
                            // It's ours! Start collecting the payload.
                            self.state = State::OscPayload;
                            self.payload_buf.clear();
                        } else {
                            // Not our OSC — emit everything accumulated as terminal data.
                            self.escape_buf.extend_from_slice(&self.osc_id_buf);
                            self.escape_buf.push(byte);
                            terminal_buf.extend_from_slice(&self.escape_buf);
                            self.escape_buf.clear();
                            self.osc_id_buf.clear();
                            self.state = State::Normal;
                        }
                    } else if byte.is_ascii_digit() {
                        self.osc_id_buf.push(byte);
                        // Bail out early if the ID is already too long to be ours.
                        if self.osc_id_buf.len() > OSC_AGENT_TO_APP.len() {
                            self.escape_buf.extend_from_slice(&self.osc_id_buf);
                            terminal_buf.extend_from_slice(&self.escape_buf);
                            self.escape_buf.clear();
                            self.osc_id_buf.clear();
                            self.state = State::Normal;
                        }
                    } else if byte == BEL || (byte == b'\\' && self.escape_buf.last() == Some(&ESC))
                    {
                        // OSC terminated before we got a semicolon — not ours.
                        self.escape_buf.extend_from_slice(&self.osc_id_buf);
                        self.escape_buf.push(byte);
                        terminal_buf.extend_from_slice(&self.escape_buf);
                        self.escape_buf.clear();
                        self.osc_id_buf.clear();
                        self.state = State::Normal;
                    } else {
                        // Non-digit, non-semicolon — not a valid OSC ID.
                        self.escape_buf.extend_from_slice(&self.osc_id_buf);
                        self.escape_buf.push(byte);
                        terminal_buf.extend_from_slice(&self.escape_buf);
                        self.escape_buf.clear();
                        self.osc_id_buf.clear();
                        self.state = State::Normal;
                    }
                }

                State::OscPayload => {
                    if byte == BEL {
                        // End of OSC via BEL — try to parse the JSON.
                        Self::flush_terminal(&mut terminal_buf, &mut chunks);
                        self.emit_payload(&mut chunks);
                        self.state = State::Normal;
                    } else if byte == ESC {
                        // Could be start of ST (ESC \).
                        self.state = State::OscStTerminator;
                    } else {
                        self.payload_buf.push(byte);
                        if self.payload_buf.len() > MAX_PAYLOAD_SIZE {
                            // Payload too large — emit as malformed.
                            Self::flush_terminal(&mut terminal_buf, &mut chunks);
                            self.emit_malformed(&mut chunks);
                            self.state = State::Normal;
                        }
                    }
                }

                State::OscStTerminator => {
                    if byte == b'\\' {
                        // ST (ESC \) — end of OSC.
                        Self::flush_terminal(&mut terminal_buf, &mut chunks);
                        self.emit_payload(&mut chunks);
                        self.state = State::Normal;
                    } else {
                        // Not ST — the ESC is part of the payload.
                        self.payload_buf.push(ESC);
                        self.payload_buf.push(byte);
                        self.state = State::OscPayload;
                        if self.payload_buf.len() > MAX_PAYLOAD_SIZE {
                            Self::flush_terminal(&mut terminal_buf, &mut chunks);
                            self.emit_malformed(&mut chunks);
                            self.state = State::Normal;
                        }
                    }
                }
            }
        }

        Self::flush_terminal(&mut terminal_buf, &mut chunks);
        chunks
    }

    fn flush_terminal(buf: &mut Vec<u8>, chunks: &mut Vec<ParsedChunk>) {
        if !buf.is_empty() {
            chunks.push(ParsedChunk::TerminalData(std::mem::take(buf)));
        }
    }

    fn emit_payload(&mut self, chunks: &mut Vec<ParsedChunk>) {
        let payload = std::mem::take(&mut self.payload_buf);
        match serde_json::from_slice::<AgentUiMessage>(&payload) {
            Ok(msg) => chunks.push(ParsedChunk::AgentMessage(msg)),
            Err(_) => {
                // Reconstruct the full OSC sequence for passthrough.
                let mut raw = Vec::new();
                raw.push(ESC);
                raw.push(b']');
                raw.extend_from_slice(OSC_AGENT_TO_APP.as_bytes());
                raw.push(b';');
                raw.extend_from_slice(&payload);
                raw.push(BEL);
                chunks.push(ParsedChunk::MalformedOsc(raw));
            }
        }
        self.escape_buf.clear();
    }

    fn emit_malformed(&mut self, chunks: &mut Vec<ParsedChunk>) {
        let payload = std::mem::take(&mut self.payload_buf);
        let mut raw = Vec::new();
        raw.push(ESC);
        raw.push(b']');
        raw.extend_from_slice(OSC_AGENT_TO_APP.as_bytes());
        raw.push(b';');
        raw.extend_from_slice(&payload);
        chunks.push(ParsedChunk::MalformedOsc(raw));
        self.escape_buf.clear();
    }
}

impl Default for OscParser {
    fn default() -> Self {
        Self::new()
    }
}
