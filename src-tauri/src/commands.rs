use std::collections::HashMap;
use std::fs;
use std::path::Path;

use tauri::{AppHandle, State};

use crate::terminal::manager::TerminalManager;
use crate::terminal::render::TerminalFrame;
use crate::terminal::session::SessionId;

/// Build environment variables for the terminal session.
fn build_pane_env() -> HashMap<String, String> {
    let mut env = HashMap::new();
    env.insert("TERM".to_string(), "xterm-256color".to_string());
    env.insert("COLORTERM".to_string(), "truecolor".to_string());
    env.insert("LASTTY".to_string(), "1".to_string());
    env
}

#[tauri::command]
pub async fn create_terminal(
    cwd: String,
    command: Option<String>,
    state: State<'_, TerminalManager>,
) -> Result<String, String> {
    let env = build_pane_env();
    let session_id = state
        .create_session(command.as_deref(), Path::new(&cwd), &env, 80, 24)
        .map_err(|e| e.to_string())?;
    Ok(session_id.to_string())
}

#[tauri::command]
pub async fn terminal_resize(
    session_id: String,
    cols: u16,
    rows: u16,
    state: State<'_, TerminalManager>,
) -> Result<(), String> {
    let id = SessionId::parse(&session_id)?;
    let session = state.get(&id).ok_or("session not found")?;
    session.resize(cols, rows, 8, 16)
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
    Ok(std::env::var("LASTTY_BENCH_MODE").ok())
}

#[tauri::command]
pub async fn get_renderer_mode() -> Result<Option<String>, String> {
    Ok(std::env::var("LASTTY_RENDERER").ok())
}

#[tauri::command]
pub async fn get_primary_session_id(
    state: State<'_, TerminalManager>,
) -> Result<Option<String>, String> {
    Ok(state.first_session_id().map(|id| id.to_string()))
}

#[tauri::command]
pub async fn terminal_input(
    session_id: String,
    bytes: Vec<u8>,
    state: State<'_, TerminalManager>,
) -> Result<(), String> {
    let id = SessionId::parse(&session_id)?;
    let session = state.get(&id).ok_or("session not found")?;
    session.write(&bytes)?;
    Ok(())
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
