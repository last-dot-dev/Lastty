//! Adapter for Anthropic's `claude` CLI (Claude Code).
//!
//! Runs `claude -p --output-format stream-json --verbose <prompt>` and
//! translates the resulting NDJSON stream into `AgentUiMessage`s. Subagent
//! tool calls (invocations of the `Task` / `Agent` tool) are linked to
//! their parent via the stream's `parent_tool_use_id` field.

use pane_protocol::AgentUiMessage;
use serde::Deserialize;
use serde_json::Value;

use crate::terminal::session::CommandSpec;

use super::{AdapterYield, AgentAdapter};

pub struct ClaudeCodeAdapter {
    prompt: Option<String>,
    finished_emitted: bool,
}

impl ClaudeCodeAdapter {
    pub fn new(prompt: Option<String>) -> Self {
        Self {
            prompt,
            finished_emitted: false,
        }
    }
}

impl AgentAdapter for ClaudeCodeAdapter {
    fn command(&self) -> CommandSpec {
        let mut args = vec![
            "-p".to_string(),
            "--output-format".to_string(),
            "stream-json".to_string(),
            "--verbose".to_string(),
        ];
        if let Some(prompt) = self.prompt.as_ref() {
            args.push(prompt.clone());
        }
        CommandSpec {
            program: "claude".to_string(),
            args,
        }
    }

    fn on_stdout_line(&mut self, line: &[u8]) -> AdapterYield {
        translate_line(line, &mut self.finished_emitted)
    }

    fn on_exit(&mut self, status: std::process::ExitStatus) -> Vec<AgentUiMessage> {
        if self.finished_emitted {
            return Vec::new();
        }
        self.finished_emitted = true;
        vec![AgentUiMessage::Finished {
            summary: match status.code() {
                Some(0) => "claude exited".to_string(),
                Some(code) => format!("claude exited with code {code}"),
                None => "claude terminated".to_string(),
            },
            exit_code: status.code(),
        }]
    }
}

fn translate_line(line: &[u8], finished_emitted: &mut bool) -> AdapterYield {
    let trimmed = trim_ascii(line);
    if trimmed.is_empty() {
        return AdapterYield::empty();
    }
    let event: ClaudeEvent = match serde_json::from_slice(trimmed) {
        Ok(ev) => ev,
        Err(_) => return AdapterYield::empty(),
    };

    let mut out = AdapterYield::empty();
    match event {
        ClaudeEvent::System {
            subtype,
            model,
            session_id,
            ..
        } if subtype == "init" => {
            out.push_message(AgentUiMessage::Ready {
                agent: "claude".to_string(),
                version: model,
                session_id,
            });
        }
        ClaudeEvent::Assistant {
            message,
            parent_tool_use_id,
            ..
        } => translate_assistant(message, parent_tool_use_id, &mut out),
        ClaudeEvent::User {
            message,
            parent_tool_use_id,
            ..
        } => translate_user(message, parent_tool_use_id, &mut out),
        ClaudeEvent::Result {
            subtype,
            result,
            is_error,
            ..
        } => {
            *finished_emitted = true;
            let summary = result.unwrap_or_default();
            let exit_code = if is_error.unwrap_or(false) || subtype.as_deref() != Some("success") {
                Some(1)
            } else {
                Some(0)
            };
            out.push_message(AgentUiMessage::Finished { summary, exit_code });
        }
        _ => {}
    }
    out
}

fn translate_assistant(
    message: AssistantMessage,
    parent_tool_use_id: Option<String>,
    out: &mut AdapterYield,
) {
    for block in message.content {
        match block {
            ContentBlock::Text { text } => {
                let line = format!("{text}\r\n");
                out.push_echo(line.as_bytes());
            }
            ContentBlock::ToolUse { id, name, input } => {
                let echo = format!(
                    "→ {}{} {}\r\n",
                    if parent_tool_use_id.is_some() {
                        "  ↳ "
                    } else {
                        ""
                    },
                    name,
                    summarize_json(&input),
                );
                out.push_echo(echo.as_bytes());
                if let Some(file_msg) = file_message_for(&name, &input) {
                    out.push_message(file_msg);
                }
                out.push_message(AgentUiMessage::ToolCall {
                    id,
                    name,
                    args: input,
                    parent_id: parent_tool_use_id.clone(),
                });
            }
            _ => {}
        }
    }
}

