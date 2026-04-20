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
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CreatePrResult {
    pub url: String,
    pub branch: String,
    pub committed: bool,
    pub pushed: bool,
    pub already_existed: bool,
}

pub fn create_pull_request(req: &CreatePrRequest) -> Result<CreatePrResult> {
    let worktree = Path::new(&req.worktree_path);
    let branch = run_git_trim(worktree, &["rev-parse", "--abbrev-ref", "HEAD"])
        .ok_or_else(|| anyhow!("worktree has no branch checked out: {}", worktree.display()))?;
    if branch == "HEAD" {
        return Err(anyhow!(
            "worktree HEAD is detached; cannot open a PR from a detached HEAD"
        ));
    }

    let porcelain = run_git_checked(worktree, &["status", "--porcelain"])?;
    let committed = !porcelain.lines().all(|l| l.trim().is_empty());
    if committed {
        let msg = req
            .auto_commit_message
            .clone()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| format!("agent work: {branch}"));
        run_git_checked(worktree, &["add", "-A"])?;
        run_git_checked(worktree, &["commit", "-m", &msg])?;
    }

    run_git_checked(worktree, &["push", "--set-upstream", "origin", &branch])
        .with_context(|| format!("failed to push branch {branch} to origin"))?;

    let title = req
        .title
        .clone()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| branch.clone());
    let body = req.body.clone().unwrap_or_default();

    let gh_output = Command::new("gh")
        .current_dir(worktree)
        .args([
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
        ])
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

pub fn remove_worktree(path: &Path, repo_root: &Path) -> Result<()> {
    run_git_checked(
        repo_root,
        &["worktree", "remove", path.to_string_lossy().as_ref()],
    )
    .map(|_| ())
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
}
