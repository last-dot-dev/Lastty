use pane_protocol::parser::{OscParser, ParsedChunk};
use pane_protocol::message::AgentUiMessage;
use pane_protocol::encoder::encode;
use serde_json::json;

fn parse_all(data: &[u8]) -> Vec<ParsedChunk> {
    let mut parser = OscParser::new();
    parser.feed(data)
}

// ── Basic message types ──────────────────────────────────────────────

#[test]
fn parse_ready_message() {
    let msg = AgentUiMessage::Ready {
        agent: "test-agent".into(),
        version: Some("1.0".into()),
    };
    let encoded = encode(&msg);
    let chunks = parse_all(&encoded);

    assert_eq!(chunks.len(), 1);
    assert_eq!(chunks[0], ParsedChunk::AgentMessage(msg));
}

#[test]
fn parse_status_message() {
    let msg = AgentUiMessage::Status {
        phase: "thinking".into(),
        detail: Some("reading files".into()),
    };
    let encoded = encode(&msg);
    let chunks = parse_all(&encoded);

    assert_eq!(chunks.len(), 1);
    assert_eq!(chunks[0], ParsedChunk::AgentMessage(msg));
}

#[test]
fn parse_progress_message() {
    let msg = AgentUiMessage::Progress {
        pct: 42,
        message: "halfway".into(),
    };
    let encoded = encode(&msg);
    let chunks = parse_all(&encoded);

    assert_eq!(chunks.len(), 1);
    assert_eq!(chunks[0], ParsedChunk::AgentMessage(msg));
}

#[test]
fn parse_finished_message() {
    let msg = AgentUiMessage::Finished {
        summary: "all done".into(),
        exit_code: Some(0),
    };
    let encoded = encode(&msg);
    let chunks = parse_all(&encoded);

    assert_eq!(chunks.len(), 1);
    assert_eq!(chunks[0], ParsedChunk::AgentMessage(msg));
}

#[test]
fn parse_tool_call_message() {
    let msg = AgentUiMessage::ToolCall {
        id: "t1".into(),
        name: "read_file".into(),
        args: json!({"path": "src/main.rs"}),
    };
    let encoded = encode(&msg);
    let chunks = parse_all(&encoded);

    assert_eq!(chunks.len(), 1);
    assert_eq!(chunks[0], ParsedChunk::AgentMessage(msg));
}

#[test]
fn parse_tool_result_message() {
    let msg = AgentUiMessage::ToolResult {
        id: "t1".into(),
        result: json!("file contents"),
        error: None,
    };
    let encoded = encode(&msg);
    let chunks = parse_all(&encoded);

    assert_eq!(chunks.len(), 1);
    assert_eq!(chunks[0], ParsedChunk::AgentMessage(msg));
}

#[test]
fn parse_file_operations() {
    for msg in [
        AgentUiMessage::FileEdit {
            path: "src/lib.rs".into(),
            diff: Some("@@ -1 +1 @@\n-old\n+new".into()),
        },
        AgentUiMessage::FileCreate {
            path: "new_file.rs".into(),
        },
        AgentUiMessage::FileDelete {
            path: "old_file.rs".into(),
        },
    ] {
        let encoded = encode(&msg);
        let chunks = parse_all(&encoded);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0], ParsedChunk::AgentMessage(msg));
    }
}

#[test]
fn parse_approval_message() {
    let msg = AgentUiMessage::Approval {
        id: "a1".into(),
        message: "Delete production database?".into(),
        options: vec!["yes".into(), "no".into()],
    };
    let encoded = encode(&msg);
    let chunks = parse_all(&encoded);

    assert_eq!(chunks.len(), 1);
    assert_eq!(chunks[0], ParsedChunk::AgentMessage(msg));
}

#[test]
fn parse_notification_message() {
    let msg = AgentUiMessage::Notification {
        level: "warn".into(),
        message: "Rate limit approaching".into(),
    };
    let encoded = encode(&msg);
    let chunks = parse_all(&encoded);

    assert_eq!(chunks.len(), 1);
    assert_eq!(chunks[0], ParsedChunk::AgentMessage(msg));
}

#[test]
fn parse_widget_message() {
    let msg = AgentUiMessage::Widget {
        widget_type: "custom".into(),
        props: json!({"key": "value"}),
    };
    let encoded = encode(&msg);
    let chunks = parse_all(&encoded);

    assert_eq!(chunks.len(), 1);
    assert_eq!(chunks[0], ParsedChunk::AgentMessage(msg));
}

// ── Terminal data passthrough ────────────────────────────────────────

#[test]
fn plain_terminal_data_passes_through() {
    let data = b"Hello, world!\r\n$ ";
    let chunks = parse_all(data);

    assert_eq!(chunks.len(), 1);
    assert_eq!(chunks[0], ParsedChunk::TerminalData(data.to_vec()));
}

