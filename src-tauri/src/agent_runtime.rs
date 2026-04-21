use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use dashmap::DashMap;
use pane_protocol::{encode, AgentUiMessage};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Runtime};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStderr, ChildStdout, Command};
use tokio::sync::{oneshot, Mutex};

use crate::terminal::manager::TerminalManager;
use crate::terminal::session::SessionId;

pub struct AgentRuntimeManager<R: Runtime = tauri::Wry> {
    sessions: DashMap<String, Arc<CodexAppServerSession<R>>>,
}

impl<R: Runtime> AgentRuntimeManager<R> {
    pub fn new() -> Self {
        Self {
            sessions: DashMap::new(),
        }
    }

    pub async fn launch_codex(
        &self,
        app: AppHandle<R>,
        session_id: String,
        cwd: String,
        prompt: Option<String>,
    ) -> Result<(), String> {
        let session = CodexAppServerSession::start(app, session_id.clone(), cwd, None, prompt).await?;
        self.sessions.insert(session_id, session);
        Ok(())
    }

    pub async fn resume_codex(
        &self,
        app: AppHandle<R>,
        session_id: String,
        cwd: String,
        thread_id: String,
    ) -> Result<(), String> {
        let session =
            CodexAppServerSession::start(app, session_id.clone(), cwd, Some(thread_id), None)
                .await?;
        self.sessions.insert(session_id, session);
        Ok(())
    }

    pub fn is_managed(&self, session_id: &str) -> bool {
        self.sessions.contains_key(session_id)
    }

    pub async fn send_input(&self, session_id: &str, text: String) -> Result<(), String> {
        let session = self
            .sessions
            .get(session_id)
            .map(|entry| entry.clone())
            .ok_or_else(|| "managed session not found".to_string())?;
        session.send_input(text).await
    }

    pub async fn interrupt(&self, session_id: &str) -> Result<(), String> {
        let session = self
            .sessions
            .get(session_id)
            .map(|entry| entry.clone())
            .ok_or_else(|| "managed session not found".to_string())?;
        session.interrupt().await
    }

    pub async fn respond(
        &self,
        session_id: &str,
        request_id: &str,
        choice: String,
    ) -> Result<(), String> {
        let session = self
            .sessions
            .get(session_id)
            .map(|entry| entry.clone())
            .ok_or_else(|| "managed session not found".to_string())?;
        session.respond(request_id, choice).await
    }

    pub async fn close(&self, session_id: &str) -> Result<(), String> {
        let Some((_, session)) = self.sessions.remove(session_id) else {
            return Ok(());
        };
        session.close().await
    }
}

struct CodexAppServerSession<R: Runtime = tauri::Wry> {
    app: AppHandle<R>,
    lastty_session_id: String,
    child: Arc<Mutex<Child>>,
    stdin: Arc<Mutex<tokio::process::ChildStdin>>,
    next_id: AtomicU64,
    pending_responses: Arc<Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>>,
    pending_requests: Arc<Mutex<HashMap<String, PendingServerRequest>>>,
    thread_id: Arc<Mutex<Option<String>>>,
    active_turn_id: Arc<Mutex<Option<String>>>,
    last_agent_message: Arc<Mutex<String>>,
}

