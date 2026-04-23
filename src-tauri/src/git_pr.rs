use std::path::Path;
use std::process::Command;

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};

use crate::git_util::{run_git_checked, run_git_trim};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreatePrRequest {
    pub worktree_path: String,
    pub target_branch: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub auto_commit_message: Option<String>,
    #[serde(default = "default_true")]
    pub draft: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CreatePrResult {
    pub url: String,
    pub branch: String,
    pub committed: bool,
    pub pushed: bool,
    pub already_existed: bool,
}

pub(crate) fn create_pull_request(req: &CreatePrRequest) -> Result<CreatePrResult> {
    let worktree = Path::new(&req.worktree_path);
    let branch = run_git_trim(worktree, &["rev-parse", "--abbrev-ref", "HEAD"])
        .ok_or_else(|| anyhow!("worktree has no branch checked out: {}", worktree.display()))?;
    if branch == "HEAD" {
        return Err(anyhow!(
            "worktree HEAD is detached; cannot open a PR from a detached HEAD"
        ));
    }

    let porcelain = run_git_checked(worktree, &["status", "--porcelain"])?;
    let has_dirty = !porcelain.lines().all(|l| l.trim().is_empty());
    let committed = has_dirty;
    if has_dirty {
        let msg = req
            .auto_commit_message
            .clone()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .ok_or_else(|| {
                anyhow!("worktree has uncommitted changes; provide a commit message to open a PR")
            })?;
        run_git_checked(worktree, &["add", "-A"])?;
        run_git_checked(worktree, &["commit", "-m", &msg])?;
    }

    // Require at least one commit beyond the base branch; otherwise `gh pr
    // create` would push an empty branch and produce a zero-change PR.
    let base = req.target_branch.trim();
    if !base.is_empty() {
        if let Some(count_text) =
            run_git_trim(worktree, &["rev-list", "--count", &format!("{base}..HEAD")])
        {
            if count_text.parse::<u32>().unwrap_or(0) == 0 {
                return Err(anyhow!(
                    "no commits on {branch} beyond {base}; nothing to open a PR for"
                ));
            }
        }
    }

    run_git_checked(worktree, &["push", "--set-upstream", "origin", &branch])
        .with_context(|| format!("failed to push branch {branch} to origin"))?;

    let title = req
        .title
        .clone()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| branch.clone());
    let body = req.body.clone().unwrap_or_default();

    let mut gh_args: Vec<&str> = vec![
        "pr",
        "create",
        "--base",
        &req.target_branch,
        "--head",
        &branch,
        "--title",
        &title,
        "--body",
        &body,
    ];
    if req.draft {
        gh_args.push("--draft");
    }
    let gh_output = Command::new("gh")
        .current_dir(worktree)
        .args(&gh_args)
        .output()
        .with_context(|| "failed to invoke gh; is the GitHub CLI installed?")?;

    if gh_output.status.success() {
        let url = extract_url(&String::from_utf8_lossy(&gh_output.stdout))
            .ok_or_else(|| anyhow!("gh pr create succeeded but printed no URL"))?;
        return Ok(CreatePrResult {
            url,
            branch,
            committed,
            pushed: true,
            already_existed: false,
        });
    }

    let stderr = String::from_utf8_lossy(&gh_output.stderr).to_string();
    if looks_like_already_exists(&stderr) {
        if let Some(url) = gh_existing_pr_url(worktree, &branch) {
            return Ok(CreatePrResult {
                url,
                branch,
                committed,
                pushed: true,
                already_existed: true,
            });
        }
    }
    Err(anyhow!("gh pr create failed: {}", stderr.trim()))
}

fn looks_like_already_exists(stderr: &str) -> bool {
    let lowered = stderr.to_lowercase();
    lowered.contains("already exists") || lowered.contains("a pull request for branch")
}

