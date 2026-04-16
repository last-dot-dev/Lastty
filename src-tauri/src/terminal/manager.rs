use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use dashmap::DashMap;
use tauri::{AppHandle, Runtime};

use crate::render_sync::RenderCoordinator;

use super::session::{self, CommandSpec, SessionId, SessionInfo, TerminalSession};

/// Registry of active terminal sessions.
pub struct TerminalManager<R: Runtime = tauri::Wry> {
    sessions: DashMap<SessionId, TerminalSession<R>>,
    app: AppHandle<R>,
    render_coordinator: Arc<RenderCoordinator>,
}

impl<R: Runtime> TerminalManager<R> {
    pub fn new(app: AppHandle<R>, render_coordinator: Arc<RenderCoordinator>) -> Self {
        Self {
            sessions: DashMap::new(),
            app,
            render_coordinator,
        }
    }

    pub fn create_session(
        &self,
        command: Option<CommandSpec>,
        cwd: &Path,
        env: &HashMap<String, String>,
        cols: u16,
        rows: u16,
        agent_id: Option<String>,
        prompt_summary: Option<String>,
        prompt: Option<String>,
        worktree_path: Option<String>,
    ) -> anyhow::Result<SessionId> {
        let session = session::create_session(
            command.as_ref(),
            cwd,
            env,
            cols,
            rows,
            self.render_coordinator.clone(),
            self.app.clone(),
            agent_id,
            prompt_summary,
            prompt,
            worktree_path,
        )?;
        let session_id = session.id;
        self.sessions.insert(session_id, session);
        Ok(session_id)
    }

    pub fn get(
        &self,
        id: &SessionId,
    ) -> Option<dashmap::mapref::one::Ref<'_, SessionId, TerminalSession<R>>> {
        self.sessions.get(id)
    }

    pub fn remove(&self, id: &SessionId) -> Option<TerminalSession<R>> {
        self.sessions.remove(id).map(|(_, s)| {
            s.shutdown();
            s
        })
    }

    pub fn mark_dirty(&self, id: SessionId) {
        self.render_coordinator.mark_dirty(id);
    }

    pub fn first_session_id(&self) -> Option<SessionId> {
        self.sessions.iter().next().map(|entry| *entry.key())
    }

    pub fn list_sessions(&self) -> Vec<SessionInfo> {
        self.sessions
            .iter()
            .map(|entry| entry.value().info())
            .collect()
    }
}