fn translate_user(
    message: UserMessage,
    parent_tool_use_id: Option<String>,
    out: &mut AdapterYield,
) {
    for block in message.content {
        if let ContentBlock::ToolResult {
            tool_use_id,
            content,
            is_error,
        } = block
        {
            let error = if is_error.unwrap_or(false) {
                Some(stringify_content(&content))
            } else {
                None
            };
            let result = match &content {
                Value::Null => Value::String(String::new()),
                other => other.clone(),
            };
            let prefix = if parent_tool_use_id.is_some() {
                "  ↳ "
            } else {
                ""
            };
            let echo = format!("{prefix}✓ {} {}\r\n", tool_use_id, summarize_json(&result),);
            out.push_echo(echo.as_bytes());
            out.push_message(AgentUiMessage::ToolResult {
                id: tool_use_id,
                result,
                error,
                parent_id: parent_tool_use_id.clone(),
            });
        }
    }
}

fn file_message_for(name: &str, input: &Value) -> Option<AgentUiMessage> {
    match name {
        "Write" => {
            input
                .get("file_path")
                .and_then(Value::as_str)
                .map(|path| AgentUiMessage::FileCreate {
                    path: path.to_string(),
                })
        }
        "Edit" | "MultiEdit" => {
            input
                .get("file_path")
                .and_then(Value::as_str)
                .map(|path| AgentUiMessage::FileEdit {
                    path: path.to_string(),
                    diff: None,
                })
        }
        _ => None,
    }
}

fn summarize_json(value: &Value) -> String {
    let raw = match value {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    };
    const LIMIT: usize = 80;
    if raw.chars().count() <= LIMIT {
        raw
    } else {
        let mut truncated: String = raw.chars().take(LIMIT).collect();
        truncated.push('…');
        truncated
    }
}

fn stringify_content(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        other => other.to_string(),
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

// ── Claude Code stream-json schema (partial, lenient) ─────────────────

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ClaudeEvent {
    System {
        #[serde(default)]
        subtype: String,
        #[serde(default)]
        model: Option<String>,
        #[serde(default)]
        session_id: Option<String>,
        #[serde(flatten)]
        _rest: Value,
    },
    Assistant {
        message: AssistantMessage,
        #[serde(default)]
        parent_tool_use_id: Option<String>,
        #[serde(flatten)]
        _rest: Value,
    },
    User {
        message: UserMessage,
        #[serde(default)]
        parent_tool_use_id: Option<String>,
        #[serde(flatten)]
        _rest: Value,
    },
    Result {
        #[serde(default)]
        subtype: Option<String>,
        #[serde(default)]
        result: Option<String>,
        #[serde(default)]
        is_error: Option<bool>,
        #[serde(flatten)]
        _rest: Value,
    },
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Deserialize)]
struct AssistantMessage {
    #[serde(default)]
    content: Vec<ContentBlock>,
}