impl<R: Runtime> CodexAppServerSession<R> {
    async fn start(
        app: AppHandle<R>,
        lastty_session_id: String,
        cwd: String,
        resume_thread_id: Option<String>,
        initial_prompt: Option<String>,
    ) -> Result<Arc<Self>, String> {
        let mut child = Command::new("codex")
            .args(["app-server", "--listen", "stdio://"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("failed to start codex app-server: {error}"))?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "codex app-server stdin unavailable".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "codex app-server stdout unavailable".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "codex app-server stderr unavailable".to_string())?;

        let session = Arc::new(Self {
            app,
            lastty_session_id,
            child: Arc::new(Mutex::new(child)),
            stdin: Arc::new(Mutex::new(stdin)),
            next_id: AtomicU64::new(1),
            pending_responses: Arc::new(Mutex::new(HashMap::new())),
            pending_requests: Arc::new(Mutex::new(HashMap::new())),
            thread_id: Arc::new(Mutex::new(None)),
            active_turn_id: Arc::new(Mutex::new(None)),
            last_agent_message: Arc::new(Mutex::new(String::new())),
        });

        spawn_stdout_reader(session.clone(), stdout);
        spawn_stderr_logger(session.clone(), stderr);
        spawn_exit_watcher(session.clone());

        session.initialize().await?;

        let thread_id = if let Some(thread_id) = resume_thread_id {
            session.resume_thread(thread_id, cwd).await?
        } else {
            session.start_thread(cwd).await?
        };

        {
            let mut current = session.thread_id.lock().await;
            *current = Some(thread_id.clone());
        }

        session.emit_message(AgentUiMessage::Ready {
            agent: "codex".to_string(),
            version: Some("app-server".to_string()),
            session_id: Some(thread_id),
        });

        if let Some(prompt) = initial_prompt.filter(|value| !value.trim().is_empty()) {
            session.send_input(prompt).await?;
        }

        Ok(session)
    }

    async fn initialize(&self) -> Result<(), String> {
        self.send_request(
            "initialize",
            json!({
                "clientInfo": {
                    "name": "lastty",
                    "title": "Lastty",
                    "version": env!("CARGO_PKG_VERSION"),
                }
            }),
        )
        .await?;
        self.send_notification("initialized", None).await
    }

    async fn start_thread(&self, cwd: String) -> Result<String, String> {
        let result = self
            .send_request(
                "thread/start",
                json!({
                    "cwd": cwd,
                    "persistExtendedHistory": true,
                }),
            )
            .await?;
        thread_id_from_result(&result)
    }

    async fn resume_thread(&self, thread_id: String, cwd: String) -> Result<String, String> {
        let result = self
            .send_request(
                "thread/resume",
                json!({
                    "threadId": thread_id,
                    "cwd": cwd,
                    "persistExtendedHistory": true,
                }),
            )
            .await?;
        thread_id_from_result(&result)
    }

    async fn send_input(&self, text: String) -> Result<(), String> {
        let thread_id = self.thread_id().await?;
        let active_turn_id = self.active_turn_id.lock().await.clone();
        if let Some(turn_id) = active_turn_id {
            self.send_request(
                "turn/steer",
                json!({
                    "threadId": thread_id,
                    "input": [{"type": "text", "text": text}],
                    "expectedTurnId": turn_id,
                }),
            )
            .await?;
            return Ok(());
        }

        {
            let mut last_agent_message = self.last_agent_message.lock().await;
            last_agent_message.clear();
        }

        let result = self
            .send_request(
                "turn/start",
                json!({
                    "threadId": thread_id,
                    "input": [{"type": "text", "text": text}],
                }),
            )
            .await?;

        if let Some(turn_id) = turn_id_from_result(&result) {
            let mut active_turn_id = self.active_turn_id.lock().await;
            *active_turn_id = Some(turn_id);
        }

        self.emit_message(AgentUiMessage::Status {
            phase: "running".to_string(),
            detail: Some("codex is working".to_string()),
        });
        Ok(())
    }

    async fn interrupt(&self) -> Result<(), String> {
        let thread_id = self.thread_id().await?;
        let turn_id = self
            .active_turn_id
            .lock()
            .await
            .clone()
            .ok_or_else(|| "no active codex turn to interrupt".to_string())?;
        self.send_request(
            "turn/interrupt",
            json!({
                "threadId": thread_id,
                "turnId": turn_id,
            }),
        )
        .await?;
        Ok(())
    }

    async fn respond(&self, request_id: &str, choice: String) -> Result<(), String> {
        let pending_request = self
            .pending_requests
            .lock()
            .await
            .remove(request_id)
            .ok_or_else(|| "pending request not found".to_string())?;

        let payload = pending_request.build_response(choice);
        self.send_raw_response(pending_request.raw_id, payload).await
    }

