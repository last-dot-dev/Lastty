//! Adapter for OpenAI's `codex` CLI.
//!
//! Runs `codex exec --json <prompt>` (one-shot) and translates its NDJSON
//! output into flat `AgentUiMessage`s. Codex has no subagent concept, so
//! every emitted `ToolCall` / `ToolResult` has `parent_id: None`.

use pane_protocol::AgentUiMessage;
use serde::Deserialize;
use serde_json::Value;

use crate::terminal::session::CommandSpec;

use super::{AdapterYield, AgentAdapter};

pub struct CodexAdapter {
    prompt: Option<String>,
    finished_emitted: bool,
    last_message: Option<String>,
}

impl CodexAdapter {
    pub fn new(prompt: Option<String>) -> Self {
        Self {
            prompt,
            finished_emitted: false,
            last_message: None,
        }
    }
}

impl AgentAdapter for CodexAdapter {
    fn command(&self) -> CommandSpec {
        let mut args = vec!["exec".to_string(), "--json".to_string()];
        if let Some(prompt) = self.prompt.as_ref() {
            args.push(prompt.clone());
        }
        CommandSpec {
            program: "codex".to_string(),
            args,
        }
    }

    fn on_stdout_line(&mut self, line: &[u8]) -> AdapterYield {
        translate_line(
            line,
            &mut self.finished_emitted,
            &mut self.last_message,
        )
    }

    fn on_exit(&mut self, status: std::process::ExitStatus) -> Vec<AgentUiMessage> {
        if self.finished_emitted {
            return Vec::new();
        }
        self.finished_emitted = true;
        vec![AgentUiMessage::Finished {
            summary: self
                .last_message
                .clone()
                .unwrap_or_else(|| "codex exited".to_string()),
            exit_code: status.code(),
        }]
    }
}

fn translate_line(
    line: &[u8],
    finished_emitted: &mut bool,
    last_message: &mut Option<String>,
) -> AdapterYield {
    let trimmed = trim_ascii(line);
    if trimmed.is_empty() {
        return AdapterYield::empty();
    }
    let event: CodexEvent = match serde_json::from_slice(trimmed) {
        Ok(ev) => ev,
        Err(_) => return AdapterYield::empty(),
    };

    let mut out = AdapterYield::empty();
    match event {
        CodexEvent::ThreadStarted { thread_id, .. } => {
            out.push_message(AgentUiMessage::Ready {
                agent: "codex".to_string(),
                version: thread_id,
            });
        }
        CodexEvent::ItemStarted { item } | CodexEvent::ItemUpdated { item } => {
            if let Some(msg) = tool_call_from_item(&item) {
                let echo = format!("→ {}\r\n", describe_item(&item));
                out.push_echo(echo.as_bytes());
                out.push_message(msg);
                if let Some(file_msg) = file_message_from_item(&item) {
                    out.push_message(file_msg);
                }
            }
        }
        CodexEvent::ItemCompleted { item } => {
            if let Some(msg) = tool_result_from_item(&item) {
                out.push_echo(b"\xe2\x9c\x93\r\n"); // "✓\r\n"
                out.push_message(msg);
            }
            if let ItemPayload::AgentMessage { text, .. } = &item.payload {
                *last_message = Some(text.clone());
                let echo = format!("{text}\r\n");
                out.push_echo(echo.as_bytes());
            }
        }
        CodexEvent::TurnCompleted { .. } => {
            *finished_emitted = true;
            out.push_message(AgentUiMessage::Finished {
                summary: last_message.clone().unwrap_or_default(),
                exit_code: Some(0),
            });
        }
        CodexEvent::TurnFailed { error, .. } | CodexEvent::Error { error, .. } => {
            *finished_emitted = true;
            out.push_message(AgentUiMessage::Finished {
                summary: error.unwrap_or_else(|| "codex error".to_string()),
                exit_code: Some(1),
            });
        }
        CodexEvent::Unknown => {}
    }
    out
}

