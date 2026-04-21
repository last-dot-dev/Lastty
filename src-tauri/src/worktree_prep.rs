use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread;
use std::time::Duration;

use anyhow::Result;
use serde::Deserialize;

use crate::agents::SyncPolicy;

const SYNC_CONFIG_PATH: &str = ".lastty/worktree-sync.toml";
const SHARED_DIR: &str = ".pane-shared";
const CARGO_TARGET_SUBDIR: &str = "cargo-target";
const DEFAULT_COPY_GLOBS: &[&str] = &[".env", ".env.local"];
const HOOK_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Debug, Default, Deserialize)]
struct SyncConfig {
    #[serde(default)]
    copy: Vec<String>,
    #[serde(default)]
    post_create: Option<String>,
}

pub struct PreparedWorktree {
    pub env: HashMap<String, String>,
    hook: Option<PendingHook>,
}

struct PendingHook {
    command: String,
    worktree: PathBuf,
}

impl PreparedWorktree {
    /// Fire the post-create hook (if any) in a detached thread so we don't
    /// block the agent from starting. The hook's output goes to stderr.
    pub fn spawn_post_create_hook(self) {
        let Some(PendingHook { command, worktree }) = self.hook else {
            return;
        };
        thread::spawn(move || {
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
            let mut child = match Command::new(&shell)
                .args(["-lc", &command])
                .current_dir(&worktree)
                .spawn()
            {
                Ok(child) => child,
                Err(error) => {
                    tracing::warn!(
                        worktree = %worktree.display(),
                        %error,
                        "failed to spawn worktree post_create hook",
                    );
                    return;
                }
            };
            let start = std::time::Instant::now();
            loop {
                match child.try_wait() {
                    Ok(Some(status)) => {
                        if !status.success() {
                            tracing::warn!(
                                worktree = %worktree.display(),
                                code = ?status.code(),
                                "worktree post_create hook exited with non-zero status",
                            );
                        }
                        return;
                    }
                    Ok(None) => {
                        if start.elapsed() > HOOK_TIMEOUT {
                            let _ = child.kill();
                            tracing::warn!(
                                worktree = %worktree.display(),
                                "worktree post_create hook timed out after {:?}",
                                HOOK_TIMEOUT,
                            );
                            return;
                        }
                        thread::sleep(Duration::from_millis(200));
                    }
                    Err(error) => {
                        tracing::warn!(
                            worktree = %worktree.display(),
                            %error,
                            "error while awaiting worktree post_create hook",
                        );
                        return;
                    }
                }
            }
        });
    }
}

/// Prepare a freshly created worktree for use: compute env overrides for the
/// agent (e.g. a shared CARGO_TARGET_DIR), copy untracked config files from
/// the main checkout, and queue the user post-create hook.
pub fn prepare(
    main_checkout: &Path,
    new_worktree: &Path,
    sync: SyncPolicy,
) -> Result<PreparedWorktree> {
    if matches!(sync, SyncPolicy::Clean) {
        return Ok(PreparedWorktree {
            env: HashMap::new(),
            hook: None,
        });
    }

    let config = load_config(main_checkout).unwrap_or_default();

    let mut env = HashMap::new();
    let shared_cargo = main_checkout.join(SHARED_DIR).join(CARGO_TARGET_SUBDIR);
    std::fs::create_dir_all(&shared_cargo).ok();
    env.insert(
        "CARGO_TARGET_DIR".to_string(),
        shared_cargo.to_string_lossy().to_string(),
    );

    copy_sync_files(main_checkout, new_worktree, &config);

    let hook = config
        .post_create
        .filter(|value| !value.trim().is_empty())
        .map(|command| PendingHook {
            command,
            worktree: new_worktree.to_path_buf(),
        });

    Ok(PreparedWorktree { env, hook })
}