    async fn close(&self) -> Result<(), String> {
        let mut child = self.child.lock().await;
        child
            .kill()
            .await
            .map_err(|error| format!("failed to stop codex app-server: {error}"))
    }

    async fn thread_id(&self) -> Result<String, String> {
        self.thread_id
            .lock()
            .await
            .clone()
            .ok_or_else(|| "codex thread not initialized".to_string())
    }

    async fn send_notification(&self, method: &str, params: Option<Value>) -> Result<(), String> {
        let mut payload = serde_json::Map::new();
        payload.insert("method".to_string(), Value::String(method.to_string()));
        if let Some(params) = params {
            payload.insert("params".to_string(), params);
        }
        self.write_wire(Value::Object(payload)).await
    }

    async fn send_request(&self, method: &str, params: Value) -> Result<Value, String> {
        let request_id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let request_key = request_id.to_string();
        let (tx, rx) = oneshot::channel();
        self.pending_responses.lock().await.insert(request_key.clone(), tx);

        let payload = json!({
            "id": request_id,
            "method": method,
            "params": params,
        });
        if let Err(error) = self.write_wire(payload).await {
            self.pending_responses.lock().await.remove(&request_key);
            return Err(error);
        }

        rx.await
            .map_err(|_| format!("codex app-server request {method} was dropped"))?
    }

    async fn send_raw_response(&self, raw_id: Value, result: Value) -> Result<(), String> {
        self.write_wire(json!({
            "id": raw_id,
            "result": result,
        }))
        .await
    }

    async fn write_wire(&self, payload: Value) -> Result<(), String> {
        let line = payload.to_string();
        let mut stdin = self.stdin.lock().await;
        stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|error| format!("failed to write codex app-server request: {error}"))?;
        stdin
            .write_all(b"\n")
            .await
            .map_err(|error| format!("failed to terminate codex app-server request: {error}"))?;
        stdin
            .flush()
            .await
            .map_err(|error| format!("failed to flush codex app-server request: {error}"))
    }

    async fn handle_wire_message(self: &Arc<Self>, message: Value) {
        let method = message.get("method").and_then(Value::as_str);
        let id = message.get("id").cloned();

        match (method, id) {
            (Some(method), Some(id_value)) => {
                self.handle_server_request(method, id_value, message.get("params"))
                    .await;
            }
            (Some(method), None) => {
                self.handle_notification(method, message.get("params")).await;
            }
            (None, Some(id_value)) => {
                self.handle_response(id_value, message.get("result"), message.get("error"))
                    .await;
            }
            (None, None) => {}
        }
    }

    async fn handle_response(
        &self,
        id_value: Value,
        result: Option<&Value>,
        error: Option<&Value>,
    ) {
        let key = json_rpc_id_key(&id_value);
        let Some(tx) = self.pending_responses.lock().await.remove(&key) else {
            return;
        };
        let send_result = if let Some(error) = error {
            Err(error_message(error))
        } else {
            Ok(result.cloned().unwrap_or(Value::Null))
        };
        let _ = tx.send(send_result);
    }

    async fn handle_server_request(
        &self,
        method: &str,
        raw_id: Value,
        params: Option<&Value>,
    ) {
        let Some((request_key, pending_request, approval_message)) =
            build_pending_request(method, raw_id.clone(), params)
        else {
            return;
        };
        self.pending_requests
            .lock()
            .await
            .insert(request_key, pending_request);
        self.emit_message(approval_message);
    }

    async fn handle_notification(&self, method: &str, params: Option<&Value>) {
        match method {
            "turn/started" => {
                if let Some(turn_id) =
                    params.and_then(|value| value.get("turn")).and_then(turn_id_from_value)
                {
                    let mut active_turn_id = self.active_turn_id.lock().await;
                    *active_turn_id = Some(turn_id);
                }
                self.emit_message(AgentUiMessage::Status {
                    phase: "running".to_string(),
                    detail: Some("codex is working".to_string()),
                });
            }
            "turn/completed" => {
                {
                    let mut active_turn_id = self.active_turn_id.lock().await;
                    *active_turn_id = None;
                }
                self.pending_requests.lock().await.clear();
                let summary = turn_summary(params, &self.last_agent_message).await;
                let exit_code = turn_exit_code(params);
                self.emit_message(AgentUiMessage::Finished { summary, exit_code });
            }
            "item/agentMessage/delta" => {
                if let Some(delta) = params.and_then(|value| value.get("delta")).and_then(Value::as_str)
                {
                    self.append_agent_message(delta).await;
                    self.emit_echo(delta.as_bytes());
                }
            }
            "item/commandExecution/outputDelta" => {
                if let Some(delta) = params.and_then(command_output_delta) {
                    self.emit_echo(delta.as_bytes());
                }
            }
            "item/started" => {
                if let Some(item) = params.and_then(|value| value.get("item")) {
                    self.handle_item_started(item);
                }
            }
            "item/completed" => {
                if let Some(item) = params.and_then(|value| value.get("item")) {
                    self.handle_item_completed(item).await;
                }
            }
            "serverRequest/resolved" => {
                if let Some(request_id) = params.and_then(|value| value.get("requestId")) {
                    self.emit_message(AgentUiMessage::ApprovalResolved {
                        id: json_rpc_id_key(request_id),
                    });
                }
            }
            _ => {}
        }
    }

    fn handle_item_started(&self, item: &Value) {
        if let Some(message) = tool_call_from_item(item) {
            self.emit_message(message);
        }
    }

    async fn handle_item_completed(&self, item: &Value) {
        if let Some(message) = tool_result_from_item(item) {
            self.emit_message(message);
        }
        for message in file_messages_from_item(item) {
            self.emit_message(message);
        }
        if let Some(text) = item
            .get("text")
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
        {
            let mut last_agent_message = self.last_agent_message.lock().await;
            *last_agent_message = text.to_string();
            self.emit_echo(format!("{text}\r\n").as_bytes());
        }
    }

    async fn append_agent_message(&self, delta: &str) {
        let mut last_agent_message = self.last_agent_message.lock().await;
        last_agent_message.push_str(delta);
    }

    fn emit_message(&self, message: AgentUiMessage) {
        let encoded = encode(&message);
        self.emit_bytes(&encoded);
    }

    fn emit_echo(&self, bytes: &[u8]) {
        self.emit_bytes(bytes);
    }

    fn emit_bytes(&self, bytes: &[u8]) {
        let Ok(session_id) = SessionId::parse(&self.lastty_session_id) else {
            return;
        };
        let state = self.app.state::<TerminalManager<R>>();
        let Some(session) = state.get(&session_id) else {
            return;
        };
        let _ = session.write(bytes);
    }
}

