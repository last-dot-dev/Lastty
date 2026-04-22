use std::path::Path;

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};

use crate::git_util::{run_git_checked, run_git_trim};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Worktree {
    pub path: String,
    pub branch: String,
    pub head: String,
    pub is_main: bool,
    pub is_lastty: bool,
    pub detached: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorktreeStatus {
    pub uncommitted_files: u32,
    pub unmerged_commits: u32,
    pub base_branch: Option<String>,
    pub changed_files: Vec<ChangedFile>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChangedFile {
    pub path: String,
    pub status: ChangeStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChangeStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
    Copied,
    Untracked,
    Ignored,
    TypeChange,
    Conflicted,
    Other,
}

const LASTTY_DIRNAME: &str = ".lastty-worktrees";
// Recognize worktrees created before the rename so they still show as managed.
const LEGACY_DIRNAME: &str = ".pane-worktrees";

pub fn list_worktrees(repo_root: &Path) -> Result<Vec<Worktree>> {
    if !crate::git_util::is_git_repo(repo_root) {
        return Ok(Vec::new());
    }
    let stdout = run_git_checked(repo_root, &["worktree", "list", "--porcelain"])?;
    let main_path = run_git_trim(repo_root, &["rev-parse", "--show-toplevel"])
        .ok_or_else(|| anyhow!("not inside a git repository: {}", repo_root.display()))?;
    let lastty_root = Path::new(&main_path).join(LASTTY_DIRNAME);
    let legacy_root = Path::new(&main_path).join(LEGACY_DIRNAME);

    let mut out = Vec::new();
    let mut current: Option<WorktreePartial> = None;

    for line in stdout.lines() {
        if line.is_empty() {
            if let Some(partial) = current.take() {
                out.push(partial.finish(&main_path, &lastty_root, &legacy_root));
            }
            continue;
        }
        if let Some(rest) = line.strip_prefix("worktree ") {
            if let Some(partial) = current.take() {
                out.push(partial.finish(&main_path, &lastty_root, &legacy_root));
            }
            current = Some(WorktreePartial::new(rest.to_string()));
        } else if let Some(partial) = current.as_mut() {
            if let Some(rest) = line.strip_prefix("HEAD ") {
                partial.head = rest.to_string();
            } else if let Some(rest) = line.strip_prefix("branch ") {
                partial.branch = Some(rest.strip_prefix("refs/heads/").unwrap_or(rest).to_string());
            } else if line == "detached" {
                partial.detached = true;
            }
        }
    }
    if let Some(partial) = current.take() {
        out.push(partial.finish(&main_path, &lastty_root, &legacy_root));
    }
    Ok(out)
}

pub fn worktree_status(worktree: &Path, base_branch: &str) -> Result<WorktreeStatus> {
    let porcelain = run_git_checked(worktree, &["status", "--porcelain"])?;
    let changed_files: Vec<ChangedFile> = porcelain
        .lines()
        .filter(|l| !l.is_empty())
        .filter_map(parse_porcelain_line)
        .collect();
    let uncommitted_files = changed_files.len() as u32;

    let base = base_branch.trim();
    let base_branch = if base.is_empty() {
        None
    } else {
        Some(base.to_string())
    };
    let unmerged_commits = match base_branch.as_deref() {
        Some(base) => {
            let range = format!("{base}..HEAD");
            match run_git_trim(worktree, &["rev-list", "--count", &range]) {
                Some(text) => text.parse::<u32>().unwrap_or(0),
                None => 0,
            }
        }
        None => 0,
    };

    Ok(WorktreeStatus {
        uncommitted_files,
        unmerged_commits,
        base_branch,
        changed_files,
    })
}

fn parse_porcelain_line(line: &str) -> Option<ChangedFile> {
    if line.len() < 3 {
        return None;
    }
    let (code, rest) = line.split_at(2);
    let path = rest.trim_start().to_string();
    let status = classify_code(code);
    Some(ChangedFile { path, status })
}

fn classify_code(code: &str) -> ChangeStatus {
    let bytes = code.as_bytes();
    if bytes.len() < 2 {
        return ChangeStatus::Other;
    }
    let index = bytes[0] as char;
    let wtree = bytes[1] as char;
    if index == 'U'
        || wtree == 'U'
        || (index == 'A' && wtree == 'A')
        || (index == 'D' && wtree == 'D')
    {
        return ChangeStatus::Conflicted;
    }
    if index == '?' && wtree == '?' {
        return ChangeStatus::Untracked;
    }
    if index == '!' && wtree == '!' {
        return ChangeStatus::Ignored;
    }
    let primary = if index != ' ' { index } else { wtree };
    match primary {
        'A' => ChangeStatus::Added,
        'M' => ChangeStatus::Modified,
        'D' => ChangeStatus::Deleted,
        'R' => ChangeStatus::Renamed,
        'C' => ChangeStatus::Copied,
        'T' => ChangeStatus::TypeChange,
        _ => ChangeStatus::Other,
    }
}

struct WorktreePartial {
    path: String,
    head: String,
    branch: Option<String>,
    detached: bool,
}

impl WorktreePartial {
    fn new(path: String) -> Self {
        Self {
            path,
            head: String::new(),
            branch: None,
            detached: false,
        }
    }

    fn finish(self, main_path: &str, lastty_root: &Path, legacy_root: &Path) -> Worktree {
        let is_main = paths_equal(&self.path, main_path);
        let path = Path::new(&self.path);
        let is_lastty = path.starts_with(lastty_root) || path.starts_with(legacy_root);
        let branch = self
            .branch
            .unwrap_or_else(|| if self.detached { "(detached)" } else { "" }.to_string());
        Worktree {
            path: self.path,
            branch,
            head: self.head,
            is_main,
            is_lastty,
            detached: self.detached,
        }
    }
}

fn paths_equal(a: &str, b: &str) -> bool {
    Path::new(a) == Path::new(b)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::process::Command;

    fn run(cwd: &Path, args: &[&str]) {
        let output = Command::new("git")
            .current_dir(cwd)
            .args(args)
            .output()
            .expect("git ran");
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn init_repo_with_commit() -> PathBuf {
        let tmp = std::env::temp_dir().join(format!("lastty-wt-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).expect("create tmp");
        run(&tmp, &["init", "--initial-branch=main"]);
        run(&tmp, &["config", "user.email", "test@example.com"]);
        run(&tmp, &["config", "user.name", "Test"]);
        run(&tmp, &["config", "commit.gpgsign", "false"]);
        std::fs::write(tmp.join("a.txt"), "hello").expect("write");
        run(&tmp, &["add", "a.txt"]);
        run(&tmp, &["commit", "-m", "initial"]);
        tmp
    }

    #[test]
    fn list_discovers_main_and_secondaries() {
        let tmp = init_repo_with_commit();
        let wt_root = tmp.join(".lastty-worktrees");
        std::fs::create_dir_all(&wt_root).expect("mkdir");
        let feature_dir = wt_root.join("lastty-feature-001");
        run(
            &tmp,
            &[
                "worktree",
                "add",
                "-b",
                "lastty-feature-001",
                feature_dir.to_string_lossy().as_ref(),
            ],
        );

        let worktrees = list_worktrees(&tmp).expect("list");
        assert_eq!(worktrees.len(), 2);
        let main = worktrees.iter().find(|w| w.is_main).expect("main present");
        assert_eq!(main.branch, "main");
        assert!(!main.is_lastty);
        let secondary = worktrees
            .iter()
            .find(|w| !w.is_main)
            .expect("secondary present");
        assert_eq!(secondary.branch, "lastty-feature-001");
        assert!(secondary.is_lastty, "secondary under .lastty-worktrees");
        assert!(!secondary.detached);

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn status_counts_uncommitted_and_unmerged() {
        let tmp = init_repo_with_commit();
        let wt_root = tmp.join(".lastty-worktrees");
        std::fs::create_dir_all(&wt_root).expect("mkdir");
        let feature_dir = wt_root.join("lastty-feature-002");
        run(
            &tmp,
            &[
                "worktree",
                "add",
                "-b",
                "lastty-feature-002",
                feature_dir.to_string_lossy().as_ref(),
            ],
        );

        // One committed change
        std::fs::write(feature_dir.join("b.txt"), "new").expect("write b");
        run(&feature_dir, &["add", "b.txt"]);
        run(&feature_dir, &["commit", "-m", "add b"]);

        // One uncommitted change
        std::fs::write(feature_dir.join("a.txt"), "hello world").expect("edit a");

        let status = worktree_status(&feature_dir, "main").expect("status");
        assert_eq!(status.uncommitted_files, 1);
        assert_eq!(status.unmerged_commits, 1);
        assert_eq!(status.base_branch.as_deref(), Some("main"));

        std::fs::remove_dir_all(&tmp).ok();
    }
}
