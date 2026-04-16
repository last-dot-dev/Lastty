use serde::Serialize;

/// Event emitted when a terminal session exits.
#[derive(Debug, Clone, Serialize)]
pub struct SessionExitEvent {
    pub session_id: String,
    pub code: Option<i32>,
}

/// Event emitted when a terminal session's title changes.
#[derive(Debug, Clone, Serialize)]
pub struct SessionTitleEvent {
    pub session_id: String,
    pub title: String,
}

/// Event emitted when an agent UI message is intercepted.
#[derive(Debug, Clone, Serialize)]
pub struct AgentUiEvent {
    pub session_id: String,
    pub message: serde_json::Value,
}
