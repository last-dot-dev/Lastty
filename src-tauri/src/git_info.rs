use std::path::Path;
use std::process::Command;

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GitInfo {
    pub repo: String,
    pub branch: String,
}

pub(crate) fn detect(cwd: &Path) -> Option<GitInfo> {
    let branch = run_git(cwd, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    let branch = if branch == "HEAD" {
        run_git(cwd, &["rev-parse", "--short", "HEAD"])?
    } else {
        branch
    };
    let remote = run_git(cwd, &["remote", "get-url", "origin"])?;
    let repo = parse_owner_repo(&remote)?;
    Some(GitInfo { repo, branch })
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

fn parse_owner_repo(url: &str) -> Option<String> {
    let trimmed = url.trim().trim_end_matches(".git");
    let after_scheme = trimmed
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(trimmed);
    let after_host = after_scheme
        .split_once(':')
        .map(|(_, rest)| rest)
        .or_else(|| after_scheme.split_once('/').map(|(_, rest)| rest))?;
    let mut parts: Vec<&str> = after_host.split('/').filter(|s| !s.is_empty()).collect();
    let repo = parts.pop()?;
    let owner = parts.pop()?;
    if owner.is_empty() || repo.is_empty() {
        return None;
    }
    Some(format!("{owner}/{repo}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_https_url() {
        assert_eq!(
            parse_owner_repo("https://github.com/owner/repo"),
            Some("owner/repo".to_string()),
        );
    }

    #[test]
    fn parses_https_url_with_dot_git() {
        assert_eq!(
            parse_owner_repo("https://github.com/owner/repo.git"),
            Some("owner/repo".to_string()),
        );
    }

    #[test]
    fn parses_scp_style_url() {
        assert_eq!(
            parse_owner_repo("git@github.com:owner/repo.git"),
            Some("owner/repo".to_string()),
        );
    }

    #[test]
    fn parses_ssh_url() {
        assert_eq!(
            parse_owner_repo("ssh://git@github.com/owner/repo.git"),
            Some("owner/repo".to_string()),
        );
    }

    #[test]
    fn parses_gitlab_subgroup_taking_last_two_segments() {
        assert_eq!(
            parse_owner_repo("https://gitlab.com/group/subgroup/repo.git"),
            Some("subgroup/repo".to_string()),
        );
    }

    #[test]
    fn rejects_garbage() {
        assert_eq!(parse_owner_repo("not-a-url"), None);
        assert_eq!(parse_owner_repo(""), None);
    }
}
