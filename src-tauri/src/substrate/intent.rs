use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::ids::{AppId, IntentId};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Intent {
    pub id: IntentId,
    pub target: AppId,
    pub sender: Option<AppId>,
    pub verb: String,
    pub payload: Value,
}

impl Intent {
    pub fn new(target: AppId, verb: impl Into<String>, payload: Value) -> Self {
        Self {
            id: IntentId::new(),
            target,
            sender: None,
            verb: verb.into(),
            payload,
        }
    }

    pub fn with_sender(mut self, sender: AppId) -> Self {
        self.sender = Some(sender);
        self
    }
}

#[derive(Debug, thiserror::Error)]
pub enum IntentError {
    #[error("unknown verb: {0}")]
    UnknownVerb(String),
    #[error("invalid payload for {verb}: {reason}")]
    InvalidPayload { verb: String, reason: String },
    #[error("target app not found: {0}")]
    TargetNotFound(AppId),
}