fn load_config(main_checkout: &Path) -> Option<SyncConfig> {
    let path = main_checkout.join(SYNC_CONFIG_PATH);
    let contents = std::fs::read_to_string(&path).ok()?;
    match toml::from_str::<SyncConfig>(&contents) {
        Ok(config) => Some(config),
        Err(error) => {
            tracing::warn!(
                path = %path.display(),
                %error,
                "failed to parse worktree-sync.toml; using defaults",
            );
            None
        }
    }
}

fn copy_sync_files(main_checkout: &Path, new_worktree: &Path, config: &SyncConfig) {
    let globs: Vec<String> = if config.copy.is_empty() {
        DEFAULT_COPY_GLOBS.iter().map(|s| s.to_string()).collect()
    } else {
        config.copy.clone()
    };

    for pattern in globs {
        for source in glob_untracked(main_checkout, &pattern) {
            let relative = match source.strip_prefix(main_checkout) {
                Ok(rel) => rel.to_path_buf(),
                Err(_) => continue,
            };
            let dest = new_worktree.join(&relative);
            if let Some(parent) = dest.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            if let Err(error) = std::fs::copy(&source, &dest) {
                tracing::warn!(
                    source = %source.display(),
                    dest = %dest.display(),
                    %error,
                    "failed to copy untracked file into new worktree",
                );
            }
        }
    }
}

/// Minimal glob: supports trailing `*` in the filename (e.g. `.env*`), exact
/// filenames, and single-segment directory copies. Anything fancier is the
/// user's job via the post_create hook.
fn glob_untracked(root: &Path, pattern: &str) -> Vec<PathBuf> {
    let pattern = pattern.trim();
    if pattern.is_empty() || pattern.contains("..") {
        return Vec::new();
    }

    // If the pattern contains a slash, resolve it as a literal relative path.
    if pattern.contains('/') {
        let candidate = root.join(pattern);
        return if candidate.exists() {
            vec![candidate]
        } else {
            Vec::new()
        };
    }

    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut matches = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if pattern_matches(&name_str, pattern) {
            matches.push(entry.path());
        }
    }
    matches
}

fn pattern_matches(name: &str, pattern: &str) -> bool {
    if let Some(prefix) = pattern.strip_suffix('*') {
        name.starts_with(prefix)
    } else {
        name == pattern
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pattern_matches_exact_and_wildcard() {
        assert!(pattern_matches(".env", ".env"));
        assert!(!pattern_matches(".env.local", ".env"));
        assert!(pattern_matches(".env", ".env*"));
        assert!(pattern_matches(".env.local", ".env*"));
        assert!(!pattern_matches("Cargo.toml", ".env*"));
    }

    #[test]
    fn prepare_clean_returns_empty_env() {
        let tmp = std::env::temp_dir().join(format!("lastty-prep-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        let prepared = prepare(&tmp, &tmp, SyncPolicy::Clean).unwrap();
        assert!(prepared.env.is_empty());
        assert!(prepared.hook.is_none());
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn prepare_shared_sets_cargo_target_dir_and_copies_dotfiles() {
        let main = std::env::temp_dir().join(format!("lastty-prep-main-{}", uuid::Uuid::new_v4()));
        let worktree = main.join(".pane-worktrees").join("lastty-test-001");
        std::fs::create_dir_all(&main).unwrap();
        std::fs::create_dir_all(&worktree).unwrap();
        std::fs::write(main.join(".env"), "FOO=1").unwrap();
        std::fs::write(main.join(".env.local"), "BAR=2").unwrap();

        let prepared = prepare(&main, &worktree, SyncPolicy::Shared).unwrap();

        let target_dir = prepared
            .env
            .get("CARGO_TARGET_DIR")
            .expect("CARGO_TARGET_DIR should be set under Shared policy");
        assert!(target_dir.ends_with("cargo-target"));
        assert!(
            worktree.join(".env").exists(),
            ".env should be copied into the new worktree",
        );
        assert!(
            worktree.join(".env.local").exists(),
            ".env.local should be copied into the new worktree",
        );

        std::fs::remove_dir_all(&main).ok();
    }
}