#[test]
fn mixed_terminal_and_osc_data() {
    let msg = AgentUiMessage::Status {
        phase: "working".into(),
        detail: None,
    };
    let osc = encode(&msg);

    let mut data = b"before ".to_vec();
    data.extend_from_slice(&osc);
    data.extend_from_slice(b" after");

    let chunks = parse_all(&data);
    assert_eq!(chunks.len(), 3);
    assert_eq!(chunks[0], ParsedChunk::TerminalData(b"before ".to_vec()));
    assert_eq!(chunks[1], ParsedChunk::AgentMessage(msg));
    assert_eq!(chunks[2], ParsedChunk::TerminalData(b" after".to_vec()));
}

// ── Split reads across chunk boundaries ──────────────────────────────

#[test]
fn osc_split_across_two_reads() {
    let msg = AgentUiMessage::Ready {
        agent: "split-agent".into(),
        version: None,
    };
    let encoded = encode(&msg);
    let mid = encoded.len() / 2;

    let mut parser = OscParser::new();
    let chunks1 = parser.feed(&encoded[..mid]);
    let chunks2 = parser.feed(&encoded[mid..]);

    // First feed should produce nothing (or empty terminal data).
    let all: Vec<ParsedChunk> = chunks1
        .into_iter()
        .chain(chunks2.into_iter())
        .filter(|c| !matches!(c, ParsedChunk::TerminalData(d) if d.is_empty()))
        .collect();

    assert_eq!(all.len(), 1);
    assert_eq!(all[0], ParsedChunk::AgentMessage(msg));
}

#[test]
fn osc_split_byte_by_byte() {
    let msg = AgentUiMessage::Progress {
        pct: 99,
        message: "almost".into(),
    };
    let encoded = encode(&msg);

    let mut parser = OscParser::new();
    let mut all_chunks = Vec::new();
    for &byte in &encoded {
        all_chunks.extend(parser.feed(&[byte]));
    }

    let messages: Vec<_> = all_chunks
        .into_iter()
        .filter(|c| matches!(c, ParsedChunk::AgentMessage(_)))
        .collect();

    assert_eq!(messages.len(), 1);
    assert_eq!(
        messages[0],
        ParsedChunk::AgentMessage(msg)
    );
}

#[test]
fn split_with_terminal_data_before_and_after() {
    let msg = AgentUiMessage::Status {
        phase: "test".into(),
        detail: None,
    };
    let osc = encode(&msg);

    let mut full = b"prefix ".to_vec();
    full.extend_from_slice(&osc);
    full.extend_from_slice(b" suffix");

    // Split right in the middle of the OSC.
    let split_point = 7 + osc.len() / 2; // "prefix " + half of OSC

    let mut parser = OscParser::new();
    let c1 = parser.feed(&full[..split_point]);
    let c2 = parser.feed(&full[split_point..]);

    let all: Vec<_> = c1.into_iter().chain(c2).collect();
    let has_prefix = all.iter().any(|c| matches!(c, ParsedChunk::TerminalData(d) if d == b"prefix "));
    let has_msg = all.iter().any(|c| matches!(c, ParsedChunk::AgentMessage(_)));
    let has_suffix = all.iter().any(|c| matches!(c, ParsedChunk::TerminalData(d) if d == b" suffix"));

    assert!(has_prefix, "should have prefix terminal data");
    assert!(has_msg, "should have agent message");
    assert!(has_suffix, "should have suffix terminal data");
}

// ── Malformed JSON ───────────────────────────────────────────────────

#[test]
fn malformed_json_emits_malformed_osc() {
    let data = b"\x1b]7770;{not valid json}\x07";
    let chunks = parse_all(data);

    assert_eq!(chunks.len(), 1);
    assert!(
        matches!(&chunks[0], ParsedChunk::MalformedOsc(_)),
        "expected MalformedOsc, got {:?}",
        chunks[0]
    );
}

#[test]
fn empty_payload_emits_malformed() {
    let data = b"\x1b]7770;\x07";
    let chunks = parse_all(data);

    assert_eq!(chunks.len(), 1);
    assert!(matches!(&chunks[0], ParsedChunk::MalformedOsc(_)));
}

// ── Non-7770 OSC passthrough ─────────────────────────────────────────

#[test]
fn non_7770_osc_passes_through_as_terminal_data() {
    // iTerm2-style OSC 1337
    let data = b"\x1b]1337;SetMark\x07rest";
    let chunks = parse_all(data);

    // Should come through as terminal data.
    let all_bytes: Vec<u8> = chunks
        .iter()
        .filter_map(|c| match c {
            ParsedChunk::TerminalData(d) => Some(d.clone()),
            _ => None,
        })
        .flatten()
        .collect();

    assert_eq!(all_bytes, data.to_vec());
}

#[test]
fn osc_52_passes_through() {
    let data = b"\x1b]52;c;SGVsbG8=\x07";
    let chunks = parse_all(data);

    let all_bytes: Vec<u8> = chunks
        .iter()
        .filter_map(|c| match c {
            ParsedChunk::TerminalData(d) => Some(d.clone()),
            _ => None,
        })
        .flatten()
        .collect();

    assert_eq!(all_bytes, data.to_vec());
}

// ── Oversized payload ────────────────────────────────────────────────

