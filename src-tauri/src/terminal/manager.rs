use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use dashmap::DashMap;
use tauri::AppHandle;

use crate::render_sync::RenderCoordinator;

use super::session::{self, SessionId, TerminalSession};

/// Registry of active terminal sessions.
pub struct TerminalManager {
    sessions: DashMap<SessionId, TerminalSession>,
    app: AppHandle,
    render_coordinator: Arc<RenderCoordinator>,
}

impl TerminalManager {
    pub fn new(app: AppHandle, render_coordinator: Arc<RenderCoordinator>) -> Self {
        Self {
            sessions: DashMap::new(),
            app,
            render_coordinator,
        }
    }

    pub fn create_session(
        &self,
        command: Option<&str>,
        cwd: &Path,
        env: &HashMap<String, String>,
        cols: u16,
        rows: u16,
    ) -> anyhow::Result<SessionId> {
        let session = session::create_session(
            command,
            cwd,
            env,
            cols,
            rows,
            self.render_coordinator.clone(),
            self.app.clone(),
        )?;
        let session_id = session.id;
        self.sessions.insert(session_id, session);
        Ok(session_id)
    }

    pub fn get(
        &self,
        id: &SessionId,
    ) -> Option<dashmap::mapref::one::Ref<'_, SessionId, TerminalSession>> {
        self.sessions.get(id)
    }

    pub fn remove(&self, id: &SessionId) -> Option<TerminalSession> {
        self.sessions.remove(id).map(|(_, s)| {
            s.shutdown();
            s
        })
    }

    pub fn first_session_id(&self) -> Option<SessionId> {
        self.sessions.iter().next().map(|entry| *entry.key())
    }
}
