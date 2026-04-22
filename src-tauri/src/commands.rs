use std::collections::HashMap;
#[cfg(feature = "bench")]
use std::fs;
use std::path::Path;

use alacritty_terminal::grid::Scroll;
use serde::Deserialize;
use tauri::{AppHandle, State};

use crate::agents::{
    self, load_agent_registry, resume_command_spec, AgentDefinition, LaunchAgentRequest,
    LaunchAgentResult, RuleDefinition,
};
use crate::bus::{BusEvent, EventBus, HistoryEntry, HistorySource, RecordingInfo};
use crate::font_config::FontConfig;
use crate::history;
use crate::peer::PeerRouter;
#[cfg(feature = "bench")]
use crate::runtime_modes;
use crate::terminal::manager::TerminalManager;
use crate::terminal::render::TerminalFrame;
use crate::terminal::session::{CommandSpec, SessionConfig, SessionId, SessionInfo};
use pane_protocol::peer::PeerMessage;
use std::sync::Arc;

fn build_pane_env() -> HashMap<String, String> {
    let mut env = HashMap::new();
    env.insert("TERM".to_string(), "xterm-256color".to_string());
    env.insert("COLORTERM".to_string(), "truecolor".to_string());
    env.insert("LASTTY".to_string(), "1".to_string());
    env
}

#[derive(Debug, Clone, Deserialize)]
pub struct RestoreTerminalRequest {
    pub cwd: String,
}

#[tauri::command]
pub async fn create_terminal(
    cwd: Option<String>,
    command: Option<String>,
    args: Option<Vec<String>>,
    state: State<'_, TerminalManager>,
    event_bus: State<'_, EventBus>,
) -> Result<String, String> {
    let env = build_pane_env();
    let cwd = cwd
        .filter(|value| !value.is_empty())
        .map(std::path::PathBuf::from)
        .ok_or_else(|| "create_terminal: cwd is required".to_string())?;
    let command = command.map(|program| CommandSpec {
        program,
        args: args.unwrap_or_default(),
    });
    let session_id = state
        .create_session(SessionConfig {
            command,
            cwd,
            env,
            cols: 80,
            rows: 24,
            ..Default::default()
        })
        .map_err(|e| e.to_string())?;
    event_bus.publish(BusEvent::SessionCreated {
        session_id: session_id.to_string(),
        agent_id: None,
    });
    Ok(session_id.to_string())
}

#[tauri::command]
pub async fn terminal_resize(
    session_id: String,
    cols: u16,
    rows: u16,
    state: State<'_, TerminalManager>,
    event_bus: State<'_, EventBus>,
) -> Result<(), String> {
    terminal_resize_for_runtime(session_id, cols, rows, state, event_bus).await
}

async fn terminal_resize_for_runtime<R: tauri::Runtime>(
    session_id: String,
    cols: u16,
    rows: u16,
    state: State<'_, TerminalManager<R>>,
    event_bus: State<'_, EventBus<R>>,
) -> Result<(), String> {
    let id = SessionId::parse(&session_id)?;
    let session = state.get(&id).ok_or("session not found")?;
    session.resize(cols, rows, 8, 16)?;
    drop(session);
    state.mark_dirty(id);
    event_bus.publish(BusEvent::Resize {
        session_id,
        cols,
        rows,
    });
    Ok(())
}

#[tauri::command]
pub async fn terminal_scroll(
    session_id: String,
    lines: i32,
    state: State<'_, TerminalManager>,
) -> Result<(), String> {
    terminal_scroll_for_runtime(session_id, lines, state).await
}

async fn terminal_scroll_for_runtime<R: tauri::Runtime>(
    session_id: String,
    lines: i32,
    state: State<'_, TerminalManager<R>>,
) -> Result<(), String> {
    if lines == 0 {
        return Ok(());
    }

    let id = SessionId::parse(&session_id)?;
    let session = state.get(&id).ok_or("session not found")?;
    session.term.lock().scroll_display(Scroll::Delta(lines));
    drop(session);
    state.mark_dirty(id);
    Ok(())
}

