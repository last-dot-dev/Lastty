use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tokio::sync::broadcast;

use crate::agents::{self, LaunchAgentRequest, RuleDefinition};
use crate::terminal::manager::TerminalManager;
use crate::terminal::session::SessionId;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum BusEvent {
    SessionCreated {
        session_id: String,
        agent_id: Option<String>,
    },
    SessionExited {
        session_id: String,
        exit_code: Option<i32>,
    },
    AgentStatus {
        session_id: String,
        agent_id: Option<String>,
        phase: String,
        detail: Option<String>,
    },
    AgentToolCall {
        session_id: String,
        agent_id: Option<String>,
        tool: String,
        args: serde_json::Value,
    },
    AgentFileEdit {
        session_id: String,
        agent_id: Option<String>,
        path: String,
    },
    AgentFinished {
        session_id: String,
        agent_id: Option<String>,
        summary: String,
        exit_code: Option<i32>,
    },
    UserApproval {
        session_id: String,
        approval_id: String,
        choice: String,
    },
    PtyInput {
        session_id: String,
        bytes: Vec<u8>,
    },
    PtyOutput {
        session_id: String,
        bytes: Vec<u8>,
    },
    Resize {
        session_id: String,
        cols: u16,
        rows: u16,
    },
    RuleTriggered {
        session_id: String,
        rule_name: String,
        launched_session_id: String,
        launched_agent_id: String,
    },
}