fn gh_existing_pr_url(cwd: &Path, branch: &str) -> Option<String> {
    let output = Command::new("gh")
        .current_dir(cwd)
        .args(["pr", "view", branch, "--json", "url", "-q", ".url"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8(output.stdout).ok()?.trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

fn extract_url(stdout: &str) -> Option<String> {
    stdout
        .lines()
        .map(str::trim)
        .find(|line| line.starts_with("https://"))
        .map(str::to_string)
}

pub(crate) fn remove_worktree(path: &Path, repo_root: &Path) -> Result<()> {
    run_git_checked(
        repo_root,
        &["worktree", "remove", path.to_string_lossy().as_ref()],
    )
    .map(|_| ())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RenameWorktreeResult {
    pub new_path: String,
    pub new_branch: String,
}

fn sanitize_branch_name(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    let sanitized: String = trimmed
        .chars()
        .map(|ch| match ch {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '-' | '_' | '/' => ch,
            _ => '-',
        })
        .collect::<String>()
        .trim_matches('-')
        .to_string();
    if sanitized.is_empty() {
        None
    } else {
        Some(sanitized)
    }
}

/// Rename a worktree's directory and branch.
///
/// PTYs cwd'd into the old path keep that path in the kernel; callers should
/// refuse the rename when live sessions are attached.
pub(crate) fn rename_worktree(
    old_path: &Path,
    new_branch: &str,
    repo_root: &Path,
) -> Result<RenameWorktreeResult> {
    let sanitized = sanitize_branch_name(new_branch)
        .ok_or_else(|| anyhow!("new branch name is empty or invalid: {new_branch:?}"))?;
    if sanitized.contains('/') {
        return Err(anyhow!("branch name cannot contain '/': {sanitized}"));
    }

    let old_branch = run_git_trim(old_path, &["rev-parse", "--abbrev-ref", "HEAD"])
        .ok_or_else(|| anyhow!("worktree has no branch checked out: {}", old_path.display()))?;
    if old_branch == "HEAD" {
        return Err(anyhow!(
            "worktree HEAD is detached; cannot rename a detached worktree"
        ));
    }
    if old_branch == sanitized {
        return Err(anyhow!(
            "new branch name is identical to current: {sanitized}"
        ));
    }

    let parent = old_path
        .parent()
        .ok_or_else(|| anyhow!("worktree path has no parent: {}", old_path.display()))?;
    let new_path = parent.join(&sanitized);
    if new_path.exists() {
        return Err(anyhow!(
            "target path already exists: {}",
            new_path.display()
        ));
    }

    run_git_checked(
        repo_root,
        &[
            "worktree",
            "move",
            old_path.to_string_lossy().as_ref(),
            new_path.to_string_lossy().as_ref(),
        ],
    )?;
    run_git_checked(&new_path, &["branch", "-m", &old_branch, &sanitized])
        .context("git branch -m failed after worktree move")?;

    Ok(RenameWorktreeResult {
        new_path: new_path.to_string_lossy().to_string(),
        new_branch: sanitized,
    })
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AbandonResult {
    /// Whether the GitHub PR (if any) was closed.
    pub pr_closed: bool,
    /// Whether the remote branch was deleted.
    pub remote_branch_deleted: bool,
    /// Whether the local worktree directory was removed.
    pub worktree_removed: bool,
    /// Whether the local branch was deleted.
    pub local_branch_deleted: bool,
    /// The branch name the worktree was on, when known.
    pub branch: Option<String>,
    /// URL of the closed PR, if one existed.
    pub pr_url: Option<String>,
    /// Human-readable notes for steps that were skipped or non-fatal failures.
    pub notes: Vec<String>,
}

/// Close the PR (if any), delete the remote + local branch, and remove the
/// worktree. Keeps going on non-fatal errors so a partially-orphaned worktree
/// still gets cleaned up instead of leaving the caller in a worse state.
pub(crate) fn abandon_worktree(worktree_path: &Path, repo_root: &Path) -> Result<AbandonResult> {
    let mut out = AbandonResult::default();

    let branch = run_git_trim(worktree_path, &["rev-parse", "--abbrev-ref", "HEAD"]);
    out.branch = branch.clone();

    if let Some(branch) = branch.as_deref() {
        if branch != "HEAD" {
            if let Some(url) = gh_existing_pr_url(worktree_path, branch) {
                out.pr_url = Some(url);
                match Command::new("gh")
                    .current_dir(worktree_path)
                    .args(["pr", "close", branch, "--delete-branch"])
                    .output()
                {
                    Ok(output) if output.status.success() => {
                        out.pr_closed = true;
                        out.remote_branch_deleted = true;
                    }
                    Ok(output) => {
                        out.notes.push(format!(
                            "gh pr close failed: {}",
                            String::from_utf8_lossy(&output.stderr).trim(),
                        ));
                    }
                    Err(error) => {
                        out.notes.push(format!("failed to invoke gh: {error}"));
                    }
                }
            }

            if !out.remote_branch_deleted {
                match run_git_checked(repo_root, &["push", "origin", "--delete", branch]) {
                    Ok(_) => out.remote_branch_deleted = true,
                    Err(error) => {
                        let msg = error.to_string();
                        if msg.contains("remote ref does not exist")
                            || msg.contains("does not exist")
                        {
                            out.notes
                                .push(format!("remote branch {branch} not present"));
                        } else {
                            out.notes
                                .push(format!("failed to delete remote branch: {msg}"));
                        }
                    }
                }
            }
        }
    }

    match run_git_checked(
        repo_root,
        &[
            "worktree",
            "remove",
            "--force",
            worktree_path.to_string_lossy().as_ref(),
        ],
    ) {
        Ok(_) => out.worktree_removed = true,
        Err(error) => {
            out.notes
                .push(format!("git worktree remove failed: {error}"));
        }
    }

    if let Some(branch) = out.branch.as_deref() {
        if branch != "HEAD" && out.worktree_removed {
            match run_git_checked(repo_root, &["branch", "-D", branch]) {
                Ok(_) => out.local_branch_deleted = true,
                Err(error) => {
                    out.notes
                        .push(format!("failed to delete local branch {branch}: {error}"));
                }
            }
        }
    }

    Ok(out)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrunableWorktree {
    pub path: String,
    pub branch: String,
    pub uncommitted_files: u32,
    pub unmerged_commits: u32,
    pub has_open_pr: bool,
    pub reason: String,
}

/// Local-only prune: remove the worktree and delete the local branch iff the
/// tree is fully clean (zero uncommitted files, zero commits ahead of
/// `base_branch`). Deliberately does **no** network operations — no `gh`,
/// no `git push`, no remote ref inspection — so we never trigger keychain
/// prompts on close. Callers that also want remote cleanup should use
/// `abandon_worktree` through the explicit "✕" button.
pub(crate) fn prune_local_if_clean(
    worktree_path: &Path,
    repo_root: &Path,
    base_branch: &str,
) -> Result<bool> {
    let status = match crate::git_worktrees::worktree_status(worktree_path, base_branch) {
        Ok(status) => status,
        Err(_) => return Ok(false),
    };
    if status.uncommitted_files > 0 || status.unmerged_commits > 0 {
        return Ok(false);
    }

    let branch = run_git_trim(worktree_path, &["rev-parse", "--abbrev-ref", "HEAD"]);

    if run_git_checked(
        repo_root,
        &[
            "worktree",
            "remove",
            worktree_path.to_string_lossy().as_ref(),
        ],
    )
    .is_err()
    {
        return Ok(false);
    }

    if let Some(branch) = branch.as_deref() {
        if branch != "HEAD" {
            let _ = run_git_checked(repo_root, &["branch", "-D", branch]);
        }
    }

    Ok(true)
}

/// Enumerate worktrees that look abandoned: zero unmerged commits, no
/// uncommitted files, and (when GitHub is reachable) no open PR. Skips the
/// main checkout and any non-lastty worktree the user created manually.
pub(crate) fn list_prunable_worktrees(
    repo_root: &Path,
    base_branch: &str,
) -> Result<Vec<PrunableWorktree>> {
    let worktrees = crate::git_worktrees::list_worktrees(repo_root)?;
    let mut out = Vec::new();

    for wt in worktrees {
        if wt.is_main || !wt.is_lastty || wt.detached {
            continue;
        }
        let path = Path::new(&wt.path);
        let status = match crate::git_worktrees::worktree_status(path, base_branch) {
            Ok(status) => status,
            Err(_) => continue,
        };
        if status.uncommitted_files > 0 || status.unmerged_commits > 0 {
            continue;
        }

        let has_open_pr = gh_existing_pr_url(path, &wt.branch).is_some();
        if has_open_pr {
            continue;
        }

        out.push(PrunableWorktree {
            path: wt.path,
            branch: wt.branch,
            uncommitted_files: status.uncommitted_files,
            unmerged_commits: status.unmerged_commits,
            has_open_pr,
            reason: "no commits ahead of base and no open PR".to_string(),
        });
    }

    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_url_finds_pr_link() {
        let stdout = "Creating pull request for lastty-claude-abc into main in owner/repo\n\nhttps://github.com/owner/repo/pull/42\n";
        assert_eq!(
            extract_url(stdout).as_deref(),
            Some("https://github.com/owner/repo/pull/42"),
        );
    }

    #[test]
    fn already_exists_detection() {
        assert!(looks_like_already_exists(
            "a pull request for branch \"foo\" into branch \"main\" already exists"
        ));
        assert!(!looks_like_already_exists("unrelated failure"));
    }

    #[test]
    fn sanitize_branch_name_rejects_empty_and_symbols_only() {
        assert!(sanitize_branch_name("").is_none());
        assert!(sanitize_branch_name("   ").is_none());
        assert!(sanitize_branch_name("!!@@").is_none());
    }

    #[test]
    fn sanitize_branch_name_replaces_and_trims() {
        assert_eq!(
            sanitize_branch_name("  feat bell attention!! ").as_deref(),
            Some("feat-bell-attention"),
        );
    }

    #[test]
    fn rename_worktree_moves_and_renames() -> Result<()> {
        let tmp = std::env::temp_dir().join(format!(
            "lastty-rename-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&tmp).unwrap();
        let repo = tmp.join("repo");
        std::fs::create_dir_all(&repo).unwrap();

        run_git_checked(&repo, &["init", "-q", "-b", "main"])?;
        run_git_checked(&repo, &["config", "user.email", "t@t.t"])?;
        run_git_checked(&repo, &["config", "user.name", "t"])?;
        run_git_checked(&repo, &["commit", "--allow-empty", "-m", "init"])?;

        let wt_root = repo.join(".lastty-worktrees");
        std::fs::create_dir_all(&wt_root).unwrap();
        let old_path = wt_root.join("lastty-claude-abc123");
        run_git_checked(
            &repo,
            &[
                "worktree",
                "add",
                "-b",
                "lastty-claude-abc123",
                old_path.to_string_lossy().as_ref(),
            ],
        )?;

        let result = rename_worktree(&old_path, "feat-rename", &repo)?;
        assert_eq!(result.new_branch, "feat-rename");
        assert!(std::path::Path::new(&result.new_path).exists());
        assert!(!old_path.exists());

        let branch = run_git_trim(
            std::path::Path::new(&result.new_path),
            &["rev-parse", "--abbrev-ref", "HEAD"],
        )
        .unwrap();
        assert_eq!(branch, "feat-rename");

        std::fs::remove_dir_all(&tmp).ok();
        Ok(())
    }

    #[test]
    fn rename_worktree_rejects_same_name() {
        let repo = std::env::temp_dir().join("x-should-not-exist-yyy");
        let result = rename_worktree(&repo.join(".lastty-worktrees").join("keep"), "keep", &repo);
        assert!(result.is_err());
    }
}
