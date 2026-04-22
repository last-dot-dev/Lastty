use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Identifies a peer — a specific session, an agent type (broadcast), a channel, or the user.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "kind", content = "id", rename_all = "snake_case")]
pub enum Addr {
    /// Exact session (UUID as string).
    Session(String),
    /// All live sessions of the given agent id — fan-out.
    Agent(String),
    /// Pub/sub channel by name.
    Channel(String),
    /// The human user.
    #[serde(with = "unit_tag")]
    User,
}

impl Addr {
    pub fn agent_id(&self) -> Option<&str> {
        match self {
            Addr::Agent(id) => Some(id),
            _ => None,
        }
    }

    pub fn channel(&self) -> Option<&str> {
        match self {
            Addr::Channel(name) => Some(name),
            _ => None,
        }
    }

    pub fn is_user(&self) -> bool {
        matches!(self, Addr::User)
    }
}

/// Peer presence status.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Presence {
    Thinking,
    Waiting,
    Idle,
    Done,
}

impl Presence {
    pub fn as_str(self) -> &'static str {
        match self {
            Presence::Thinking => "thinking",
            Presence::Waiting => "waiting",
            Presence::Idle => "idle",
            Presence::Done => "done",
        }
    }
}

/// A peer message on the wire.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PeerMessage {
    /// Direct message to a specific addressable peer.
    Dm {
        to: Addr,
        body: Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        correlation_id: Option<String>,
    },
    /// Broadcast to a channel. Implicit subscription: senders need not `Join` first.
    Post {
        channel: String,
        body: Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reply_to: Option<String>,
    },
    /// Subscribe to a channel; recipient gets ring-buffer replay.
    Join { channel: String },
    /// Unsubscribe from a channel.
    Leave { channel: String },
    /// Announce current presence status.
    Presence { status: Presence },
    /// Reply to a prior `Dm` with matching `correlation_id`.
    Reply {
        correlation_id: String,
        body: Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
}

impl PeerMessage {
    /// Tag string matching the rule-filter `kind` dimension.
    pub fn kind(&self) -> &'static str {
        match self {
            PeerMessage::Dm { .. } => "dm",
            PeerMessage::Post { .. } => "post",
            PeerMessage::Join { .. } => "join",
            PeerMessage::Leave { .. } => "leave",
            PeerMessage::Presence { .. } => "presence",
            PeerMessage::Reply { .. } => "reply",
        }
    }
}

// Custom serde shim so `Addr::User` serializes as `{"kind":"user"}` with no `id` field,
// matching the README-style expectation `{kind: "user"}` rather than `{kind:"user",id:null}`.
mod unit_tag {
    use serde::{Deserializer, Serializer};
    pub fn serialize<S: Serializer>(serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_unit()
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<(), D::Error> {
        serde::de::Deserialize::deserialize(deserializer)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn dm_roundtrip() {
        let msg = PeerMessage::Dm {
            to: Addr::Session("abc".into()),
            body: json!({"text": "hi"}),
            correlation_id: Some("c1".into()),
        };
        let raw = serde_json::to_string(&msg).unwrap();
        let back: PeerMessage = serde_json::from_str(&raw).unwrap();
        assert_eq!(msg, back);
    }

    #[test]
    fn user_addr_serializes_flat() {
        let msg = PeerMessage::Dm {
            to: Addr::User,
            body: json!({}),
            correlation_id: None,
        };
        let raw = serde_json::to_string(&msg).unwrap();
        assert!(raw.contains("\"kind\":\"user\""));
        let back: PeerMessage = serde_json::from_str(&raw).unwrap();
        assert_eq!(msg, back);
    }

    #[test]
    fn post_with_reply_to() {
        let msg = PeerMessage::Post {
            channel: "review".into(),
            body: json!("looks good"),
            reply_to: Some("m1".into()),
        };
        let back: PeerMessage =
            serde_json::from_str(&serde_json::to_string(&msg).unwrap()).unwrap();
        assert_eq!(msg, back);
    }

    #[test]
    fn presence_roundtrip() {
        let msg = PeerMessage::Presence {
            status: Presence::Thinking,
        };
        let raw = serde_json::to_string(&msg).unwrap();
        assert!(raw.contains("\"status\":\"thinking\""));
        let back: PeerMessage = serde_json::from_str(&raw).unwrap();
        assert_eq!(msg, back);
    }

    #[test]
    fn addr_channel_helper() {
        assert_eq!(Addr::Channel("x".into()).channel(), Some("x"));
        assert_eq!(Addr::User.channel(), None);
    }
}
