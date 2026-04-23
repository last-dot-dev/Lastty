use std::path::Path;
use std::process::Command;

use anyhow::{anyhow, Context, Result};
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GitBranch {
    pub name: String,
    pub is_current: bool,
    pub worktree_path: Option<String>,
}

pub(crate) fn list_branches(cwd: &Path) -> Result<Vec<GitBranch>> {
    if !crate::git_util::is_git_repo(cwd) {
        return Ok(Vec::new());
    }
    let format = "--format=%(refname:short)%00%(HEAD)%00%(worktreepath)";
    let output = Command::new("git")
        .current_dir(cwd)
        .args(["branch", "--list", format])
        .output()
        .with_context(|| format!("failed to invoke git branch in {}", cwd.display()))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(anyhow!("git branch failed: {stderr}"));
    }
    let stdout =
        String::from_utf8(output.stdout).with_context(|| "git branch produced non-utf8 output")?;
    stdout
        .lines()
        .filter(|line| !line.is_empty())
        .map(parse_branch_line)
        .collect()
}

pub(crate) fn checkout_branch(cwd: &Path, name: &str) -> Result<()> {
    let output = Command::new("git")
        .current_dir(cwd)
        .args(["checkout", name])
        .output()
        .with_context(|| format!("failed to invoke git checkout in {}", cwd.display()))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(anyhow!("git checkout {name} failed: {stderr}"));
    }
    Ok(())
}

fn parse_branch_line(line: &str) -> Result<GitBranch> {
    let mut parts = line.splitn(3, '\x00');
    let name = parts
        .next()
        .ok_or_else(|| anyhow!("missing name in branch line"))?
        .to_string();
    let head_marker = parts
        .next()
        .ok_or_else(|| anyhow!("missing HEAD marker in branch line"))?;
    let worktree_raw = parts.next().unwrap_or("");
    let is_current = head_marker == "*";
    let worktree_path = if worktree_raw.is_empty() {
        None
    } else {
        Some(worktree_raw.to_string())
    };
    Ok(GitBranch {
        name,
        is_current,
        worktree_path,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_current_branch_line() {
        let line = "main\x00*\x00/tmp/repo";
        let branch = parse_branch_line(line).unwrap();
        assert_eq!(
            branch,
            GitBranch {
                name: "main".into(),
                is_current: true,
                worktree_path: Some("/tmp/repo".into()),
            }
        );
    }

    #[test]
    fn parses_non_current_branch_without_worktree() {
        let line = "feature\x00\x00";
        let branch = parse_branch_line(line).unwrap();
        assert_eq!(
            branch,
            GitBranch {
                name: "feature".into(),
                is_current: false,
                worktree_path: None,
            }
        );
    }

    #[test]
    fn lists_and_checks_out_branches_in_real_repo() {
        let tmp = std::env::temp_dir().join(format!("lastty-branches-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).expect("create tmp dir");

        let run = |args: &[&str]| {
            let output = Command::new("git")
                .current_dir(&tmp)
                .args(args)
                .output()
                .expect("git ran");
            assert!(
                output.status.success(),
                "git {:?} failed: {}",
                args,
                String::from_utf8_lossy(&output.stderr)
            );
        };

        run(&["init", "--initial-branch=main"]);
        run(&["config", "user.email", "test@example.com"]);
        run(&["config", "user.name", "Test"]);
        run(&["config", "commit.gpgsign", "false"]);

        std::fs::write(tmp.join("a.txt"), "hello").expect("write a.txt");
        run(&["add", "a.txt"]);
        run(&["commit", "-m", "initial"]);
        run(&["branch", "feature"]);

        let branches = list_branches(&tmp).expect("list branches");
        let by_name: std::collections::HashMap<_, _> =
            branches.iter().map(|b| (b.name.as_str(), b)).collect();
        assert_eq!(by_name.len(), 2, "expected main + feature");
        assert!(by_name["main"].is_current);
        assert!(!by_name["feature"].is_current);

        checkout_branch(&tmp, "feature").expect("checkout feature");
        let after = list_branches(&tmp).expect("list branches again");
        let current = after
            .iter()
            .find(|b| b.is_current)
            .expect("one current branch");
        assert_eq!(current.name, "feature");

        std::fs::remove_dir_all(&tmp).ok();
    }
}