fn spawn_stdout_reader<R: Runtime>(session: Arc<CodexAppServerSession<R>>, stdout: ChildStdout) {
    tokio::spawn(async move {
        let mut reader = BufReader::new(stdout).lines();
        loop {
            match reader.next_line().await {
                Ok(Some(line)) => {
                    let Ok(message) = serde_json::from_str::<Value>(&line) else {
                        continue;
                    };
                    session.handle_wire_message(message).await;
                }
                Ok(None) => break,
                Err(error) => {
                    session.emit_message(AgentUiMessage::Notification {
                        level: "error".to_string(),
                        message: format!("codex runtime stream failed: {error}"),
                    });
                    break;
                }
            }
        }
    });
}

fn spawn_stderr_logger<R: Runtime>(session: Arc<CodexAppServerSession<R>>, stderr: ChildStderr) {
    tokio::spawn(async move {
        let mut reader = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            if line.trim().is_empty() {
                continue;
            }
            tracing::debug!(session_id = %session.lastty_session_id, "codex app-server: {line}");
        }
    });
}

fn spawn_exit_watcher<R: Runtime>(session: Arc<CodexAppServerSession<R>>) {
    tokio::spawn(async move {
        let status = {
            let mut child = session.child.lock().await;
            child.wait().await.ok()
        };
        let code = status.and_then(|value| value.code());
        if code == Some(0) {
            return;
        }
        let summary = match code {
            Some(code) => format!("codex runtime exited with code {code}"),
            None => "codex runtime terminated".to_string(),
        };
        session.emit_message(AgentUiMessage::Notification {
            level: "error".to_string(),
            message: summary,
        });
    });
}

