use std::io::{BufRead, Write};

use pane_protocol::{Addr, PeerMessage, Presence};
use serde::Deserialize;
use serde_json::{json, Value};

const PROTOCOL_VERSION: &str = "2024-11-05";
const SERVER_NAME: &str = "lastty-mcp";
const SERVER_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Deserialize)]
struct Request {
    #[serde(default)]
    id: Option<Value>,
    method: String,
    #[serde(default)]
    params: Value,
}

enum Outcome {
    Ok(Value),
    Err { code: i64, message: String },
    Silent,
}

pub(crate) fn run() -> ! {
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut out = stdout.lock();

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let (id, outcome) = match serde_json::from_str::<Request>(trimmed) {
            Ok(req) => (req.id.clone(), dispatch(&req)),
            Err(e) => (
                None,
                Outcome::Err {
                    code: -32700,
                    message: format!("parse error: {e}"),
                },
            ),
        };

        let envelope = match (id, outcome) {
            (Some(id), Outcome::Ok(result)) => {
                Some(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
            }
            (Some(id), Outcome::Err { code, message }) => Some(
                json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } }),
            ),
            _ => None,
        };

        if let Some(msg) = envelope {
            if writeln!(out, "{}", msg).is_err() {
                break;
            }
            let _ = out.flush();
        }
    }
    std::process::exit(0);
}

fn dispatch(req: &Request) -> Outcome {
    match req.method.as_str() {
        "initialize" => Outcome::Ok(json!({
            "protocolVersion": PROTOCOL_VERSION,
            "serverInfo": { "name": SERVER_NAME, "version": SERVER_VERSION },
            "capabilities": { "tools": {} }
        })),
        "notifications/initialized" | "notifications/cancelled" => Outcome::Silent,
        "ping" => Outcome::Ok(json!({})),
        "tools/list" => Outcome::Ok(json!({ "tools": tool_manifest() })),
        "tools/call" => call_tool(&req.params),
        other => Outcome::Err {
            code: -32601,
            message: format!("method not found: {other}"),
        },
    }
}

fn tool_manifest() -> Vec<Value> {
    vec![
        json!({
            "name": "peer_post",
            "description": "Post a message to a channel. Every subscriber receives it. Fire-and-forget — no reply expected.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "channel": { "type": "string", "description": "Channel name (e.g. 'general', 'review')." },
                    "text": { "type": "string", "description": "Message body." }
                },
                "required": ["channel", "text"]
            }
        }),
        json!({
            "name": "peer_dm",
            "description": "Send a direct message to a specific peer (a session, an agent kind as a broadcast, or the user). Fire-and-forget — no reply expected. Use peer_request when you need an answer.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "to_kind": {
                        "type": "string",
                        "enum": ["session", "agent", "user"],
                        "description": "Recipient kind. 'session' = a specific pane's session id. 'agent' = broadcast to every live pane of that agent kind. 'user' = the human."
                    },
                    "to_id": { "type": "string", "description": "Session UUID or agent kind. Omit when to_kind is 'user'." },
                    "text": { "type": "string", "description": "Message body." }
                },
                "required": ["to_kind", "text"]
            }
        }),
        json!({
            "name": "peer_join",
            "description": "Subscribe to a channel. You will receive the ring-buffer replay (up to 50 recent messages) on join, then live posts.",
            "inputSchema": {
                "type": "object",
                "properties": { "channel": { "type": "string" } },
                "required": ["channel"]
            }
        }),
        json!({
            "name": "peer_leave",
            "description": "Unsubscribe from a channel.",
            "inputSchema": {
                "type": "object",
                "properties": { "channel": { "type": "string" } },
                "required": ["channel"]
            }
        }),
        json!({
            "name": "peer_presence",
            "description": "Broadcast your presence status so other agents and the UI know what you're doing.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "status": { "type": "string", "enum": ["thinking", "waiting", "idle", "done"] }
                },
                "required": ["status"]
            }
        }),
    ]
}

fn call_tool(params: &Value) -> Outcome {
    let name = params.get("name").and_then(Value::as_str).unwrap_or("");
    let empty = json!({});
    let args = params.get("arguments").unwrap_or(&empty);

    match build_message(name, args) {
        Ok(msg) => match crate::socket::send(&msg) {
            Ok(()) => Outcome::Ok(tool_ok("ok")),
            Err(e) => Outcome::Ok(tool_error(&format!("send failed: {e}"))),
        },
        Err(e) => Outcome::Ok(tool_error(&e)),
    }
}

fn tool_ok(text: &str) -> Value {
    json!({ "content": [{ "type": "text", "text": text }] })
}

fn tool_error(text: &str) -> Value {
    json!({ "isError": true, "content": [{ "type": "text", "text": text }] })
}

