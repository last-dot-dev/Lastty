use std::io::Write;
use std::os::unix::net::UnixStream;

use pane_protocol::PeerMessage;

pub(crate) fn send(message: &PeerMessage) -> Result<(), String> {
    let socket_path = std::env::var("PANE_CONTROL_SOCKET")
        .map_err(|_| "PANE_CONTROL_SOCKET not set".to_string())?;
    let json = serde_json::to_string(message).map_err(|e| format!("serialize: {e}"))?;
    let mut stream =
        UnixStream::connect(&socket_path).map_err(|e| format!("connect to {socket_path}: {e}"))?;
    stream
        .write_all(json.as_bytes())
        .and_then(|_| stream.write_all(b"\n"))
        .map_err(|e| format!("write: {e}"))
}