#[derive(Clone)]
struct PendingServerRequest {
    raw_id: Value,
    kind: PendingRequestKind,
}

impl PendingServerRequest {
    fn build_response(&self, choice: String) -> Value {
        match &self.kind {
            PendingRequestKind::CommandApproval => {
                json!({ "decision": normalize_command_decision(choice) })
            }
            PendingRequestKind::FileChangeApproval => {
                json!({ "decision": normalize_file_decision(choice) })
            }
            PendingRequestKind::UserInput { questions } => {
                let mut answers = serde_json::Map::new();
                if let Some(question) = questions.first() {
                    answers.insert(question.id.clone(), json!({ "answers": [choice] }));
                }
                json!({ "answers": Value::Object(answers) })
            }
        }
    }
}

#[derive(Clone)]
enum PendingRequestKind {
    CommandApproval,
    FileChangeApproval,
    UserInput { questions: Vec<UserInputQuestion> },
}

#[derive(Clone)]
struct UserInputQuestion {
    id: String,
    question: String,
    options: Vec<String>,
}

fn build_pending_request(
    method: &str,
    raw_id: Value,
    params: Option<&Value>,
) -> Option<(String, PendingServerRequest, AgentUiMessage)> {
    let params = params?;
    let request_key = json_rpc_id_key(&raw_id);
    match method {
        "item/commandExecution/requestApproval" => {
            let message = params
                .get("command")
                .and_then(Value::as_str)
                .map(|command| {
                    let cwd = params.get("cwd").and_then(Value::as_str).unwrap_or("");
                    if cwd.is_empty() {
                        format!("Allow Codex to run `{command}`?")
                    } else {
                        format!("Allow Codex to run `{command}` in `{cwd}`?")
                    }
                })
                .or_else(|| params.get("reason").and_then(Value::as_str).map(ToOwned::to_owned))
                .unwrap_or_else(|| "Approve command execution".to_string());
            let options = params
                .get("availableDecisions")
                .and_then(Value::as_array)
                .map(|values| {
                    values
                        .iter()
                        .filter_map(Value::as_str)
                        .map(ToOwned::to_owned)
                        .collect::<Vec<_>>()
                })
                .filter(|values| !values.is_empty())
                .unwrap_or_else(|| {
                    vec![
                        "accept".to_string(),
                        "acceptForSession".to_string(),
                        "decline".to_string(),
                        "cancel".to_string(),
                    ]
                });
            let pending_request = PendingServerRequest {
                raw_id,
                kind: PendingRequestKind::CommandApproval,
            };
            let ui_message = AgentUiMessage::Approval {
                id: request_key.clone(),
                message,
                options,
            };
            Some((request_key, pending_request, ui_message))
        }
        "item/fileChange/requestApproval" => {
            let message = params
                .get("reason")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
                .unwrap_or_else(|| "Approve proposed file changes".to_string());
            let pending_request = PendingServerRequest {
                raw_id,
                kind: PendingRequestKind::FileChangeApproval,
            };
            let ui_message = AgentUiMessage::Approval {
                id: request_key.clone(),
                message,
                options: vec![
                    "accept".to_string(),
                    "acceptForSession".to_string(),
                    "decline".to_string(),
                    "cancel".to_string(),
                ],
            };
            Some((request_key, pending_request, ui_message))
        }
        "item/tool/requestUserInput" => {
            let questions = params
                .get("questions")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|item| {
                            let id = item.get("id").and_then(Value::as_str)?.to_string();
                            let question = item
                                .get("question")
                                .or_else(|| item.get("header"))
                                .and_then(Value::as_str)
                                .unwrap_or("Provide input")
                                .to_string();
                            let options = item
                                .get("options")
                                .and_then(Value::as_array)
                                .map(|values| {
                                    values
                                        .iter()
                                        .filter_map(|value| value.get("label").and_then(Value::as_str))
                                        .map(ToOwned::to_owned)
                                        .collect::<Vec<_>>()
                                })
                                .unwrap_or_default();
                            Some(UserInputQuestion { id, question, options })
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();

            let message = match questions.len() {
                0 => "Provide additional input".to_string(),
                1 => questions[0].question.clone(),
                _ => questions
                    .iter()
                    .enumerate()
                    .map(|(index, question)| format!("{}. {}", index + 1, question.question))
                    .collect::<Vec<_>>()
                    .join(" "),
            };
            let options = questions
                .first()
                .map(|question| question.options.clone())
                .unwrap_or_default();
            let pending_request = PendingServerRequest {
                raw_id,
                kind: PendingRequestKind::UserInput { questions },
            };
            let ui_message = AgentUiMessage::Approval {
                id: request_key.clone(),
                message,
                options,
            };
            Some((request_key, pending_request, ui_message))
        }
        _ => None,
    }
}

fn tool_call_from_item(item: &Value) -> Option<AgentUiMessage> {
    match item.get("type").and_then(Value::as_str)? {
        "commandExecution" => Some(AgentUiMessage::ToolCall {
            id: item_id(item)?,
            name: "bash".to_string(),
            args: json!({
                "command": item.get("command").and_then(Value::as_str).unwrap_or(""),
                "cwd": item.get("cwd").and_then(Value::as_str),
            }),
            parent_id: None,
        }),
        "mcpToolCall" => Some(AgentUiMessage::ToolCall {
            id: item_id(item)?,
            name: format!(
                "{}/{}",
                item.get("server").and_then(Value::as_str).unwrap_or("mcp"),
                item.get("tool").and_then(Value::as_str).unwrap_or("tool")
            ),
            args: item
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| Value::Object(serde_json::Map::new())),
            parent_id: None,
        }),
        "webSearch" => Some(AgentUiMessage::ToolCall {
            id: item_id(item)?,
            name: "web_search".to_string(),
            args: json!({
                "query": item.get("query").and_then(Value::as_str).unwrap_or(""),
            }),
            parent_id: None,
        }),
        _ => None,
    }
}