fn build_message(name: &str, args: &Value) -> Result<PeerMessage, String> {
    let str_field = |k: &str| -> Result<&str, String> {
        args.get(k)
            .and_then(Value::as_str)
            .ok_or_else(|| format!("missing or non-string field '{k}'"))
    };
    match name {
        "peer_post" => Ok(PeerMessage::Post {
            channel: str_field("channel")?.to_string(),
            body: json!({ "text": str_field("text")? }),
            reply_to: None,
        }),
        "peer_dm" => {
            let kind = str_field("to_kind")?;
            let text = str_field("text")?;
            let to = match kind {
                "session" => Addr::Session(str_field("to_id")?.to_string()),
                "agent" => Addr::Agent(str_field("to_id")?.to_string()),
                "user" => Addr::User,
                other => return Err(format!("unknown to_kind '{other}'")),
            };
            Ok(PeerMessage::Dm {
                to,
                body: json!({ "text": text }),
                correlation_id: None,
            })
        }
        "peer_join" => Ok(PeerMessage::Join {
            channel: str_field("channel")?.to_string(),
        }),
        "peer_leave" => Ok(PeerMessage::Leave {
            channel: str_field("channel")?.to_string(),
        }),
        "peer_presence" => {
            let status = match str_field("status")? {
                "thinking" => Presence::Thinking,
                "waiting" => Presence::Waiting,
                "idle" => Presence::Idle,
                "done" => Presence::Done,
                other => return Err(format!("unknown status '{other}'")),
            };
            Ok(PeerMessage::Presence { status })
        }
        other => Err(format!("unknown tool: {other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_exposes_five_tools() {
        let names: Vec<String> = tool_manifest()
            .iter()
            .filter_map(|t| t.get("name").and_then(Value::as_str).map(str::to_string))
            .collect();
        assert_eq!(
            names,
            vec![
                "peer_post",
                "peer_dm",
                "peer_join",
                "peer_leave",
                "peer_presence"
            ],
        );
    }

    #[test]
    fn builds_post_message() {
        let msg =
            build_message("peer_post", &json!({ "channel": "general", "text": "hi" })).unwrap();
        assert_eq!(
            msg,
            PeerMessage::Post {
                channel: "general".into(),
                body: json!({ "text": "hi" }),
                reply_to: None,
            }
        );
    }

    #[test]
    fn builds_dm_to_each_addr_kind() {
        let session = build_message(
            "peer_dm",
            &json!({ "to_kind": "session", "to_id": "abc", "text": "t" }),
        )
        .unwrap();
        let agent = build_message(
            "peer_dm",
            &json!({ "to_kind": "agent", "to_id": "codex", "text": "t" }),
        )
        .unwrap();
        let user = build_message("peer_dm", &json!({ "to_kind": "user", "text": "t" })).unwrap();
        assert!(matches!(
            session,
            PeerMessage::Dm { to: Addr::Session(ref s), .. } if s == "abc"
        ));
        assert!(matches!(
            agent,
            PeerMessage::Dm { to: Addr::Agent(ref a), .. } if a == "codex"
        ));
        assert!(matches!(user, PeerMessage::Dm { to: Addr::User, .. }));
    }

    #[test]
    fn dm_rejects_unknown_to_kind() {
        let err = build_message(
            "peer_dm",
            &json!({ "to_kind": "ghost", "to_id": "x", "text": "t" }),
        )
        .unwrap_err();
        assert!(err.contains("ghost"));
    }

    #[test]
    fn missing_required_field_errors() {
        let err = build_message("peer_post", &json!({ "channel": "general" })).unwrap_err();
        assert!(err.contains("text"));
    }

    #[test]
    fn presence_maps_all_statuses() {
        for (input, expected) in [
            ("thinking", Presence::Thinking),
            ("waiting", Presence::Waiting),
            ("idle", Presence::Idle),
            ("done", Presence::Done),
        ] {
            let msg = build_message("peer_presence", &json!({ "status": input })).unwrap();
            assert_eq!(msg, PeerMessage::Presence { status: expected });
        }
    }

    #[test]
    fn initialize_returns_protocol_and_capabilities() {
        let req = Request {
            id: Some(json!(1)),
            method: "initialize".to_string(),
            params: json!({}),
        };
        let outcome = dispatch(&req);
        let Outcome::Ok(val) = outcome else {
            panic!("expected Ok")
        };
        assert_eq!(
            val.get("protocolVersion").and_then(Value::as_str),
            Some(PROTOCOL_VERSION)
        );
        assert!(val
            .get("capabilities")
            .and_then(|c| c.get("tools"))
            .is_some());
    }

    #[test]
    fn notifications_are_silent() {
        let req = Request {
            id: None,
            method: "notifications/initialized".to_string(),
            params: json!({}),
        };
        assert!(matches!(dispatch(&req), Outcome::Silent));
    }

    #[test]
    fn unknown_method_is_method_not_found() {
        let req = Request {
            id: Some(json!(1)),
            method: "lolwut".to_string(),
            params: json!({}),
        };
        match dispatch(&req) {
            Outcome::Err { code, .. } => assert_eq!(code, -32601),
            _ => panic!("expected Err"),
        }
    }
}