#[derive(Clone)]
pub struct EventBus<R: Runtime = tauri::Wry> {
    app: AppHandle<R>,
    recordings_dir: PathBuf,
    sender: broadcast::Sender<BusEvent>,
    write_guard: Arc<Mutex<()>>,
    rule_executor_started: Arc<AtomicBool>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RecordingInfo {
    pub session_id: String,
    pub path: String,
    pub size_bytes: u64,
}

impl<R: Runtime> EventBus<R> {
    pub fn new(app: AppHandle<R>, recordings_dir: PathBuf) -> Self {
        let _ = fs::create_dir_all(&recordings_dir);
        let (sender, _) = broadcast::channel(256);
        Self {
            app,
            recordings_dir,
            sender,
            write_guard: Arc::new(Mutex::new(())),
            rule_executor_started: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn publish(&self, event: BusEvent) {
        let _ = self.sender.send(event.clone());
        let _ = self.app.emit("bus:event", &event);
        self.record(&event);
    }

    pub fn start_rule_executor(&self, workspace_root: PathBuf) -> Result<usize, String> {
        let rules = agents::load_rules(&workspace_root).map_err(|error| error.to_string())?;
        let rule_count = rules.len();
        if rules.is_empty() {
            return Ok(0);
        }
        if self.rule_executor_started.swap(true, Ordering::Relaxed) {
            return Ok(rule_count);
        }

        let app = self.app.clone();
        let mut receiver = self.sender.subscribe();
        tauri::async_runtime::spawn(async move {
            let mut engine = RuleEngine::new(rules);
            loop {
                match receiver.recv().await {
                    Ok(event) => {
                        let actions = engine.evaluate_at(&event, unix_now_ms());
                        for action in actions {
                            run_rule_action(app.clone(), workspace_root.clone(), action);
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        });

        Ok(rule_count)
    }

    pub fn list_recordings(&self) -> Vec<RecordingInfo> {
        let Ok(entries) = fs::read_dir(&self.recordings_dir) else {
            return Vec::new();
        };

        entries
            .flatten()
            .filter_map(|entry| {
                let metadata = entry.metadata().ok()?;
                let file_name = entry.file_name().into_string().ok()?;
                let session_id = file_name.strip_suffix(".jsonl")?.to_string();
                Some(RecordingInfo {
                    session_id,
                    path: entry.path().display().to_string(),
                    size_bytes: metadata.len(),
                })
            })
            .collect()
    }

    pub fn read_recording(&self, session_id: &str) -> Result<String, String> {
        let path = self.recordings_dir.join(format!("{session_id}.jsonl"));
        fs::read_to_string(path).map_err(|error| error.to_string())
    }

    pub fn record_agent_ui_message(&self, session_id: &str, message: &serde_json::Value) {
        self.record_line(
            session_id,
            serde_json::json!({
                "agent_ui_message": message,
            }),
        );
    }

    fn record(&self, event: &BusEvent) {
        let Some(session_id) = event.session_id() else {
            return;
        };

        self.record_line(
            session_id,
            serde_json::json!({
                "event": event,
            }),
        );
    }

    fn record_line(&self, session_id: &str, payload: serde_json::Value) {
        let _guard = self.write_guard.lock().unwrap();
        let path = self.recordings_dir.join(format!("{session_id}.jsonl"));
        let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) else {
            return;
        };

        let mut line = serde_json::json!({
            "ts_ms": std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_millis())
                .unwrap_or_default(),
        });
        if let (Some(map), Some(payload_map)) = (line.as_object_mut(), payload.as_object()) {
            map.extend(payload_map.clone());
        }
        let _ = writeln!(file, "{line}");
    }
}

impl BusEvent {
    pub fn kind(&self) -> &'static str {
        match self {
            BusEvent::SessionCreated { .. } => "session_created",
            BusEvent::SessionExited { .. } => "session_exited",
            BusEvent::AgentStatus { .. } => "agent_status",
            BusEvent::AgentToolCall { .. } => "agent_tool_call",
            BusEvent::AgentFileEdit { .. } => "agent_file_edit",
            BusEvent::AgentFinished { .. } => "agent_finished",
            BusEvent::UserApproval { .. } => "user_approval",
            BusEvent::PtyInput { .. } => "pty_input",
            BusEvent::PtyOutput { .. } => "pty_output",
            BusEvent::Resize { .. } => "resize",
            BusEvent::RuleTriggered { .. } => "rule_triggered",
        }
    }

    pub fn session_id(&self) -> Option<&str> {
        match self {
            BusEvent::SessionCreated { session_id, .. }
            | BusEvent::SessionExited { session_id, .. }
            | BusEvent::AgentStatus { session_id, .. }
            | BusEvent::AgentToolCall { session_id, .. }
            | BusEvent::AgentFileEdit { session_id, .. }
            | BusEvent::AgentFinished { session_id, .. }
            | BusEvent::UserApproval { session_id, .. }
            | BusEvent::PtyInput { session_id, .. }
            | BusEvent::PtyOutput { session_id, .. }
            | BusEvent::Resize { session_id, .. }
            | BusEvent::RuleTriggered { session_id, .. } => Some(session_id.as_str()),
        }
    }

    pub fn agent_id(&self) -> Option<&str> {
        match self {
            BusEvent::SessionCreated {
                agent_id: Some(agent_id),
                ..
            }
            | BusEvent::AgentStatus {
                agent_id: Some(agent_id),
                ..
            }
            | BusEvent::AgentToolCall {
                agent_id: Some(agent_id),
                ..
            }
            | BusEvent::AgentFileEdit {
                agent_id: Some(agent_id),
                ..
            }
            | BusEvent::AgentFinished {
                agent_id: Some(agent_id),
                ..
            } => Some(agent_id.as_str()),
            _ => None,
        }
    }

    fn phase(&self) -> Option<&str> {
        match self {
            BusEvent::AgentStatus { phase, .. } => Some(phase.as_str()),
            _ => None,
        }
    }

    fn tool(&self) -> Option<&str> {
        match self {
            BusEvent::AgentToolCall { tool, .. } => Some(tool.as_str()),
            _ => None,
        }
    }

    fn path(&self) -> Option<&str> {
        match self {
            BusEvent::AgentFileEdit { path, .. } => Some(path.as_str()),
            _ => None,
        }
    }

    fn choice(&self) -> Option<&str> {
        match self {
            BusEvent::UserApproval { choice, .. } => Some(choice.as_str()),
            _ => None,
        }
    }

    fn template_value(&self, key: &str) -> Option<String> {
        match key {
            "session_id" => self.session_id().map(ToOwned::to_owned),
            "agent_id" => self.agent_id().map(ToOwned::to_owned),
            "phase" => self.phase().map(ToOwned::to_owned),
            "detail" => match self {
                BusEvent::AgentStatus { detail, .. } => detail.clone(),
                _ => None,
            },
            "tool" => self.tool().map(ToOwned::to_owned),
            "path" => self.path().map(ToOwned::to_owned),
            "summary" => match self {
                BusEvent::AgentFinished { summary, .. } => Some(summary.clone()),
                _ => None,
            },
            "choice" => self.choice().map(ToOwned::to_owned),
            "cols" => match self {
                BusEvent::Resize { cols, .. } => Some(cols.to_string()),
                _ => None,
            },
            "rows" => match self {
                BusEvent::Resize { rows, .. } => Some(rows.to_string()),
                _ => None,
            },
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PreparedRuleAction {
    rule_name: String,
    source_session_id: Option<String>,
    request: LaunchAgentRequest,
}

struct RuleEngine {
    rules: Vec<RuleDefinition>,
    last_triggered_at_ms: HashMap<String, u128>,
}

impl RuleEngine {
    fn new(rules: Vec<RuleDefinition>) -> Self {
        Self {
            rules,
            last_triggered_at_ms: HashMap::new(),
        }
    }

    fn evaluate_at(&mut self, event: &BusEvent, now_ms: u128) -> Vec<PreparedRuleAction> {
        let mut actions = Vec::new();

        for rule in &self.rules {
            if !rule_matches(rule, event) {
                continue;
            }
            if let Some(debounce_ms) = rule.debounce_ms {
                if let Some(previous_ms) = self.last_triggered_at_ms.get(&rule.name) {
                    if now_ms.saturating_sub(*previous_ms) < u128::from(debounce_ms) {
                        continue;
                    }
                }
            }

            self.last_triggered_at_ms.insert(rule.name.clone(), now_ms);
            actions.push(PreparedRuleAction {
                rule_name: rule.name.clone(),
                source_session_id: event.session_id().map(ToOwned::to_owned),
                request: LaunchAgentRequest {
                    agent_id: rule.action.launch_agent.clone(),
                    prompt: normalize_optional(render_template(
                        rule.action.prompt.as_deref(),
                        event,
                    )),
                    cwd: normalize_optional(render_template(rule.action.cwd.as_deref(), event)),
                    isolate_in_worktree: rule.action.isolate_in_worktree,
                    branch_name: normalize_optional(render_template(
                        rule.action.branch_name.as_deref(),
                        event,
                    )),
                },
            });
        }

        actions
    }
}

fn run_rule_action<R: Runtime + 'static>(
    app: AppHandle<R>,
    workspace_root: PathBuf,
    action: PreparedRuleAction,
) {
    tauri::async_runtime::spawn_blocking(move || {
        let manager = app.state::<TerminalManager<R>>();
        let event_bus = app.state::<EventBus<R>>();

        let mut request = action.request.clone();
        if request.cwd.is_none() {
            request.cwd = inherited_cwd(&manager, action.source_session_id.as_deref());
        }

        match agents::launch_agent(&manager, &workspace_root, request.clone()) {
            Ok(result) => {
                let launched_agent_id = SessionId::parse(&result.session_id)
                    .ok()
                    .and_then(|session_id| {
                        manager
                            .get(&session_id)
                            .and_then(|session| session.agent_id.clone())
                    })
                    .unwrap_or_else(|| request.agent_id.clone());

                event_bus.publish(BusEvent::SessionCreated {
                    session_id: result.session_id.clone(),
                    agent_id: Some(launched_agent_id.clone()),
                });
                if let Some(source_session_id) = action.source_session_id.as_ref() {
                    event_bus.publish(BusEvent::RuleTriggered {
                        session_id: source_session_id.clone(),
                        rule_name: action.rule_name.clone(),
                        launched_session_id: result.session_id,
                        launched_agent_id,
                    });
                }
            }
            Err(error) => {
                tracing::warn!(
                    rule = %action.rule_name,
                    agent = %request.agent_id,
                    "rule launch failed: {error}"
                );
            }
        }
    });
}

fn inherited_cwd<R: Runtime>(
    manager: &TerminalManager<R>,
    session_id: Option<&str>,
) -> Option<String> {
    let session_id = SessionId::parse(session_id?).ok()?;
    let session = manager.get(&session_id)?;
    Some(
        session
            .worktree_path
            .clone()
            .unwrap_or_else(|| session.cwd.clone()),
    )
}

fn rule_matches(rule: &RuleDefinition, event: &BusEvent) -> bool {
    if normalized_event_name(&rule.trigger.event) != event.kind() {
        return false;
    }

    let filter = &rule.trigger.filter;
    if let Some(expected) = filter.agent_id.as_deref() {
        if event.agent_id() != Some(expected) {
            return false;
        }
    }
    if let Some(expected) = filter.session_id.as_deref() {
        if event.session_id() != Some(expected) {
            return false;
        }
    }
    if let Some(expected) = filter.phase.as_deref() {
        if event.phase() != Some(expected) {
            return false;
        }
    }
    if let Some(expected) = filter.tool.as_deref() {
        if event.tool() != Some(expected) {
            return false;
        }
    }
    if let Some(pattern) = filter.path.as_deref() {
        let Some(path) = event.path() else {
            return false;
        };
        if !wildcard_matches(pattern, path) {
            return false;
        }
    }
    if let Some(expected) = filter.choice.as_deref() {
        if event.choice() != Some(expected) {
            return false;
        }
    }

    true
}

fn render_template(template: Option<&str>, event: &BusEvent) -> Option<String> {
    let template = template?;
    let mut rendered = String::with_capacity(template.len());
    let mut rest = template;

    while let Some(start) = rest.find("{{") {
        rendered.push_str(&rest[..start]);
        let placeholder_start = start + 2;
        let Some(end_offset) = rest[placeholder_start..].find("}}") else {
            rendered.push_str(&rest[start..]);
            return Some(rendered);
        };
        let placeholder_end = placeholder_start + end_offset;
        let key = rest[placeholder_start..placeholder_end].trim();
        if let Some(value) = event.template_value(key) {
            rendered.push_str(&value);
        }
        rest = &rest[placeholder_end + 2..];
    }

    rendered.push_str(rest);
    Some(rendered)
}

fn normalize_optional(value: Option<String>) -> Option<String> {
    value.and_then(|item| {
        let trimmed = item.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn wildcard_matches(pattern: &str, value: &str) -> bool {
    if pattern == "*" {
        return true;
    }
    if !pattern.contains('*') {
        return pattern == value;
    }

    let starts_with_wildcard = pattern.starts_with('*');
    let ends_with_wildcard = pattern.ends_with('*');
    let mut remaining = value;

    for (index, part) in pattern
        .split('*')
        .filter(|part| !part.is_empty())
        .enumerate()
    {
        if index == 0 && !starts_with_wildcard {
            let Some(stripped) = remaining.strip_prefix(part) else {
                return false;
            };
            remaining = stripped;
            continue;
        }

        if let Some(position) = remaining.find(part) {
            remaining = &remaining[position + part.len()..];
        } else {
            return false;
        }
    }

    ends_with_wildcard || remaining.is_empty()
}

fn normalized_event_name(value: &str) -> String {
    let mut normalized = String::with_capacity(value.len());
    for (index, ch) in value.chars().enumerate() {
        if ch.is_ascii_uppercase() {
            if index > 0 {
                normalized.push('_');
            }
            normalized.push(ch.to_ascii_lowercase());
        } else {
            normalized.push(ch.to_ascii_lowercase());
        }
    }
    normalized
}

fn unix_now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::Arc;
    use std::thread;
    use std::time::{Duration, Instant};

    use super::{
        normalized_event_name, render_template, wildcard_matches, BusEvent, EventBus, RuleEngine,
    };
    use crate::agents::{RuleAction, RuleDefinition, RuleFilter, RuleTrigger};
    use crate::render_sync::RenderCoordinator;
    use crate::terminal::manager::TerminalManager;
    use crate::terminal::session::CommandSpec;
    use tauri::test::MockRuntime;
    use tauri::Manager;

    #[test]
    fn debounces_rule_actions() {
        let mut engine = RuleEngine::new(vec![RuleDefinition {
            name: "lint-on-edit".to_string(),
            trigger: RuleTrigger {
                event: "agent_file_edit".to_string(),
                filter: RuleFilter {
                    path: Some("*.rs".to_string()),
                    ..RuleFilter::default()
                },
            },
            action: RuleAction {
                launch_agent: "clippy".to_string(),
                prompt: Some("Lint {{path}}".to_string()),
                cwd: None,
                isolate_in_worktree: false,
                branch_name: None,
            },
            debounce_ms: Some(2_000),
        }]);
        let event = BusEvent::AgentFileEdit {
            session_id: "session-1".to_string(),
            agent_id: Some("codex".to_string()),
            path: "src/main.rs".to_string(),
        };

        let first = engine.evaluate_at(&event, 1_000);
        let second = engine.evaluate_at(&event, 2_000);
        let third = engine.evaluate_at(&event, 3_100);

        assert_eq!(first.len(), 1);
        assert_eq!(first[0].request.agent_id, "clippy");
        assert_eq!(first[0].request.prompt.as_deref(), Some("Lint src/main.rs"));
        assert!(second.is_empty());
        assert_eq!(third.len(), 1);
    }

    #[test]
    fn renders_rule_templates_from_finished_events() {
        let event = BusEvent::AgentFinished {
            session_id: "session-1".to_string(),
            agent_id: Some("claude".to_string()),
            summary: "Updated renderer tests".to_string(),
            exit_code: Some(0),
        };

        assert_eq!(
            render_template(Some("Follow up on {{summary}} for {{agent_id}}"), &event),
            Some("Follow up on Updated renderer tests for claude".to_string())
        );
    }

    #[test]
    fn supports_simple_wildcards_for_path_filters() {
        assert!(wildcard_matches("src/*.rs", "src/main.rs"));
        assert!(wildcard_matches("*.rs", "src/main.rs"));
        assert!(!wildcard_matches("src/*.ts", "src/main.rs"));
    }

    #[test]
    fn normalizes_camel_case_event_names() {
        assert_eq!(normalized_event_name("AgentFinished"), "agent_finished");
        assert_eq!(normalized_event_name("agent_file_edit"), "agent_file_edit");
    }

    #[test]
    fn rule_executor_launches_one_follow_on_session_under_debounce() {
        let workspace_root = temp_dir("lastty-rule-executor");
        fs::write(
            workspace_root.join("agents.toml"),
            r#"
            [[agent]]
            id = "reviewer"
            name = "Reviewer"
            command = "/bin/sh"
            default_args = ["-lc", "sleep 30"]
            prompt_transport = "argv"

            [[rule]]
            name = "follow-up-review"
            debounce_ms = 2_000

            [rule.trigger]
            event = "agent_finished"

            [rule.trigger.filter]
            agent_id = "codex"

            [rule.action]
            launch_agent = "reviewer"
            isolate_in_worktree = false
            "#,
        )
        .unwrap();

        let app = tauri::test::mock_app();
        let recordings_dir = workspace_root.join("recordings");
        let render_coordinator = Arc::new(RenderCoordinator::new());
        assert!(app.manage(EventBus::new(app.handle().clone(), recordings_dir.clone())));
        assert!(app.manage(TerminalManager::new(
            app.handle().clone(),
            render_coordinator
        )));

        let manager = app.state::<TerminalManager<MockRuntime>>();
        let env = pane_env();
        let source_session_id = manager
            .create_session(
                Some(CommandSpec {
                    program: "/bin/sh".to_string(),
                    args: vec!["-lc".to_string(), "sleep 30".to_string()],
                }),
                &workspace_root,
                &env,
                80,
                24,
                Some("codex".to_string()),
                Some("source".to_string()),
                None,
                None,
            )
            .unwrap();
        drop(manager);

        let event_bus = app.state::<EventBus<MockRuntime>>();
        assert_eq!(
            event_bus
                .start_rule_executor(workspace_root.clone())
                .unwrap(),
            1
        );

        let finished_event = BusEvent::AgentFinished {
            session_id: source_session_id.to_string(),
            agent_id: Some("codex".to_string()),
            summary: "patched renderer".to_string(),
            exit_code: Some(0),
        };
        event_bus.publish(finished_event.clone());
        event_bus.publish(finished_event);

        wait_for(
            || {
                let manager = app.state::<TerminalManager<MockRuntime>>();
                manager.list_sessions().len() == 2
                    && recorded_event_count(
                        &event_bus,
                        &source_session_id.to_string(),
                        "rule_triggered",
                    ) == 1
            },
            Duration::from_secs(5),
        );

        let manager = app.state::<TerminalManager<MockRuntime>>();
        let sessions = manager.list_sessions();
        assert_eq!(sessions.len(), 2);

        let follow_on = sessions
            .iter()
            .find(|session| session.session_id != source_session_id.to_string())
            .expect("missing follow-on session");
        assert_eq!(follow_on.agent_id.as_deref(), Some("reviewer"));
        assert_eq!(follow_on.cwd, workspace_root.display().to_string());
        drop(manager);

        assert_eq!(
            recorded_event_count(&event_bus, &source_session_id.to_string(), "rule_triggered"),
            1
        );

        cleanup_sessions(&app);
    }

    #[test]
    fn rule_executor_launches_once_from_pty_finished_messages_under_debounce() {
        let workspace_root = temp_dir("lastty-rule-executor-pty");
        fs::write(
            workspace_root.join("agents.toml"),
            r#"
            [[agent]]
            id = "reviewer"
            name = "Reviewer"
            command = "/bin/sh"
            default_args = ["-lc", "sleep 30"]
            prompt_transport = "argv"

            [[rule]]
            name = "follow-up-review"
            debounce_ms = 2_000

            [rule.trigger]
            event = "agent_finished"

            [rule.trigger.filter]
            agent_id = "codex"

            [rule.action]
            launch_agent = "reviewer"
            isolate_in_worktree = false
            "#,
        )
        .unwrap();

        let app = tauri::test::mock_app();
        let recordings_dir = workspace_root.join("recordings");
        let render_coordinator = Arc::new(RenderCoordinator::new());
        assert!(app.manage(EventBus::new(app.handle().clone(), recordings_dir.clone())));
        assert!(app.manage(TerminalManager::new(
            app.handle().clone(),
            render_coordinator
        )));

        let manager = app.state::<TerminalManager<MockRuntime>>();
        let source_session_id = manager
            .create_session(
                Some(CommandSpec {
                    program: "/bin/sh".to_string(),
                    args: vec!["-lc".to_string(), agent_finished_command()],
                }),
                &workspace_root,
                &pane_env(),
                80,
                24,
                Some("codex".to_string()),
                Some("source".to_string()),
                None,
                None,
            )
            .unwrap();
        drop(manager);

        let event_bus = app.state::<EventBus<MockRuntime>>();
        assert_eq!(
            event_bus
                .start_rule_executor(workspace_root.clone())
                .unwrap(),
            1
        );

        wait_for(
            || {
                let manager = app.state::<TerminalManager<MockRuntime>>();
                manager.list_sessions().len() == 2
                    && recorded_agent_ui_message_count(
                        &event_bus,
                        &source_session_id.to_string(),
                        "Finished",
                    ) == 2
                    && recorded_event_count(
                        &event_bus,
                        &source_session_id.to_string(),
                        "agent_finished",
                    ) == 2
                    && recorded_event_count(
                        &event_bus,
                        &source_session_id.to_string(),
                        "rule_triggered",
                    ) == 1
            },
            Duration::from_secs(5),
        );

        let manager = app.state::<TerminalManager<MockRuntime>>();
        let sessions = manager.list_sessions();
        assert_eq!(sessions.len(), 2);

        let follow_on = sessions
            .iter()
            .find(|session| session.session_id != source_session_id.to_string())
            .expect("missing follow-on session");
        assert_eq!(follow_on.agent_id.as_deref(), Some("reviewer"));
        assert_eq!(follow_on.cwd, workspace_root.display().to_string());
        drop(manager);

        assert_eq!(
            recorded_agent_ui_message_count(&event_bus, &source_session_id.to_string(), "Finished"),
            2
        );
        assert_eq!(
            recorded_event_count(&event_bus, &source_session_id.to_string(), "agent_finished"),
            2
        );
        assert_eq!(
            recorded_event_count(&event_bus, &source_session_id.to_string(), "rule_triggered"),
            1
        );

        cleanup_sessions(&app);
    }

    fn pane_env() -> HashMap<String, String> {
        HashMap::from([
            ("TERM".to_string(), "xterm-256color".to_string()),
            ("COLORTERM".to_string(), "truecolor".to_string()),
            ("LASTTY".to_string(), "1".to_string()),
        ])
    }

    fn agent_finished_command() -> String {
        [
            r#"printf '\033]7770;{"type":"Finished","data":{"summary":"patched renderer","exit_code":0}}\007'"#,
            r#"printf '\033]7770;{"type":"Finished","data":{"summary":"patched renderer","exit_code":0}}\007'"#,
            "sleep 1",
        ]
        .join("; ")
    }

    fn recorded_event_count<R: tauri::Runtime>(
        event_bus: &EventBus<R>,
        session_id: &str,
        kind: &str,
    ) -> usize {
        event_bus
            .read_recording(session_id)
            .unwrap_or_default()
            .lines()
            .filter(|line| {
                serde_json::from_str::<serde_json::Value>(line)
                    .ok()
                    .and_then(|value| {
                        value
                            .get("event")
                            .and_then(|event| event.get("type"))
                            .and_then(|value| value.as_str())
                            .map(|value| value == kind)
                    })
                    .unwrap_or(false)
            })
            .count()
    }

    fn recorded_agent_ui_message_count<R: tauri::Runtime>(
        event_bus: &EventBus<R>,
        session_id: &str,
        kind: &str,
    ) -> usize {
        event_bus
            .read_recording(session_id)
            .unwrap_or_default()
            .lines()
            .filter(|line| {
                serde_json::from_str::<serde_json::Value>(line)
                    .ok()
                    .and_then(|value| {
                        value
                            .get("agent_ui_message")
                            .and_then(|message| message.get("type"))
                            .and_then(|value| value.as_str())
                            .map(|value| value == kind)
                    })
                    .unwrap_or(false)
            })
            .count()
    }

    fn wait_for(mut condition: impl FnMut() -> bool, timeout: Duration) {
        let start = Instant::now();
        while start.elapsed() < timeout {
            if condition() {
                return;
            }
            thread::sleep(Duration::from_millis(25));
        }
        panic!("condition not met within {:?}", timeout);
    }

    fn cleanup_sessions<R: tauri::Runtime>(app: &tauri::App<R>) {
        let manager = app.state::<TerminalManager<R>>();
        let session_ids = manager
            .list_sessions()
            .into_iter()
            .filter_map(|session| {
                crate::terminal::session::SessionId::parse(&session.session_id).ok()
            })
            .collect::<Vec<_>>();
        for session_id in session_ids {
            let _ = manager.remove(&session_id);
        }
    }

    fn temp_dir(prefix: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "{prefix}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }
}
