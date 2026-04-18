use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Messages sent from an agent to the host app via OSC 7770.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "data")]
pub enum AgentUiMessage {
    // Agent lifecycle
    Ready {
        agent: String,
        version: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        session_id: Option<String>,
    },
    Status {
        phase: String,
        detail: Option<String>,
    },
    Progress {
        pct: u8,
        message: String,
    },
    Finished {
        summary: String,
        exit_code: Option<i32>,
    },

    // Tool visibility
    ToolCall {
        id: String,
        name: String,
        args: Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        parent_id: Option<String>,
    },
    ToolResult {
        id: String,
        result: Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        parent_id: Option<String>,
    },

    // File operations
    FileEdit {
        path: String,
        diff: Option<String>,
    },
    FileCreate {
        path: String,
    },
    FileDelete {
        path: String,
    },

    // User interaction
    Approval {
        id: String,
        message: String,
        options: Vec<String>,
    },
    Notification {
        level: String,
        message: String,
    },

    // Freeform widget (escape hatch)
    Widget {
        widget_type: String,
        props: Value,
    },
}
