use std::path::{Path, PathBuf};
use std::sync::Arc;

use dashmap::DashMap;
use tauri::{AppHandle, Runtime};

use crate::adapters::AgentAdapter;
use crate::render_sync::RenderCoordinator;

use super::session::{self, SessionConfig, SessionId, SessionInfo, TerminalSession};

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

    pub fn create_session(&self, config: SessionConfig) -> anyhow::Result<SessionId> {
        self.create_session_with_adapter(config, None)
    }

    pub fn create_session_with_adapter(
        &self,
        config: SessionConfig,
        adapter: Option<Box<dyn AgentAdapter>>,
    ) -> anyhow::Result<SessionId> {
        let session = session::create_session(
            config,
            self.render_coordinator.clone(),
            self.app.clone(),
            adapter,
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

    /// Return the ids of live sessions whose effective checkout (worktree_path
    /// if set, else cwd) canonicalises to the same path as `target`. Used to
    /// decide whether an in-place launch should auto-promote to a worktree.
    /// Sessions are removed from the registry on PTY exit, so membership is a
    /// good proxy for "live".
    pub fn live_sessions_on(&self, target: &Path) -> Vec<SessionId> {
        let target = canonical(target);
        self.sessions
            .iter()
            .filter_map(|entry| {
                let effective = effective_checkout(entry.value());
                if canonical(&effective) == target {
                    Some(*entry.key())
                } else {
                    None
                }
            })
            .collect()
    }
}

fn effective_checkout<R: Runtime>(session: &TerminalSession<R>) -> PathBuf {
    if let Some(path) = session.worktree_path.as_ref() {
        return PathBuf::from(path);
    }
    let guard = session.cwd.lock().expect("session cwd lock poisoned");
    PathBuf::from(&*guard)
}

fn canonical(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}