#[test]
fn oversized_payload_emits_malformed() {
    let mut data = b"\x1b]7770;".to_vec();
    // Fill with 65KB of 'a' bytes (exceeds 64KB limit).
    data.extend(std::iter::repeat(b'a').take(65 * 1024));
    data.push(0x07);

    let chunks = parse_all(&data);

    let has_malformed = chunks
        .iter()
        .any(|c| matches!(c, ParsedChunk::MalformedOsc(_)));
    assert!(has_malformed, "oversized payload should produce MalformedOsc");

    // Should NOT produce an AgentMessage.
    let has_agent = chunks
        .iter()
        .any(|c| matches!(c, ParsedChunk::AgentMessage(_)));
    assert!(!has_agent, "oversized payload should not produce AgentMessage");
}

// ── ST terminator (ESC \) ────────────────────────────────────────────

#[test]
fn st_terminator_works() {
    let msg = AgentUiMessage::Ready {
        agent: "st-test".into(),
        version: None,
    };
    let json = serde_json::to_string(&msg).unwrap();
    // Use ESC \ instead of BEL as terminator.
    let data = format!("\x1b]7770;{}\x1b\\", json);

    let chunks = parse_all(data.as_bytes());

    assert_eq!(chunks.len(), 1);
    assert_eq!(chunks[0], ParsedChunk::AgentMessage(msg));
}

// ── Roundtrip property ───────────────────────────────────────────────

#[test]
fn roundtrip_encode_parse() {
    let messages = vec![
        AgentUiMessage::Ready {
            agent: "roundtrip".into(),
            version: Some("2.0".into()),
        },
        AgentUiMessage::Status {
            phase: "working".into(),
            detail: Some("detail".into()),
        },
        AgentUiMessage::Progress {
            pct: 50,
            message: "half".into(),
        },
        AgentUiMessage::Finished {
            summary: "done".into(),
            exit_code: Some(0),
        },
        AgentUiMessage::ToolCall {
            id: "t1".into(),
            name: "grep".into(),
            args: json!({"pattern": "TODO"}),
        },
        AgentUiMessage::ToolResult {
            id: "t1".into(),
            result: json!(["match1", "match2"]),
            error: None,
        },
        AgentUiMessage::FileEdit {
            path: "a.rs".into(),
            diff: Some("diff".into()),
        },
        AgentUiMessage::FileCreate {
            path: "b.rs".into(),
        },
        AgentUiMessage::FileDelete {
            path: "c.rs".into(),
        },
        AgentUiMessage::Approval {
            id: "a1".into(),
            message: "ok?".into(),
            options: vec!["y".into(), "n".into()],
        },
        AgentUiMessage::Notification {
            level: "info".into(),
            message: "hello".into(),
        },
        AgentUiMessage::Widget {
            widget_type: "chart".into(),
            props: json!({"x": 1}),
        },
    ];

    for msg in messages {
        let encoded = encode(&msg);
        let chunks = parse_all(&encoded);
        assert_eq!(
            chunks,
            vec![ParsedChunk::AgentMessage(msg.clone())],
            "roundtrip failed for {:?}",
            msg
        );
    }
}

// ── Multiple messages in one buffer ──────────────────────────────────

#[test]
fn multiple_messages_in_single_read() {
    let msg1 = AgentUiMessage::Ready {
        agent: "a".into(),
        version: None,
    };
    let msg2 = AgentUiMessage::Status {
        phase: "b".into(),
        detail: None,
    };
    let msg3 = AgentUiMessage::Finished {
        summary: "c".into(),
        exit_code: Some(0),
    };

    let mut data = encode(&msg1);
    data.extend_from_slice(&encode(&msg2));
    data.extend_from_slice(&encode(&msg3));

    let chunks = parse_all(&data);
    assert_eq!(chunks.len(), 3);
    assert_eq!(chunks[0], ParsedChunk::AgentMessage(msg1));
    assert_eq!(chunks[1], ParsedChunk::AgentMessage(msg2));
    assert_eq!(chunks[2], ParsedChunk::AgentMessage(msg3));
}

// ── Edge cases: escape sequences ─────────────────────────────────────

#[test]
fn bare_esc_not_followed_by_bracket_passes_through() {
    // ESC followed by something other than ]
    let data = b"\x1b[31mred text\x1b[0m";
    let chunks = parse_all(data);

    let all_bytes: Vec<u8> = chunks
        .iter()
        .filter_map(|c| match c {
            ParsedChunk::TerminalData(d) => Some(d.clone()),
            _ => None,
        })
        .flatten()
        .collect();

    assert_eq!(all_bytes, data.to_vec());
}

#[test]
fn ansi_escape_sequences_pass_through_unmodified() {
    // Common ANSI: cursor movement, color codes.
    let data = b"\x1b[2J\x1b[H\x1b[1;32mgreen\x1b[0m";
    let chunks = parse_all(data);

    let all_bytes: Vec<u8> = chunks
        .iter()
        .filter_map(|c| match c {
            ParsedChunk::TerminalData(d) => Some(d.clone()),
            _ => None,
        })
        .flatten()
        .collect();

    assert_eq!(all_bytes, data.to_vec());
}