fn tool_result_from_item(item: &Value) -> Option<AgentUiMessage> {
    match item.get("type").and_then(Value::as_str)? {
        "commandExecution" => Some(AgentUiMessage::ToolResult {
            id: item_id(item)?,
            result: Value::String(
                item.get("aggregatedOutput")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
            ),
            error: match item.get("status").and_then(Value::as_str) {
                Some("failed") => Some(
                    item.get("exitCode")
                        .and_then(Value::as_i64)
                        .map(|code| format!("exit {code}"))
                        .unwrap_or_else(|| "command failed".to_string()),
                ),
                Some("declined") => Some("declined".to_string()),
                _ => None,
            },
            parent_id: None,
        }),
        "mcpToolCall" => Some(AgentUiMessage::ToolResult {
            id: item_id(item)?,
            result: item.get("result").cloned().unwrap_or(Value::Null),
            error: item.get("error").and_then(Value::as_str).map(ToOwned::to_owned),
            parent_id: None,
        }),
        "webSearch" => Some(AgentUiMessage::ToolResult {
            id: item_id(item)?,
            result: item.get("action").cloned().unwrap_or(Value::Null),
            error: None,
            parent_id: None,
        }),
        _ => None,
    }
}

fn file_messages_from_item(item: &Value) -> Vec<AgentUiMessage> {
    if item.get("type").and_then(Value::as_str) != Some("fileChange") {
        return Vec::new();
    }
    item.get("changes")
        .and_then(Value::as_array)
        .map(|changes| {
            changes
                .iter()
                .filter_map(|change| {
                    let path = change.get("path").and_then(Value::as_str)?.to_string();
                    match change.get("kind").and_then(Value::as_str) {
                        Some("create") => Some(AgentUiMessage::FileCreate { path }),
                        Some("delete") => Some(AgentUiMessage::FileDelete { path }),
                        _ => Some(AgentUiMessage::FileEdit {
                            path,
                            diff: change.get("diff").and_then(Value::as_str).map(ToOwned::to_owned),
                        }),
                    }
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn item_id(item: &Value) -> Option<String> {
    item.get("id").and_then(Value::as_str).map(ToOwned::to_owned)
}

fn turn_id_from_result(result: &Value) -> Option<String> {
    result
        .get("turn")
        .and_then(turn_id_from_value)
}

fn turn_id_from_value(turn: &Value) -> Option<String> {
    turn.get("id").and_then(Value::as_str).map(ToOwned::to_owned)
}

fn thread_id_from_result(result: &Value) -> Result<String, String> {
    result
        .get("thread")
        .and_then(|thread| thread.get("id"))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .ok_or_else(|| "codex app-server did not return a thread id".to_string())
}

fn json_rpc_id_key(value: &Value) -> String {
    match value {
        Value::String(value) => value.clone(),
        Value::Number(value) => value.to_string(),
        other => other.to_string(),
    }
}

fn error_message(error: &Value) -> String {
    error
        .get("message")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| error.to_string())
}

async fn turn_summary(params: Option<&Value>, last_agent_message: &Arc<Mutex<String>>) -> String {
    let last_message = last_agent_message.lock().await.clone();
    let status = params
        .and_then(|value| value.get("turn"))
        .and_then(|turn| turn.get("status"))
        .and_then(Value::as_str)
        .unwrap_or("completed");
    match status {
        "failed" => params
            .and_then(|value| value.get("turn"))
            .and_then(|turn| turn.get("error"))
            .map(error_message)
            .unwrap_or_else(|| "codex turn failed".to_string()),
        "interrupted" => "codex turn interrupted".to_string(),
        _ if !last_message.is_empty() => last_message,
        _ => "codex turn completed".to_string(),
    }
}

fn turn_exit_code(params: Option<&Value>) -> Option<i32> {
    match params
        .and_then(|value| value.get("turn"))
        .and_then(|turn| turn.get("status"))
        .and_then(Value::as_str)
    {
        Some("failed") => Some(1),
        Some("interrupted") => Some(130),
        Some(_) => Some(0),
        None => None,
    }
}

fn command_output_delta(params: &Value) -> Option<&str> {
    params
        .get("delta")
        .and_then(Value::as_str)
        .or_else(|| params.get("chunk").and_then(Value::as_str))
}

fn normalize_command_decision(choice: String) -> Value {
    match choice.as_str() {
        "acceptForSession" | "decline" | "cancel" => Value::String(choice),
        _ => Value::String("accept".to_string()),
    }
}

fn normalize_file_decision(choice: String) -> Value {
    match choice.as_str() {
        "acceptForSession" | "decline" | "cancel" => Value::String(choice),
        _ => Value::String("accept".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::{build_pending_request, json_rpc_id_key, tool_call_from_item};
    use pane_protocol::AgentUiMessage;
    use serde_json::json;

    #[test]
    fn parses_command_execution_into_tool_call() {
        let item = json!({
            "id": "item-1",
            "type": "commandExecution",
            "command": "cargo test",
            "cwd": "/tmp/work",
        });
        let message = tool_call_from_item(&item).expect("tool call");
        assert!(matches!(
            message,
            AgentUiMessage::ToolCall { name, .. } if name == "bash"
        ));
    }

    #[test]
    fn builds_command_approval_request() {
        let params = json!({
            "command": "cargo test",
            "cwd": "/tmp/work",
            "availableDecisions": ["accept", "decline"],
        });
        let (id, _, message) = build_pending_request(
            "item/commandExecution/requestApproval",
            json!(42),
            Some(&params),
        )
        .expect("approval request");
        assert_eq!(id, "42");
        assert!(matches!(
            message,
            AgentUiMessage::Approval { options, .. } if options == vec!["accept".to_string(), "decline".to_string()]
        ));
    }

    #[test]
    fn json_rpc_id_key_preserves_string_ids() {
        assert_eq!(json_rpc_id_key(&json!("req-7")), "req-7".to_string());
    }
}
