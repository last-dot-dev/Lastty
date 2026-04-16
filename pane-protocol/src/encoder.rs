use crate::constants::{BEL, OSC_AGENT_TO_APP, OSC_APP_TO_AGENT};
use crate::message::AgentUiMessage;

/// Encode an agent UI message into an OSC 7770 envelope.
///
/// Format: `\x1b]7770;{json}\x07`
pub fn encode(msg: &AgentUiMessage) -> Vec<u8> {
    encode_with_namespace(msg, OSC_AGENT_TO_APP)
}

/// Encode an agent UI message with a specific OSC namespace.
pub fn encode_with_namespace(msg: &AgentUiMessage, namespace: &str) -> Vec<u8> {
    let json = serde_json::to_string(msg).expect("AgentUiMessage should always serialize");
    let mut buf = Vec::with_capacity(4 + namespace.len() + json.len());
    buf.push(0x1b); // ESC
    buf.push(b']');
    buf.extend_from_slice(namespace.as_bytes());
    buf.push(b';');
    buf.extend_from_slice(json.as_bytes());
    buf.push(BEL);
    buf
}

/// Encode a response from the app to an agent via OSC 7771.
pub fn encode_app_to_agent(msg: &AgentUiMessage) -> Vec<u8> {
    encode_with_namespace(msg, OSC_APP_TO_AGENT)
}
