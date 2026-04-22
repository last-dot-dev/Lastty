use std::io::Write;
use std::os::unix::net::UnixStream;

use pane_protocol::PeerMessage;

fn usage() -> ! {
    eprintln!(
        "usage: lastty-peer <command> [args]

commands:
  post <channel> <text>     post a message to a channel
  dm <session|agent> <text> send a direct message
  join <channel>            subscribe to a channel
  leave <channel>           unsubscribe from a channel
  presence <status>         set presence (thinking|waiting|idle|done)

$PANE_CONTROL_SOCKET must be set (Lastty sets this automatically)."
    );
    std::process::exit(1);
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();

    let socket_path = std::env::var("PANE_CONTROL_SOCKET").unwrap_or_else(|_| {
        eprintln!("lastty-peer: PANE_CONTROL_SOCKET not set");
        std::process::exit(1);
    });

    let msg = match args.as_slice() {
        [cmd, channel, text] if cmd == "post" => PeerMessage::Post {
            channel: channel.clone(),
            body: serde_json::json!({ "text": text }),
            reply_to: None,
        },
        [cmd, channel] if cmd == "join" => PeerMessage::Join {
            channel: channel.clone(),
        },
        [cmd, channel] if cmd == "leave" => PeerMessage::Leave {
            channel: channel.clone(),
        },
        [cmd, status] if cmd == "presence" => {
            let status = match status.as_str() {
                "thinking" => pane_protocol::Presence::Thinking,
                "waiting" => pane_protocol::Presence::Waiting,
                "idle" => pane_protocol::Presence::Idle,
                "done" => pane_protocol::Presence::Done,
                other => {
                    eprintln!("lastty-peer: unknown presence status '{other}'");
                    std::process::exit(1);
                }
            };
            PeerMessage::Presence { status }
        }
        [cmd, target, text] if cmd == "dm" => PeerMessage::Dm {
            to: pane_protocol::Addr::Agent(target.clone()),
            body: serde_json::json!({ "text": text }),
            correlation_id: None,
        },
        _ => usage(),
    };

    let json = serde_json::to_string(&msg).expect("PeerMessage always serializes");
    let mut stream = UnixStream::connect(&socket_path).unwrap_or_else(|e| {
        eprintln!("lastty-peer: cannot connect to {socket_path}: {e}");
        std::process::exit(1);
    });
    stream
        .write_all(json.as_bytes())
        .and_then(|_| stream.write_all(b"\n"))
        .unwrap_or_else(|e| {
            eprintln!("lastty-peer: write failed: {e}");
            std::process::exit(1);
        });
}