#[tauri::command]
pub async fn kill_terminal(
    session_id: String,
    state: State<'_, TerminalManager>,
) -> Result<(), String> {
    let id = SessionId::parse(&session_id)?;
    state.remove(&id).ok_or("session not found".to_string())?;
    Ok(())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyInput {
    pub key: String,
    pub code: String,
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
    pub meta: bool,
    pub session_id: Option<String>,
}

#[tauri::command]
pub async fn key_input(input: KeyInput, state: State<'_, TerminalManager>) -> Result<(), String> {
    let session_id = match input.session_id {
        Some(raw) => SessionId::parse(&raw)?,
        None => state.first_session_id().ok_or("no active session")?,
    };
    let session = state.get(&session_id).ok_or("session not found")?;

    let mode = if crate::input::key_requires_mode_lookup(&input.code) {
        Some(*session.term.lock().mode())
    } else {
        None
    };

    if let Some(bytes) = crate::input::key_to_bytes(
        &input.key,
        &input.code,
        input.ctrl,
        input.alt,
        input.shift,
        input.meta,
        mode,
    ) {
        session.write(&bytes)?;
        session.term.lock().scroll_display(Scroll::Bottom);
        drop(session);
        state.mark_dirty(session_id);
    }
    Ok(())
}

#[cfg(feature = "bench")]
#[tauri::command]
pub async fn write_benchmark_report(path: String, contents: String) -> Result<(), String> {
    fs::write(path, contents).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn quit_app(app: AppHandle) -> Result<(), String> {
    app.exit(0);
    Ok(())
}

#[cfg(feature = "bench")]
#[tauri::command]
pub async fn get_benchmark_mode() -> Result<Option<String>, String> {
    Ok(runtime_modes::resolved_benchmark_mode().map(|mode| mode.as_str().to_string()))
}

#[cfg(not(feature = "bench"))]
#[tauri::command]
pub async fn get_benchmark_mode() -> Result<Option<String>, String> {
    Ok(None)
}

#[cfg(feature = "bench")]
#[tauri::command]
pub async fn get_benchmark_config() -> Result<runtime_modes::BenchmarkConfig, String> {
    Ok(runtime_modes::benchmark_config())
}

#[cfg(feature = "bench")]
#[tauri::command]
pub async fn get_stress_bench_config() -> Result<runtime_modes::StressBenchConfig, String> {
    Ok(runtime_modes::stress_bench_config())
}

#[cfg(feature = "bench")]
#[tauri::command]
pub async fn register_stress_session(
    session_id: String,
    scenario: String,
    perf: State<'_, std::sync::Arc<crate::perf_registry::PerfRegistry>>,
) -> Result<(), String> {
    let id = SessionId::parse(&session_id)?;
    perf.register(id, Some(scenario));
    Ok(())
}

#[cfg(feature = "bench")]
#[tauri::command]
pub async fn submit_stress_frontend_sample(
    session_id: String,
    write_ms: f64,
    perf: State<'_, std::sync::Arc<crate::perf_registry::PerfRegistry>>,
) -> Result<(), String> {
    let id = SessionId::parse(&session_id)?;
    perf.record_frontend_write(id, write_ms);
    Ok(())
}

#[cfg(feature = "bench")]
#[tauri::command]
pub async fn submit_stress_lifecycle(
    stage: String,
    ms: f64,
    perf: State<'_, std::sync::Arc<crate::perf_registry::PerfRegistry>>,
) -> Result<(), String> {
    perf.record_lifecycle(stage, ms);
    Ok(())
}

#[cfg(feature = "bench")]
#[tauri::command]
pub async fn finalize_stress_bench(
    output_path: String,
    duration_ms: u64,
    panes: u32,
    perf: State<'_, std::sync::Arc<crate::perf_registry::PerfRegistry>>,
) -> Result<(), String> {
    tracing::info!(%output_path, duration_ms, panes, "stress: finalize_stress_bench");
    let report = perf.snapshot();
    let payload = serde_json::json!({
        "duration_ms": duration_ms,
        "panes": panes,
        "lifecycle": report.lifecycle,
        "sessions": report.sessions,
        "aggregate": report.aggregate,
        "hotspots": report.hotspots,
    });
    let json = serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())?;
    fs::write(&output_path, json).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn get_font_config() -> FontConfig {
    FontConfig::DEFAULT
}

#[tauri::command]
pub async fn get_primary_session_id(
    state: State<'_, TerminalManager>,
) -> Result<Option<String>, String> {
    Ok(state.first_session_id().map(|id| id.to_string()))
}

#[tauri::command]
pub async fn list_sessions(state: State<'_, TerminalManager>) -> Result<Vec<SessionInfo>, String> {
    Ok(state.list_sessions())
}

#[tauri::command]
pub async fn restore_terminal_sessions(
    sessions: Vec<RestoreTerminalRequest>,
    state: State<'_, TerminalManager>,
    event_bus: State<'_, EventBus>,
) -> Result<Vec<SessionInfo>, String> {
    restore_terminal_sessions_for_runtime(sessions, state, event_bus).await
}

async fn restore_terminal_sessions_for_runtime<R: tauri::Runtime>(
    sessions: Vec<RestoreTerminalRequest>,
    state: State<'_, TerminalManager<R>>,
    event_bus: State<'_, EventBus<R>>,
) -> Result<Vec<SessionInfo>, String> {
    if sessions.is_empty() {
        return Err("at least one session is required to restore".to_string());
    }

    let session_ids = state
        .list_sessions()
        .into_iter()
        .filter_map(|session| SessionId::parse(&session.session_id).ok())
        .collect::<Vec<_>>();
    for session_id in session_ids {
        let _ = state.remove(&session_id);
    }

    let env = build_pane_env();
    let mut restored = Vec::with_capacity(sessions.len());
    for session in sessions {
        if session.cwd.is_empty() {
            return Err("restore_terminal_sessions: each session requires a non-empty cwd".into());
        }
        let session_id = state
            .create_session(SessionConfig {
                cwd: std::path::PathBuf::from(&session.cwd),
                env: env.clone(),
                cols: 80,
                rows: 24,
                ..Default::default()
            })
            .map_err(|error| error.to_string())?;
        event_bus.publish(BusEvent::SessionCreated {
            session_id: session_id.to_string(),
            agent_id: None,
        });
        let info = state
            .get(&session_id)
            .map(|entry| entry.info())
            .ok_or("restored session not found".to_string())?;
        restored.push(info);
    }

    Ok(restored)
}

#[tauri::command]
pub async fn list_agents() -> Result<Vec<AgentDefinition>, String> {
    let cwd = std::env::current_dir().map_err(|error| error.to_string())?;
    agents::load_agent_registry(&cwd).map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn list_rules() -> Result<Vec<RuleDefinition>, String> {
    let cwd = std::env::var("HOME")
        .ok()
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from("/"));
    agents::load_rules(&cwd).map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn launch_agent(
    request: LaunchAgentRequest,
    state: State<'_, TerminalManager>,
    event_bus: State<'_, EventBus>,
) -> Result<LaunchAgentResult, String> {
    let workspace_root = request
        .cwd
        .as_deref()
        .filter(|value| !value.is_empty())
        .map(std::path::PathBuf::from)
        .ok_or_else(|| "launch_agent: cwd is required".to_string())?;
    let result = agents::launch_agent(&state, &workspace_root, request)
        .map_err(|error| error.to_string())?;
    let agent_id = state
        .get(&SessionId::parse(&result.session_id)?)
        .and_then(|session| session.agent_id.clone());
    event_bus.publish(BusEvent::SessionCreated {
        session_id: result.session_id.clone(),
        agent_id,
    });
    Ok(result)
}

#[tauri::command]
pub async fn send_peer_message(
    context_session_id: Option<String>,
    message: PeerMessage,
    router: State<'_, Arc<PeerRouter>>,
) -> Result<(), String> {
    router.ingest_from_user(context_session_id, message);
    Ok(())
}

#[tauri::command]
pub async fn respond_to_approval(
    session_id: String,
    approval_id: String,
    choice: String,
    state: State<'_, TerminalManager>,
    event_bus: State<'_, EventBus>,
) -> Result<(), String> {
    let id = SessionId::parse(&session_id)?;
    let session = state.get(&id).ok_or("session not found")?;
    let payload = serde_json::json!({
        "ref": approval_id,
        "choice": choice,
    });
    session.send_control_message(&payload.to_string())?;
    event_bus.publish(BusEvent::UserApproval {
        session_id,
        approval_id,
        choice,
    });
    Ok(())
}

#[tauri::command]
pub async fn terminal_input(
    session_id: String,
    bytes: Vec<u8>,
    state: State<'_, TerminalManager>,
    event_bus: State<'_, EventBus>,
) -> Result<(), String> {
    let id = SessionId::parse(&session_id)?;
    let session = state.get(&id).ok_or("session not found")?;
    session.write(&bytes)?;
    session.term.lock().scroll_display(Scroll::Bottom);
    drop(session);
    state.mark_dirty(id);
    event_bus.publish(BusEvent::PtyInput { session_id, bytes });
    Ok(())
}

#[tauri::command]
pub async fn list_recordings(event_bus: State<'_, EventBus>) -> Result<Vec<RecordingInfo>, String> {
    Ok(event_bus.list_recordings())
}

#[tauri::command]
pub async fn read_recording(
    session_id: String,
    event_bus: State<'_, EventBus>,
) -> Result<String, String> {
    match parse_prefixed_session_id(&session_id) {
        Some((source, rest)) => history::read_transcript(source, rest),
        None => event_bus.read_recording(&session_id),
    }
}

#[tauri::command]
pub async fn list_history(event_bus: State<'_, EventBus>) -> Result<Vec<HistoryEntry>, String> {
    let mut entries = event_bus.list_history();
    entries.retain(|entry| entry.agent_id.is_some());
    let external = tokio::task::spawn_blocking(history::discover_all)
        .await
        .map_err(|e| e.to_string())?;
    merge_external(&mut entries, external);
    Ok(entries)
}

#[tauri::command]
pub async fn get_history_entry(
    session_id: String,
    event_bus: State<'_, EventBus>,
) -> Result<Option<HistoryEntry>, String> {
    if parse_prefixed_session_id(&session_id).is_some() {
        return Ok(None);
    }
    Ok(event_bus.get_history_entry(&session_id))
}

#[tauri::command]
pub async fn delete_history_entry(
    session_id: String,
    event_bus: State<'_, EventBus>,
) -> Result<(), String> {
    if parse_prefixed_session_id(&session_id).is_some() {
        return Err("imported sessions cannot be deleted from Lastty".to_string());
    }
    event_bus.delete_history_entry(&session_id)
}

#[tauri::command]
pub async fn set_history_entry_pinned(
    session_id: String,
    pinned: bool,
    event_bus: State<'_, EventBus>,
) -> Result<(), String> {
    if parse_prefixed_session_id(&session_id).is_some() {
        return Err("imported sessions cannot be pinned".to_string());
    }
    event_bus.set_history_entry_pinned(&session_id, pinned)
}

fn lookup_imported_entry(source: HistorySource, rest: &str) -> Option<HistoryEntry> {
    match source {
        HistorySource::ClaudeDisk => history::claude::find_entry(rest),
        HistorySource::CodexDisk => history::codex::find_entry(rest),
        HistorySource::Lastty => None,
    }
}

fn parse_prefixed_session_id(session_id: &str) -> Option<(HistorySource, &str)> {
    if let Some(rest) = session_id.strip_prefix("claude:") {
        return Some((HistorySource::ClaudeDisk, rest));
    }
    if let Some(rest) = session_id.strip_prefix("codex:") {
        return Some((HistorySource::CodexDisk, rest));
    }
    None
}

fn merge_external(entries: &mut Vec<HistoryEntry>, external: Vec<HistoryEntry>) {
    use std::collections::HashSet;
    let claimed: HashSet<(String, String)> = entries
        .iter()
        .filter_map(|entry| Some((entry.agent_id.clone()?, entry.agent_session_id.clone()?)))
        .collect();
    for entry in external {
        let key = match (entry.agent_id.clone(), entry.agent_session_id.clone()) {
            (Some(agent_id), Some(agent_session_id)) => Some((agent_id, agent_session_id)),
            _ => None,
        };
        if let Some(key) = key.as_ref() {
            if claimed.contains(key) {
                continue;
            }
        }
        entries.push(entry);
    }
    entries.sort_by(|a, b| {
        b.pinned
            .cmp(&a.pinned)
            .then_with(|| b.last_event_ms.cmp(&a.last_event_ms))
    });
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ResumeHistoryEntryResult {
    pub session_id: String,
    pub cwd: String,
    pub agent_id: Option<String>,
    pub resumed: bool,
}

#[tauri::command]
pub async fn resume_history_entry(
    session_id: String,
    state: State<'_, TerminalManager>,
    event_bus: State<'_, EventBus>,
) -> Result<ResumeHistoryEntryResult, String> {
    resume_history_entry_for_runtime(session_id, state, event_bus).await
}

async fn resume_history_entry_for_runtime<R: tauri::Runtime>(
    session_id: String,
    state: State<'_, TerminalManager<R>>,
    event_bus: State<'_, EventBus<R>>,
) -> Result<ResumeHistoryEntryResult, String> {
    let entry = match parse_prefixed_session_id(&session_id) {
        Some((source, rest)) => lookup_imported_entry(source, rest),
        None => event_bus.get_history_entry(&session_id),
    }
    .ok_or_else(|| "history entry not found".to_string())?;

    let cwd_path = if entry.cwd.is_empty() || !Path::new(&entry.cwd).is_dir() {
        std::env::var("HOME")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|_| std::path::PathBuf::from("/"))
    } else {
        std::path::PathBuf::from(&entry.cwd)
    };
    let cwd_path = cwd_path.as_path();

    let workspace_root = std::env::current_dir().map_err(|e| e.to_string())?;
    let agents = load_agent_registry(&workspace_root).map_err(|e| e.to_string())?;

    let (command, resumed) = match (entry.agent_id.as_deref(), entry.agent_session_id.as_deref()) {
        (Some(agent_id), Some(agent_session_id)) => {
            let agent = agents
                .into_iter()
                .find(|candidate| candidate.id == agent_id);
            match agent
                .as_ref()
                .and_then(|a| resume_command_spec(a, agent_session_id))
            {
                Some(spec) => (Some(spec), true),
                None => (None, false),
            }
        }
        _ => (None, false),
    };

    let env = build_pane_env();
    let new_session_id = state
        .create_session(SessionConfig {
            command,
            cwd: cwd_path.to_path_buf(),
            env,
            cols: 80,
            rows: 24,
            agent_id: entry.agent_id.clone(),
            prompt_summary: entry.prompt_summary.clone(),
            ..Default::default()
        })
        .map_err(|error| error.to_string())?;

    event_bus.publish(BusEvent::SessionCreated {
        session_id: new_session_id.to_string(),
        agent_id: entry.agent_id.clone(),
    });

    Ok(ResumeHistoryEntryResult {
        session_id: new_session_id.to_string(),
        cwd: cwd_path.display().to_string(),
        agent_id: entry.agent_id,
        resumed,
    })
}

#[tauri::command]
pub async fn get_git_info(cwd: String) -> Option<crate::git_info::GitInfo> {
    crate::git_info::detect(Path::new(&cwd))
}

#[tauri::command]
pub async fn git_graph(
    cwd: String,
    limit: Option<u32>,
) -> Result<crate::git_graph::GitGraph, String> {
    crate::git_graph::load(Path::new(&cwd), limit.unwrap_or(200)).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_git_branches(cwd: String) -> Result<Vec<crate::git_branches::GitBranch>, String> {
    crate::git_branches::list_branches(Path::new(&cwd)).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn checkout_git_branch(cwd: String, name: String) -> Result<(), String> {
    crate::git_branches::checkout_branch(Path::new(&cwd), &name).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_worktrees(cwd: String) -> Result<Vec<crate::git_worktrees::Worktree>, String> {
    crate::git_worktrees::list_worktrees(Path::new(&cwd)).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn is_git_repo(cwd: String) -> bool {
    crate::git_util::is_git_repo(Path::new(&cwd))
}

#[tauri::command]
pub async fn worktree_status(
    path: String,
    base_branch: String,
) -> Result<crate::git_worktrees::WorktreeStatus, String> {
    crate::git_worktrees::worktree_status(Path::new(&path), &base_branch).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_pull_request(
    req: crate::git_pr::CreatePrRequest,
) -> Result<crate::git_pr::CreatePrResult, String> {
    crate::git_pr::create_pull_request(&req).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn remove_worktree(path: String, repo_root: String) -> Result<(), String> {
    crate::git_pr::remove_worktree(Path::new(&path), Path::new(&repo_root))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn abandon_worktree(
    path: String,
    repo_root: String,
) -> Result<crate::git_pr::AbandonResult, String> {
    crate::git_pr::abandon_worktree(Path::new(&path), Path::new(&repo_root))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_prunable_worktrees(
    repo_root: String,
    base_branch: String,
) -> Result<Vec<crate::git_pr::PrunableWorktree>, String> {
    crate::git_pr::list_prunable_worktrees(Path::new(&repo_root), &base_branch)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn prune_local_if_clean(
    path: String,
    repo_root: String,
    base_branch: String,
) -> Result<bool, String> {
    crate::git_pr::prune_local_if_clean(Path::new(&path), Path::new(&repo_root), &base_branch)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_workspace_root() -> Result<String, String> {
    std::env::current_dir()
        .map(|p| p.display().to_string())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_terminal_frame(
    session_id: String,
    state: State<'_, TerminalManager>,
) -> Result<TerminalFrame, String> {
    let id = SessionId::parse(&session_id)?;
    let session = state.get(&id).ok_or("session not found")?;
    // Always full repaint here: the caller is the frontend's initial paint
    // for a (re-)mounted pane and has no prior state to diff against.
    let term = session.term.lock();
    Ok(crate::terminal::render::render_viewport_full(&term))
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct CloneResult {
    pub path: String,
    pub repo_name: String,
}

fn is_valid_clone_url(url: &str) -> bool {
    if url.starts_with("https://") || url.starts_with("http://") {
        return url.len() > "https://".len();
    }
    if url.starts_with("ssh://") || url.starts_with("git://") {
        return url.len() > "ssh://".len();
    }
    if let Some(rest) = url.strip_prefix("git@") {
        if let Some((host, path)) = rest.split_once(':') {
            return !host.is_empty() && !path.is_empty();
        }
    }
    false
}

fn derive_repo_name(url: &str) -> Option<String> {
    let trimmed = url.trim_end_matches('/');
    let tail = trimmed.rsplit(&['/', ':'][..]).next()?;
    let name = tail.strip_suffix(".git").unwrap_or(tail);
    if name.is_empty() || name == "." || name == ".." || name.contains('/') || name.contains('\\') {
        return None;
    }
    Some(name.to_string())
}

#[tauri::command]
pub async fn create_project(path: String) -> Result<String, String> {
    let target = Path::new(&path);
    let parent = target
        .parent()
        .ok_or_else(|| "project path has no parent directory".to_string())?;
    if !parent.is_dir() {
        return Err(format!(
            "parent directory does not exist: {}",
            parent.display()
        ));
    }
    if target.exists() {
        return Err(format!("destination already exists: {}", target.display()));
    }
    std::fs::create_dir(target).map_err(|error| error.to_string())?;
    Ok(target.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn clone_repo(url: String, parent_dir: String) -> Result<CloneResult, String> {
    if !is_valid_clone_url(&url) {
        return Err("invalid git URL".to_string());
    }
    let repo_name = derive_repo_name(&url).ok_or("could not derive repository name from URL")?;
    let parent = Path::new(&parent_dir);
    if !parent.is_dir() {
        return Err(format!("parent directory does not exist: {parent_dir}"));
    }
    let target = parent.join(&repo_name);
    if target.exists() {
        return Err(format!("destination already exists: {}", target.display()));
    }
    if let Err(error) = crate::git_util::git_clone(&url, &target) {
        if target.exists() {
            let _ = std::fs::remove_dir_all(&target);
        }
        return Err(error.to_string());
    }
    Ok(CloneResult {
        path: target.to_string_lossy().into_owned(),
        repo_name,
    })
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::mpsc;
    use std::sync::Arc;
    use std::time::Duration;

    use super::{
        restore_terminal_sessions_for_runtime, terminal_resize_for_runtime, RestoreTerminalRequest,
    };
    use crate::bus::EventBus;
    use crate::render_sync::RenderCoordinator;
    use crate::terminal::manager::TerminalManager;
    use crate::terminal::render::{spawn_frame_emitter, TerminalFrameEvent};
    use crate::terminal::session::{CommandSpec, SessionConfig, SessionId};
    use tauri::test::MockRuntime;
    use tauri::Listener;
    use tauri::Manager;

    #[test]
    fn terminal_resize_emits_a_fresh_term_frame_event() {
        let workspace_root = temp_dir("lastty-resize-frame");
        let recordings_dir = workspace_root.join("recordings");
        let app = tauri::test::mock_app();
        let render_coordinator = Arc::new(RenderCoordinator::new());

        assert!(app.manage(EventBus::new(app.handle().clone(), recordings_dir)));
        assert!(app.manage(TerminalManager::new(
            app.handle().clone(),
            render_coordinator.clone()
        )));

        let (tx, rx) = mpsc::channel::<TerminalFrameEvent>();
        let tx_for_listener = tx.clone();
        app.listen_any("term:frame", move |event| {
            let payload = serde_json::from_str::<TerminalFrameEvent>(event.payload())
                .expect("term:frame payload should deserialize");
            tx_for_listener.send(payload).unwrap();
        });

        let manager = app.state::<TerminalManager<MockRuntime>>();
        let session_id = manager
            .create_session(SessionConfig {
                command: Some(CommandSpec {
                    program: "/bin/sh".to_string(),
                    args: vec!["-lc".to_string(), "sleep 30".to_string()],
                }),
                cwd: workspace_root.clone(),
                env: pane_env(),
                cols: 80,
                rows: 24,
                ..Default::default()
            })
            .expect("should create test session");

        let _frame_emitter =
            spawn_frame_emitter(app.handle().clone(), render_coordinator, session_id);

        let initial = recv_frame(&rx);
        assert_eq!(initial.session_id, session_id.to_string());

        tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(terminal_resize_for_runtime(
                session_id.to_string(),
                100,
                30,
                app.state::<TerminalManager<MockRuntime>>(),
                app.state::<EventBus<MockRuntime>>(),
            ))
            .expect("resize command should succeed");

        let resized = recv_frame(&rx);
        assert_eq!(resized.session_id, session_id.to_string());
        assert!(
            resized.frame.ansi.len() > initial.frame.ansi.len(),
            "expected resize to emit a larger blank-frame payload after growing the viewport"
        );

        cleanup_sessions(&app);
        drop(tx);
    }

    #[test]
    fn restore_terminal_sessions_replaces_existing_sessions_with_requested_cwds() {
        let workspace_root = temp_dir("lastty-restore-sessions");
        let recordings_dir = workspace_root.join("recordings");
        let restore_a = workspace_root.join("restore-a");
        let restore_b = workspace_root.join("restore-b");
        fs::create_dir_all(&restore_a).unwrap();
        fs::create_dir_all(&restore_b).unwrap();

        let app = tauri::test::mock_app();
        let render_coordinator = Arc::new(RenderCoordinator::new());

        assert!(app.manage(EventBus::new(app.handle().clone(), recordings_dir)));
        assert!(app.manage(TerminalManager::new(
            app.handle().clone(),
            render_coordinator
        )));

        let manager = app.state::<TerminalManager<MockRuntime>>();
        let original = manager
            .create_session(SessionConfig {
                cwd: workspace_root.clone(),
                env: pane_env(),
                cols: 80,
                rows: 24,
                ..Default::default()
            })
            .expect("should create initial session");

        let restored = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(restore_terminal_sessions_for_runtime(
                vec![
                    RestoreTerminalRequest {
                        cwd: restore_a.display().to_string(),
                    },
                    RestoreTerminalRequest {
                        cwd: restore_b.display().to_string(),
                    },
                ],
                app.state::<TerminalManager<MockRuntime>>(),
                app.state::<EventBus<MockRuntime>>(),
            ))
            .expect("restore command should succeed");

        assert_eq!(restored.len(), 2);
        assert!(restored
            .iter()
            .all(|session| session.session_id != original.to_string()));
        assert_eq!(restored[0].cwd, restore_a.display().to_string());
        assert_eq!(restored[1].cwd, restore_b.display().to_string());

        cleanup_sessions(&app);
    }

    fn recv_frame(rx: &mpsc::Receiver<TerminalFrameEvent>) -> TerminalFrameEvent {
        rx.recv_timeout(Duration::from_secs(2))
            .expect("expected term:frame event")
    }

    fn pane_env() -> HashMap<String, String> {
        HashMap::from([
            ("TERM".to_string(), "xterm-256color".to_string()),
            ("COLORTERM".to_string(), "truecolor".to_string()),
            ("LASTTY".to_string(), "1".to_string()),
        ])
    }

    fn cleanup_sessions<R: tauri::Runtime>(app: &tauri::App<R>) {
        let manager = app.state::<TerminalManager<R>>();
        let session_ids = manager
            .list_sessions()
            .into_iter()
            .filter_map(|session| SessionId::parse(&session.session_id).ok())
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

    #[test]
    fn is_valid_clone_url_accepts_common_schemes() {
        for url in [
            "https://github.com/cli/cli",
            "https://github.com/cli/cli.git",
            "http://example.com/repo.git",
            "ssh://git@github.com/cli/cli.git",
            "git://example.com/repo.git",
            "git@github.com:cli/cli.git",
        ] {
            assert!(super::is_valid_clone_url(url), "{url} should be valid");
        }
    }

    #[test]
    fn is_valid_clone_url_rejects_bad_input() {
        for url in [
            "",
            "https://",
            "ssh://",
            "--upload-pack=/bin/sh",
            "; rm -rf /",
            "/tmp/local-path",
            "git@",
            "git@github.com",
            "git@:path",
        ] {
            assert!(!super::is_valid_clone_url(url), "{url} should be invalid");
        }
    }

    #[test]
    fn derive_repo_name_handles_common_shapes() {
        assert_eq!(
            super::derive_repo_name("https://github.com/cli/cli"),
            Some("cli".to_string())
        );
        assert_eq!(
            super::derive_repo_name("https://github.com/cli/cli.git"),
            Some("cli".to_string())
        );
        assert_eq!(
            super::derive_repo_name("https://github.com/cli/cli/"),
            Some("cli".to_string())
        );
        assert_eq!(
            super::derive_repo_name("git@github.com:cli/cli.git"),
            Some("cli".to_string())
        );
        assert_eq!(
            super::derive_repo_name("ssh://git@host/group/subgroup/proj.git"),
            Some("proj".to_string())
        );
    }

    #[test]
    fn derive_repo_name_rejects_empty_or_traversal() {
        assert_eq!(super::derive_repo_name(""), None);
        assert_eq!(super::derive_repo_name(".git"), None);
        assert_eq!(super::derive_repo_name("https://host/."), None);
        assert_eq!(super::derive_repo_name("https://host/.."), None);
    }
}
