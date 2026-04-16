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
    },
    ToolResult {
        id: String,
        result: Value,
        error: Option<String>,
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
