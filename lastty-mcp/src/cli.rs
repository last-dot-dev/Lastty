use pane_protocol::{Addr, PeerMessage, Presence};

pub(crate) fn run(args: &[String]) -> ! {
    let msg = match parse(args) {
        Ok(m) => m,
        Err(ParseError::Usage) => usage(),
        Err(ParseError::Msg(m)) => {
            eprintln!("lastty-mcp: {m}");
            std::process::exit(1);
        }
    };
    match crate::socket::send(&msg) {
        Ok(()) => std::process::exit(0),
        Err(e) => {
            eprintln!("lastty-mcp: {e}");
            std::process::exit(1);
        }
    }
}

#[derive(Debug)]
enum ParseError {
    Usage,
    Msg(String),
}

fn parse(args: &[String]) -> Result<PeerMessage, ParseError> {
    let slice: Vec<&str> = args.iter().map(String::as_str).collect();
    match slice.as_slice() {
        ["post", channel, text] => Ok(PeerMessage::Post {
            channel: (*channel).to_string(),
            body: serde_json::json!({ "text": text }),
            reply_to: None,
        }),
        ["join", channel] => Ok(PeerMessage::Join {
            channel: (*channel).to_string(),
        }),
        ["leave", channel] => Ok(PeerMessage::Leave {
            channel: (*channel).to_string(),
        }),
        ["presence", status] => match *status {
            "thinking" => Ok(PeerMessage::Presence {
                status: Presence::Thinking,
            }),
            "waiting" => Ok(PeerMessage::Presence {
                status: Presence::Waiting,
            }),
            "idle" => Ok(PeerMessage::Presence {
                status: Presence::Idle,
            }),
            "done" => Ok(PeerMessage::Presence {
                status: Presence::Done,
            }),
            other => Err(ParseError::Msg(format!(
                "unknown presence status '{other}'"
            ))),
        },
        ["dm", target, text] => Ok(PeerMessage::Dm {
            to: Addr::Agent((*target).to_string()),
            body: serde_json::json!({ "text": text }),
            correlation_id: None,
        }),
        _ => Err(ParseError::Usage),
    }
}

fn usage() -> ! {
    eprintln!(
        "usage: lastty-mcp [--stdio] | <command> [args]

modes:
  (no args) | --stdio         run as an MCP stdio server (spawned by MCP clients)

one-shot commands:
  post <channel> <text>       post a message to a channel
  dm <session|agent> <text>   send a direct message to an agent kind
  join <channel>              subscribe to a channel
  leave <channel>             unsubscribe from a channel
  presence <status>           set presence (thinking|waiting|idle|done)

$PANE_CONTROL_SOCKET must be set for one-shot commands (Lastty sets this automatically)."
    );
    std::process::exit(1);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn parses_post() {
        let msg = parse(&args(&["post", "general", "hello"])).unwrap();
        assert_eq!(
            msg,
            PeerMessage::Post {
                channel: "general".into(),
                body: serde_json::json!({ "text": "hello" }),
                reply_to: None,
            }
        );
    }

    #[test]
    fn parses_dm_as_agent_target() {
        let msg = parse(&args(&["dm", "codex", "ping"])).unwrap();
        assert_eq!(
            msg,
            PeerMessage::Dm {
                to: Addr::Agent("codex".into()),
                body: serde_json::json!({ "text": "ping" }),
                correlation_id: None,
            }
        );
    }

    #[test]
    fn parses_join_and_leave() {
        assert_eq!(
            parse(&args(&["join", "review"])).unwrap(),
            PeerMessage::Join {
                channel: "review".into()
            }
        );
        assert_eq!(
            parse(&args(&["leave", "review"])).unwrap(),
            PeerMessage::Leave {
                channel: "review".into()
            }
        );
    }

    #[test]
    fn parses_all_presence_values() {
        for (input, expected) in [
            ("thinking", Presence::Thinking),
            ("waiting", Presence::Waiting),
            ("idle", Presence::Idle),
            ("done", Presence::Done),
        ] {
            assert_eq!(
                parse(&args(&["presence", input])).unwrap(),
                PeerMessage::Presence { status: expected }
            );
        }
    }

    #[test]
    fn rejects_unknown_presence() {
        assert!(matches!(
            parse(&args(&["presence", "dancing"])),
            Err(ParseError::Msg(_))
        ));
    }

    #[test]
    fn rejects_unknown_command() {
        assert!(matches!(
            parse(&args(&["wiggle", "x", "y"])),
            Err(ParseError::Usage)
        ));
    }
}