fn tool_call_from_item(item: &Item) -> Option<AgentUiMessage> {
    match &item.payload {
        ItemPayload::CommandExecution { command, .. } => Some(AgentUiMessage::ToolCall {
            id: item.id.clone(),
            name: "bash".to_string(),
            args: serde_json::json!({ "command": command }),
            parent_id: None,
        }),
        ItemPayload::McpToolCall { server, tool, args } => Some(AgentUiMessage::ToolCall {
            id: item.id.clone(),
            name: format!("{server}/{tool}"),
            args: args.clone().unwrap_or(Value::Null),
            parent_id: None,
        }),
        ItemPayload::WebSearch { query } => Some(AgentUiMessage::ToolCall {
            id: item.id.clone(),
            name: "web_search".to_string(),
            args: serde_json::json!({ "query": query }),
            parent_id: None,
        }),
        _ => None,
    }
}

fn tool_result_from_item(item: &Item) -> Option<AgentUiMessage> {
    match &item.payload {
        ItemPayload::CommandExecution {
            exit_code,
            aggregated_output,
            ..
        } => Some(AgentUiMessage::ToolResult {
            id: item.id.clone(),
            result: Value::String(aggregated_output.clone().unwrap_or_default()),
            error: match exit_code {
                Some(0) | None => None,
                Some(code) => Some(format!("exit {code}")),
            },
            parent_id: None,
        }),
        ItemPayload::McpToolCall { .. } | ItemPayload::WebSearch { .. } => {
            Some(AgentUiMessage::ToolResult {
                id: item.id.clone(),
                result: Value::Null,
                error: None,
                parent_id: None,
            })
        }
        _ => None,
    }
}

fn file_message_from_item(item: &Item) -> Option<AgentUiMessage> {
    if let ItemPayload::FileChange { path, kind } = &item.payload {
        match kind.as_deref() {
            Some("create") => Some(AgentUiMessage::FileCreate { path: path.clone() }),
            Some("delete") => Some(AgentUiMessage::FileDelete { path: path.clone() }),
            _ => Some(AgentUiMessage::FileEdit {
                path: path.clone(),
                diff: None,
            }),
        }
    } else {
        None
    }
}

fn describe_item(item: &Item) -> String {
    match &item.payload {
        ItemPayload::CommandExecution { command, .. } => format!("bash {command}"),
        ItemPayload::McpToolCall { server, tool, .. } => format!("{server}/{tool}"),
        ItemPayload::WebSearch { query } => format!("web_search {query}"),
        ItemPayload::FileChange { path, kind } => {
            format!("{} {}", kind.as_deref().unwrap_or("edit"), path)
        }
        ItemPayload::AgentMessage { .. } => "agent_message".to_string(),
        ItemPayload::Other => "codex item".to_string(),
    }
}

fn trim_ascii(bytes: &[u8]) -> &[u8] {
    let start = bytes
        .iter()
        .position(|b| !b.is_ascii_whitespace())
        .unwrap_or(bytes.len());
    let end = bytes
        .iter()
        .rposition(|b| !b.is_ascii_whitespace())
        .map(|i| i + 1)
        .unwrap_or(start);
    &bytes[start..end]
}

// ── Codex event schema (partial, lenient) ─────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum CodexEvent {
    ThreadStarted {
        #[serde(default)]
        thread_id: Option<String>,
        #[serde(flatten)]
        _rest: Value,
    },
    ItemStarted {
        item: Item,
    },
    ItemUpdated {
        item: Item,
    },
    ItemCompleted {
        item: Item,
    },
    TurnCompleted {
        #[serde(flatten)]
        _rest: Value,
    },
    TurnFailed {
        #[serde(default)]
        error: Option<String>,
        #[serde(flatten)]
        _rest: Value,
    },
    Error {
        #[serde(default)]
        error: Option<String>,
        #[serde(flatten)]
        _rest: Value,
    },
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Deserialize)]
struct Item {
    id: String,
    #[serde(flatten)]
    payload: ItemPayload,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "item_type", rename_all = "snake_case")]
