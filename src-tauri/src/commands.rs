use std::collections::HashMap;
use std::fs;
use std::path::Path;

use serde::Deserialize;
use tauri::{AppHandle, State};

use crate::agents::{self, AgentDefinition, LaunchAgentRequest, LaunchAgentResult, RuleDefinition};
use crate::bus::{BusEvent, EventBus, RecordingInfo};
use crate::runtime_modes;
use crate::terminal::manager::TerminalManager;
use crate::terminal::render::TerminalFrame;
use crate::terminal::session::CommandSpec;
use crate::terminal::session::{SessionId, SessionInfo};

/// Build environment variables for the terminal session.
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
    state: State<'_, TerminalManager>,
    event_bus: State<'_, EventBus>,
) -> Result<String, String> {
    let env = build_pane_env();
    let cwd = cwd
        .map(std::path::PathBuf::from)
        .or_else(|| std::env::var("HOME").ok().map(std::path::PathBuf::from))
        .unwrap_or_else(|| std::path::PathBuf::from("/"));
    let command = command.map(|program| CommandSpec {
        program,
        args: Vec::new(),
    });
    let session_id = state
        .create_session(
            command,
            Path::new(&cwd),
            &env,
            80,
            24,
            None,
            None,
            None,
            None,
        )
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
pub async fn kill_terminal(
    session_id: String,
    state: State<'_, TerminalManager>,
) -> Result<(), String> {
    let id = SessionId::parse(&session_id)?;
    state.remove(&id).ok_or("session not found".to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn key_input(
    key: String,
    code: String,
    ctrl: bool,
    alt: bool,
    shift: bool,
    meta: bool,
    state: State<'_, TerminalManager>,
) -> Result<(), String> {
    // For Phase 1, we only have one session.
    let session_id = state.first_session_id().ok_or("no active session")?;
    let session = state.get(&session_id).ok_or("session not found")?;

    let mode = if crate::input::key_requires_mode_lookup(&code) {
        Some(*session.term.lock().mode())
    } else {
        None
    };

    if let Some(bytes) = crate::input::key_to_bytes(&key, &code, ctrl, alt, shift, meta, mode) {
        session.write(&bytes)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn write_benchmark_report(path: String, contents: String) -> Result<(), String> {
    fs::write(path, contents).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn quit_app(app: AppHandle) -> Result<(), String> {
    app.exit(0);
    Ok(())
}

#[tauri::command]
pub async fn get_benchmark_mode() -> Result<Option<String>, String> {
    Ok(runtime_modes::resolved_benchmark_mode().map(|mode| mode.as_str().to_string()))
}

#[tauri::command]
pub async fn get_renderer_mode() -> Result<Option<String>, String> {
    let resolved = match runtime_modes::resolved_renderer_mode() {
        runtime_modes::RendererMode::AlacrittySpike => runtime_modes::RendererMode::Xterm,
        mode => mode,
    };
    Ok(Some(resolved.as_str().to_string()))
}

#[tauri::command]
pub async fn get_benchmark_config() -> Result<runtime_modes::BenchmarkConfig, String> {
    Ok(runtime_modes::benchmark_config())
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
        let session_id = state
            .create_session(
                None,
                Path::new(&session.cwd),
                &env,
                80,
                24,
                None,
                None,
                None,
                None,
            )
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
    let cwd = std::env::current_dir().map_err(|error| error.to_string())?;
    agents::load_rules(&cwd).map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn launch_agent(
    request: LaunchAgentRequest,
    state: State<'_, TerminalManager>,
    event_bus: State<'_, EventBus>,
) -> Result<LaunchAgentResult, String> {
    let cwd = std::env::current_dir().map_err(|error| error.to_string())?;
    let result = agents::launch_agent(&state, &cwd, request).map_err(|error| error.to_string())?;
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
    event_bus.read_recording(&session_id)
}

#[tauri::command]
pub async fn get_terminal_frame(
    session_id: String,
    state: State<'_, TerminalManager>,
) -> Result<TerminalFrame, String> {
    let id = SessionId::parse(&session_id)?;
    let session = state.get(&id).ok_or("session not found")?;
    let term = session.term.lock();
    Ok(crate::terminal::render::render_viewport(&term))
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
    use crate::terminal::session::{CommandSpec, SessionId};
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
            .create_session(
                Some(CommandSpec {
                    program: "/bin/sh".to_string(),
                    args: vec!["-lc".to_string(), "sleep 30".to_string()],
                }),
                &workspace_root,
                &pane_env(),
                80,
                24,
                None,
                None,
                None,
                None,
            )
            .expect("should create test session");
        drop(manager);

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
            .create_session(None, &workspace_root, &pane_env(), 80, 24, None, None, None, None)
            .expect("should create initial session");
        drop(manager);

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
        assert!(restored.iter().all(|session| session.session_id != original.to_string()));
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
}