#[derive(Debug, Deserialize)]
struct UserMessage {
    #[serde(default)]
    content: Vec<ContentBlock>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ContentBlock {
    Text {
        text: String,
    },
    ToolUse {
        id: String,
        name: String,
        #[serde(default)]
        input: Value,
    },
    ToolResult {
        tool_use_id: String,
        #[serde(default)]
        content: Value,
        #[serde(default)]
        is_error: Option<bool>,
    },
    #[serde(other)]
    Unknown,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn run_stream(lines: &[&str]) -> Vec<AgentUiMessage> {
        let mut adapter = ClaudeCodeAdapter::new(Some("prompt".into()));
        let mut out = Vec::new();
        for line in lines {
            let yielded = adapter.on_stdout_line(line.as_bytes());
            out.extend(yielded.messages);
        }
        out
    }

    #[test]
    fn init_emits_ready() {
        let line =
            r#"{"type":"system","subtype":"init","session_id":"s1","model":"claude-opus-4-5"}"#;
        let msgs = run_stream(&[line]);
        assert_eq!(msgs.len(), 1);
        match &msgs[0] {
            AgentUiMessage::Ready { agent, version, session_id } => {
                assert_eq!(agent, "claude");
                assert_eq!(version.as_deref(), Some("claude-opus-4-5"));
                assert_eq!(session_id.as_deref(), Some("s1"));
            }
            other => panic!("expected Ready, got {other:?}"),
        }
    }

    #[test]
    fn tool_use_emits_tool_call_with_null_parent() {
        let line = r#"{"type":"assistant","session_id":"s1","parent_tool_use_id":null,"message":{"content":[{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"src/a.rs"}}]}}"#;
        let msgs = run_stream(&[line]);
        // One FileCreate-or-Edit check skipped: Read doesn't map to a file
        // message, so expect exactly one ToolCall.
        assert_eq!(msgs.len(), 1);
        match &msgs[0] {
            AgentUiMessage::ToolCall {
                id,
                name,
                args,
                parent_id,
            } => {
                assert_eq!(id, "t1");
                assert_eq!(name, "Read");
                assert_eq!(args, &json!({"file_path": "src/a.rs"}));
                assert!(parent_id.is_none());
            }
            other => panic!("expected ToolCall, got {other:?}"),
        }
    }

    #[test]
    fn subagent_tool_use_sets_parent_id() {
        let outer = r#"{"type":"assistant","session_id":"s","parent_tool_use_id":null,"message":{"content":[{"type":"tool_use","id":"task-1","name":"Agent","input":{"subagent_type":"general-purpose","prompt":"find TODOs"}}]}}"#;
        let inner = r#"{"type":"assistant","session_id":"s","parent_tool_use_id":"task-1","message":{"content":[{"type":"tool_use","id":"grep-1","name":"Grep","input":{"pattern":"TODO"}}]}}"#;
        let msgs = run_stream(&[outer, inner]);
        assert_eq!(msgs.len(), 2);
        match &msgs[0] {
            AgentUiMessage::ToolCall {
                name, parent_id, ..
            } => {
                assert_eq!(name, "Agent");
                assert!(parent_id.is_none());
            }
            other => panic!("expected ToolCall(Agent), got {other:?}"),
        }
        match &msgs[1] {
            AgentUiMessage::ToolCall {
                name,
                parent_id,
                id,
                ..
            } => {
                assert_eq!(name, "Grep");
                assert_eq!(id, "grep-1");
                assert_eq!(parent_id.as_deref(), Some("task-1"));
            }
            other => panic!("expected ToolCall(Grep), got {other:?}"),
        }
    }

    #[test]
    fn tool_result_emits_tool_result_with_parent_id() {
        let line = r#"{"type":"user","session_id":"s","parent_tool_use_id":"task-1","message":{"content":[{"type":"tool_result","tool_use_id":"grep-1","content":"src/main.rs:10","is_error":false}]}}"#;
        let msgs = run_stream(&[line]);
        assert_eq!(msgs.len(), 1);
        match &msgs[0] {
            AgentUiMessage::ToolResult {
                id,
                parent_id,
                error,
                ..
            } => {
                assert_eq!(id, "grep-1");
                assert_eq!(parent_id.as_deref(), Some("task-1"));
                assert!(error.is_none());
            }
            other => panic!("expected ToolResult, got {other:?}"),
        }
    }

    #[test]
    fn write_tool_emits_file_create() {
        let line = r#"{"type":"assistant","session_id":"s","parent_tool_use_id":null,"message":{"content":[{"type":"tool_use","id":"w1","name":"Write","input":{"file_path":"src/new.rs","content":"fn main(){}"}}]}}"#;
        let msgs = run_stream(&[line]);
        assert_eq!(msgs.len(), 2);
        assert!(matches!(msgs[0], AgentUiMessage::FileCreate { .. }));
        assert!(matches!(msgs[1], AgentUiMessage::ToolCall { .. }));
    }

    #[test]
    fn result_event_emits_finished() {
        let line = r#"{"type":"result","subtype":"success","session_id":"s","result":"done","is_error":false,"usage":{}}"#;
        let msgs = run_stream(&[line]);
        assert_eq!(msgs.len(), 1);
        match &msgs[0] {
            AgentUiMessage::Finished { summary, exit_code } => {
                assert_eq!(summary, "done");
                assert_eq!(*exit_code, Some(0));
            }
            other => panic!("expected Finished, got {other:?}"),
        }
    }

    #[test]
    fn malformed_line_is_skipped() {
        let msgs = run_stream(&["not json"]);
        assert!(msgs.is_empty());
    }

    #[test]
    fn empty_line_is_skipped() {
        let msgs = run_stream(&[""]);
        assert!(msgs.is_empty());
    }
}
