use pane_protocol::encoder::encode_with_namespace;
use pane_protocol::{constants::OSC_APP_TO_AGENT, AgentUiMessage, PeerMessage};
use tauri::Runtime;

use crate::terminal::manager::TerminalManager;
use crate::terminal::session::SessionId;

/// Deliver a peer message to a specific session over OSC 7771.
///
/// Transport selection happens here. Block B: OSC only. Block D will add a
/// socket branch before the OSC fallback.
pub(crate) fn deliver<R: Runtime>(
    manager: &TerminalManager<R>,
    session_id: &SessionId,
    message: &PeerMessage,
) {
    let Some(session) = manager.get(session_id) else {
        return;
    };
    let wrapped = AgentUiMessage::Peer(message.clone());
    let bytes = encode_with_namespace(&wrapped, OSC_APP_TO_AGENT);
    let _ = session.write(&bytes);
}

/// Fan-out helper: deliver `message` to every session id in `recipients`,
/// skipping the sender's own session.
pub(crate) fn fanout<R: Runtime>(
    manager: &TerminalManager<R>,
    source_session_id: &str,
    recipients: impl IntoIterator<Item = String>,
    message: &PeerMessage,
) {
    for rid in recipients {
        if rid == source_session_id {
            continue;
        }
        if let Ok(sid) = SessionId::parse(&rid) {
            deliver(manager, &sid, message);
        }
    }
}