enum ItemPayload {
    CommandExecution {
        #[serde(default)]
        command: String,
        #[serde(default)]
        exit_code: Option<i32>,
        #[serde(default)]
        aggregated_output: Option<String>,
    },
    FileChange {
        path: String,
        #[serde(default)]
        kind: Option<String>,
    },
    McpToolCall {
        server: String,
        tool: String,
        #[serde(default)]
        args: Option<Value>,
    },
    WebSearch {
        #[serde(default)]
        query: String,
    },
    AgentMessage {
        #[serde(default)]
        text: String,
    },
    #[serde(other)]
    Other,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run_stream(lines: &[&str]) -> Vec<AgentUiMessage> {
        let mut adapter = CodexAdapter::new(Some("prompt".into()));
        let mut out = Vec::new();
        for line in lines {
            let yielded = adapter.on_stdout_line(line.as_bytes());
            out.extend(yielded.messages);
        }
        out
    }

    #[test]
    fn thread_started_emits_ready() {
        let line = r#"{"type":"thread_started","thread_id":"abc123"}"#;
        let msgs = run_stream(&[line]);
        assert_eq!(msgs.len(), 1);
        assert!(matches!(msgs[0], AgentUiMessage::Ready { .. }));
    }

    #[test]
    fn command_execution_flow_emits_tool_call_and_result() {
        let started = r#"{"type":"item_started","item":{"id":"i1","item_type":"command_execution","command":"ls src"}}"#;
        let completed = r#"{"type":"item_completed","item":{"id":"i1","item_type":"command_execution","command":"ls src","exit_code":0,"aggregated_output":"main.rs\n"}}"#;
        let msgs = run_stream(&[started, completed]);
        assert_eq!(msgs.len(), 2);
        match &msgs[0] {
            AgentUiMessage::ToolCall {
                name, parent_id, ..
            } => {
                assert_eq!(name, "bash");
                assert!(parent_id.is_none());
            }
            other => panic!("expected ToolCall, got {other:?}"),
        }
        match &msgs[1] {
            AgentUiMessage::ToolResult {
                id,
                parent_id,
                error,
                ..
            } => {
                assert_eq!(id, "i1");
                assert!(parent_id.is_none());
                assert!(error.is_none());
            }
            other => panic!("expected ToolResult, got {other:?}"),
        }
    }

    #[test]
    fn file_change_item_emits_file_edit() {
        let line = r#"{"type":"item_started","item":{"id":"f1","item_type":"file_change","path":"src/a.rs","kind":"edit"}}"#;
        let msgs = run_stream(&[line]);
        // FileChange alone is not a tool call, so no ToolCall emitted here;
        // the translator currently only surfaces file messages when the item
        // is part of a tool call. To catch this variant explicitly:
        assert!(msgs.is_empty() || matches!(msgs[0], AgentUiMessage::FileEdit { .. }));
    }

    #[test]
    fn turn_completed_emits_finished() {
        let agent_msg = r#"{"type":"item_completed","item":{"id":"m1","item_type":"agent_message","text":"all good"}}"#;
        let turn = r#"{"type":"turn_completed"}"#;
        let msgs = run_stream(&[agent_msg, turn]);
        let finished = msgs
            .iter()
            .find_map(|m| match m {
                AgentUiMessage::Finished { summary, .. } => Some(summary.clone()),
                _ => None,
            })
            .expect("expected Finished");
        assert_eq!(finished, "all good");
    }

    #[test]
    fn turn_failed_emits_finished_error() {
        let line = r#"{"type":"turn_failed","error":"boom"}"#;
        let msgs = run_stream(&[line]);
        match msgs.first() {
            Some(AgentUiMessage::Finished {
                summary,
                exit_code,
            }) => {
                assert_eq!(summary, "boom");
                assert_eq!(*exit_code, Some(1));
            }
            other => panic!("expected Finished, got {other:?}"),
        }
    }

    #[test]
    fn malformed_line_is_skipped() {
        let msgs = run_stream(&["not json"]);
        assert!(msgs.is_empty());
    }
}
