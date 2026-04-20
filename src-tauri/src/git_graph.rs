use std::path::Path;
use std::process::Command;

use anyhow::{anyhow, Context, Result};
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GitCommit {
    pub sha: String,
    pub parents: Vec<String>,
    pub subject: String,
    pub author: String,
    pub committed_at: i64,
    pub refs: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GitGraph {
    pub commits: Vec<GitCommit>,
    pub head: Option<String>,
    pub head_ref: Option<String>,
}

pub fn load(cwd: &Path, limit: u32) -> Result<GitGraph> {
    let format = "%H%x01%P%x01%s%x01%an%x01%ct%x01%D";
    let limit_arg = format!("-n{limit}");
    let format_arg = format!("--format={format}");
    let output = Command::new("git")
        .current_dir(cwd)
        .args([
            "log",
            "--all",
            "--date-order",
            &format_arg,
            &limit_arg,
        ])
        .output()
        .with_context(|| format!("failed to invoke git log in {}", cwd.display()))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(anyhow!("git log failed: {stderr}"));
    }
    let stdout = String::from_utf8(output.stdout)
        .with_context(|| "git log produced non-utf8 output")?;
    let commits = stdout
        .lines()
        .filter(|line| !line.is_empty())
        .map(parse_commit_line)
        .collect::<Result<Vec<_>>>()?;

    let head = run_git(cwd, &["rev-parse", "HEAD"]);
    let head_ref = run_git(cwd, &["rev-parse", "--abbrev-ref", "HEAD"]).and_then(|name| {
        if name == "HEAD" {
            None
        } else {
            Some(name)
        }
    });

    Ok(GitGraph {
        commits,
        head,
        head_ref,
    })
}

fn parse_commit_line(line: &str) -> Result<GitCommit> {
    let mut parts = line.splitn(6, '\x01');
    let sha = parts
        .next()
        .ok_or_else(|| anyhow!("missing sha in commit line"))?
        .to_string();
    let parents_raw = parts
        .next()
        .ok_or_else(|| anyhow!("missing parents in commit line"))?;
    let subject = parts
        .next()
        .ok_or_else(|| anyhow!("missing subject in commit line"))?
        .to_string();
    let author = parts
        .next()
        .ok_or_else(|| anyhow!("missing author in commit line"))?
        .to_string();
    let committed_at = parts
        .next()
        .ok_or_else(|| anyhow!("missing timestamp in commit line"))?
        .parse::<i64>()
        .with_context(|| "failed to parse commit timestamp")?;
    let refs_raw = parts.next().unwrap_or("");

    let parents = parents_raw
        .split_whitespace()
        .map(str::to_string)
        .collect();
    let refs = if refs_raw.is_empty() {
        Vec::new()
    } else {
        refs_raw
            .split(", ")
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect()
    };

    Ok(GitCommit {
        sha,
        parents,
        subject,
        author,
        committed_at,
        refs,
    })
}

fn run_git(cwd: &Path, args: &[&str]) -> Option<String> {
    let output = Command::new("git")
        .current_dir(cwd)
        .args(args)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let s = String::from_utf8(output.stdout).ok()?.trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_linear_commit() {
        let line = "abc123\x01def456\x01feat: thing\x01Alice\x011710000000\x01HEAD -> main, origin/main";
        let commit = parse_commit_line(line).unwrap();
        assert_eq!(
            commit,
            GitCommit {
                sha: "abc123".into(),
                parents: vec!["def456".into()],
                subject: "feat: thing".into(),
                author: "Alice".into(),
                committed_at: 1_710_000_000,
                refs: vec!["HEAD -> main".into(), "origin/main".into()],
            }
        );
    }

    #[test]
    fn parses_root_commit_with_no_parents_and_no_refs() {
        let line = "root0\x01\x01initial commit\x01Bob\x011600000000\x01";
        let commit = parse_commit_line(line).unwrap();
        assert_eq!(commit.parents, Vec::<String>::new());
        assert_eq!(commit.refs, Vec::<String>::new());
        assert_eq!(commit.subject, "initial commit");
    }

    #[test]
    fn parses_merge_commit_with_two_parents() {
        let line = "merge1\x01p1 p2\x01merge: branches\x01Carol\x011700000000\x01";
        let commit = parse_commit_line(line).unwrap();
        assert_eq!(commit.parents, vec!["p1".to_string(), "p2".to_string()]);
    }

    #[test]
    fn parses_unicode_subject() {
        let line = "sha1\x01par1\x01feat: 日本語 ✓\x01Dana\x011234567890\x01";
        let commit = parse_commit_line(line).unwrap();
        assert_eq!(commit.subject, "feat: 日本語 ✓");
    }

    #[test]
    fn parses_tag_ref_with_prefix() {
        let line = "sha\x01par\x01bump\x01Eve\x011\x01HEAD -> main, tag: v1.2.0, origin/main";
        let commit = parse_commit_line(line).unwrap();
        assert_eq!(
            commit.refs,
            vec![
                "HEAD -> main".to_string(),
                "tag: v1.2.0".to_string(),
                "origin/main".to_string(),
            ]
        );
    }

    #[test]
    fn rejects_malformed_line() {
        assert!(parse_commit_line("only one field").is_err());
    }

    #[test]
    fn loads_graph_from_real_repo() {
        let tmp = std::env::temp_dir().join(format!(
            "lastty-graph-{}",
            uuid::Uuid::new_v4()
        ));
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

        std::fs::write(tmp.join("a.txt"), "hello world").expect("update a.txt");
        run(&["commit", "-am", "update"]);

        let graph = load(&tmp, 50).expect("graph loads");

        assert_eq!(graph.commits.len(), 2, "expected two commits");
        assert_eq!(graph.head_ref.as_deref(), Some("main"));
        assert!(graph.head.is_some(), "head sha present");
        assert_eq!(graph.commits[0].subject, "update");
        assert_eq!(graph.commits[1].subject, "initial");
        assert_eq!(graph.commits[0].parents.len(), 1);
        assert!(graph.commits[1].parents.is_empty());

        std::fs::remove_dir_all(&tmp).ok();
    }
}
