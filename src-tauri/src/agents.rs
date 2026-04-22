use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};
use tauri::Runtime;

use crate::adapters::adapter_for;
use crate::terminal::manager::TerminalManager;
use crate::terminal::session::{CommandSpec, SessionConfig};
use crate::worktree_prep::{self, PreparedWorktree};

const AGENTS_CONFIG_PATH: &str = "agents.toml";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentDefinition {
    pub id: String,
    pub name: String,
    pub command: String,
    #[serde(default)]
    pub default_args: Vec<String>,
    #[serde(default)]
    pub prompt_transport: PromptTransport,
    #[serde(default)]
    pub shell: bool,
    #[serde(default)]
    pub env: HashMap<String, String>,
    pub icon: Option<String>,
    #[serde(default)]
    pub resume_command: Option<String>,
    #[serde(default)]
    pub resume_args: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum PromptTransport {
    Simple(String),
    Detailed(PromptTransportDetail),
}

impl Default for PromptTransport {
    fn default() -> Self {
        Self::Simple("argv".to_string())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PromptTransportDetail {
    pub kind: String,
    pub flag: Option<String>,
    pub eof_marker: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum SyncPolicy {
    #[default]
    Shared,
    Clean,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WorktreeStrategy {
    #[default]
    InPlace,
    Attach {
        path: String,
    },
    New {
        #[serde(default)]
        sync: SyncPolicy,
        #[serde(default)]
        branch: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LaunchAgentRequest {
    pub agent_id: String,
    pub prompt: Option<String>,
    pub cwd: Option<String>,
    #[serde(default)]
    pub worktree: WorktreeStrategy,
}

#[derive(Debug, Clone, Serialize)]
pub struct LaunchAgentResult {
    pub session_id: String,
    pub pane_title: String,
    pub cwd: String,
    pub worktree_path: Option<String>,
    pub auto_promoted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RuleDefinition {
    pub name: String,
    pub trigger: RuleTrigger,
    pub action: RuleAction,
    #[serde(default)]
    pub debounce_ms: Option<u64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct RuleTrigger {
    pub event: String,
    #[serde(default)]
    pub filter: RuleFilter,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct RuleFilter {
    pub agent_id: Option<String>,
    pub session_id: Option<String>,
    pub phase: Option<String>,
    pub tool: Option<String>,
    pub path: Option<String>,
    pub choice: Option<String>,
    pub channel: Option<String>,
    pub from_agent: Option<String>,
    pub to_agent: Option<String>,
    pub presence: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RuleAction {
    pub launch_agent: String,
    pub prompt: Option<String>,
    pub cwd: Option<String>,
    #[serde(default)]
    pub isolate_in_worktree: bool,
    pub branch_name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct AgentConfigFile {
    #[serde(default)]
    agent: Vec<AgentDefinition>,
    #[serde(default)]
    rule: Vec<RuleDefinition>,
}

impl PromptTransport {
    fn kind(&self) -> &str {
        match self {
            PromptTransport::Simple(kind) => kind.as_str(),
            PromptTransport::Detailed(detail) => detail.kind.as_str(),
        }
    }

    fn flag(&self) -> Option<&str> {
        match self {
            PromptTransport::Detailed(detail) => detail.flag.as_deref(),
            PromptTransport::Simple(_) => None,
        }
    }

    fn eof_marker(&self) -> Option<&str> {
        match self {
            PromptTransport::Detailed(detail) => detail.eof_marker.as_deref(),
            PromptTransport::Simple(_) => None,
        }
    }
}

pub fn load_agent_registry(workspace_root: &Path) -> anyhow::Result<Vec<AgentDefinition>> {
    Ok(load_agent_config(workspace_root)?.agent)
}

pub fn load_rules(workspace_root: &Path) -> anyhow::Result<Vec<RuleDefinition>> {
    Ok(load_agent_config(workspace_root)?.rule)
}

fn load_agent_config(workspace_root: &Path) -> anyhow::Result<AgentConfigFile> {
    let path = workspace_root.join(AGENTS_CONFIG_PATH);
    if !path.exists() {
        return Ok(AgentConfigFile {
            agent: default_agents(),
            rule: Vec::new(),
        });
    }

    let contents = std::fs::read_to_string(path)?;
    let mut parsed: AgentConfigFile = toml::from_str(&contents)?;
    if parsed.agent.is_empty() {
        parsed.agent = default_agents();
    }
    Ok(parsed)
}

pub fn launch_agent<R: Runtime>(
    manager: &TerminalManager<R>,
    workspace_root: &Path,
    request: LaunchAgentRequest,
) -> anyhow::Result<LaunchAgentResult> {
    let agents = load_agent_registry(workspace_root)?;
    let agent = agents
        .into_iter()
        .find(|candidate| candidate.id == request.agent_id)
        .ok_or_else(|| anyhow::anyhow!("agent not found: {}", request.agent_id))?;

    let base_cwd = request
        .cwd
        .clone()
        .map(PathBuf::from)
        .unwrap_or_else(|| workspace_root.to_path_buf());

    let (strategy, auto_promoted) = auto_promote_if_busy(manager, &base_cwd, request.worktree);

    let resolved = resolve_strategy(&base_cwd, &agent.id, strategy)?;
    let ResolvedStrategy {
        cwd,
        worktree_path,
        prepared,
    } = resolved;

    let adapter = adapter_for(&agent.id, request.prompt.as_deref());
    let mut env = build_agent_env(&base_cwd);
    if let Some(prepared) = prepared.as_ref() {
        env.extend(prepared.env.clone());
    }
    env.extend(agent.env.clone());

    let prompt_summary = request.prompt.as_deref().map(summarize_prompt);

    let session_id = if adapter.is_some() {
        manager.create_session_with_adapter(
            SessionConfig {
                cwd: cwd.clone(),
                env: env.clone(),
                cols: 80,
                rows: 24,
                agent_id: Some(agent.id.clone()),
                prompt_summary: prompt_summary.clone(),
                prompt: request.prompt.clone(),
                worktree_path: worktree_path.clone(),
                ..Default::default()
            },
            adapter,
        )?
    } else {
        let command_spec = build_command_spec(&agent, request.prompt.as_deref())?;
        let session_id = manager.create_session(SessionConfig {
            command: Some(command_spec.clone()),
            cwd: cwd.clone(),
            env: env.clone(),
            cols: 80,
            rows: 24,
            agent_id: Some(agent.id.clone()),
            prompt_summary: prompt_summary.clone(),
            prompt: request.prompt.clone(),
            worktree_path: worktree_path.clone(),
        })?;

        if matches!(agent.prompt_transport.kind(), "stdin") {
            if let Some(prompt) = request.prompt.as_ref() {
                if let Some(session) = manager.get(&session_id) {
                    let mut payload = prompt.clone();
                    payload.push('\n');
                    if let Some(marker) = agent.prompt_transport.eof_marker() {
                        payload.push_str(marker);
                        payload.push('\n');
                    }
                    session
                        .write(payload.as_bytes())
                        .map_err(anyhow::Error::msg)?;
                }
            }
        }
        session_id
    };

    if let Some(prepared) = prepared {
        prepared.spawn_post_create_hook();
    }

    Ok(LaunchAgentResult {
        session_id: session_id.to_string(),
        pane_title: agent.name,
        cwd: cwd.to_string_lossy().to_string(),
        worktree_path,
        auto_promoted,
    })
}

struct ResolvedStrategy {
    cwd: PathBuf,
    worktree_path: Option<String>,
    prepared: Option<PreparedWorktree>,
}

fn auto_promote_if_busy<R: Runtime>(
    manager: &TerminalManager<R>,
    target_cwd: &Path,
    strategy: WorktreeStrategy,
) -> (WorktreeStrategy, bool) {
    if !matches!(strategy, WorktreeStrategy::InPlace) {
        return (strategy, false);
    }
    if manager.live_sessions_on(target_cwd).is_empty() {
        return (strategy, false);
    }
    // Auto-promote only when the target is a git repo — otherwise there's no
    // way to create a worktree and the launch would fail. Rule-driven launches
    // into arbitrary cwds (e.g. scratch dirs) stay in-place.
    if !crate::git_util::is_git_repo(target_cwd) {
        return (strategy, false);
    }
    (
        WorktreeStrategy::New {
            sync: SyncPolicy::default(),
            branch: None,
        },
        true,
    )
}

fn resolve_strategy(
    base_cwd: &Path,
    agent_id: &str,
    strategy: WorktreeStrategy,
) -> anyhow::Result<ResolvedStrategy> {
    match strategy {
        WorktreeStrategy::InPlace => Ok(ResolvedStrategy {
            cwd: base_cwd.to_path_buf(),
            worktree_path: None,
            prepared: None,
        }),
        WorktreeStrategy::Attach { path } => {
            let trimmed = path.trim();
            if trimmed.is_empty() {
                return Err(anyhow::anyhow!("attach strategy requires a path"));
            }
            let path = PathBuf::from(trimmed);
            if !path.exists() {
                return Err(anyhow::anyhow!(
                    "attach path does not exist: {}",
                    path.display()
                ));
            }
            let display = path.to_string_lossy().to_string();
            Ok(ResolvedStrategy {
                cwd: path,
                worktree_path: Some(display),
                prepared: None,
            })
        }
        WorktreeStrategy::New { sync, branch } => {
            let branch_name = branch
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| {
                    let suffix = uuid::Uuid::new_v4().simple().to_string();
                    format!(
                        "lastty-{}-{}",
                        sanitize_branch_component(agent_id),
                        &suffix[..6]
                    )
                });
            let worktree_root = base_cwd.join(".lastty-worktrees");
            std::fs::create_dir_all(&worktree_root)?;
            let worktree_path = worktree_root.join(&branch_name);
            if worktree_path.exists() {
                return Err(anyhow::anyhow!(
                    "worktree already exists: {}",
                    worktree_path.display()
                ));
            }
            let status = Command::new("git")
                .args([
                    "worktree",
                    "add",
                    "-b",
                    &branch_name,
                    worktree_path.to_string_lossy().as_ref(),
                ])
                .current_dir(base_cwd)
                .status()?;
            if !status.success() {
                return Err(anyhow::anyhow!(
                    "git worktree add failed for branch {branch_name}"
                ));
            }
            let prepared = worktree_prep::prepare(base_cwd, &worktree_path, sync)?;
            let display = worktree_path.to_string_lossy().to_string();
            Ok(ResolvedStrategy {
                cwd: worktree_path,
                worktree_path: Some(display),
                prepared: Some(prepared),
            })
        }
    }
}

pub fn resume_command_spec(agent: &AgentDefinition, agent_session_id: &str) -> Option<CommandSpec> {
    let program = agent.resume_command.clone()?;
    let args = agent
        .resume_args
        .iter()
        .map(|arg| arg.replace("{{agent_session_id}}", agent_session_id))
        .collect();
    Some(CommandSpec { program, args })
}

fn build_command_spec(
    agent: &AgentDefinition,
    prompt: Option<&str>,
) -> anyhow::Result<CommandSpec> {
    let mut args = agent.default_args.clone();
    match agent.prompt_transport.kind() {
        "argv" => {
            if let Some(prompt) = prompt {
                args.push(prompt.to_string());
            }
        }
        "flag" => {
            if let Some(prompt) = prompt {
                let flag = agent
                    .prompt_transport
                    .flag()
                    .ok_or_else(|| anyhow::anyhow!("flag prompt transport missing `flag`"))?;
                args.push(flag.to_string());
                args.push(prompt.to_string());
            }
        }
        "stdin" | "none" => {}
        other => return Err(anyhow::anyhow!("unsupported prompt transport: {other}")),
    }

    if agent.shell {
        let mut commandline = shell_quote(&agent.command);
        for arg in &args {
            commandline.push(' ');
            commandline.push_str(&shell_quote(arg));
        }
        return Ok(CommandSpec {
            program: std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string()),
            args: vec!["-lc".to_string(), commandline],
        });
    }

    let program = resolve_in_path(&agent.command)
        .map(|p| p.to_string_lossy().into_owned())
        .ok_or_else(|| command_not_found_error(agent))?;

    Ok(CommandSpec { program, args })
}

/// Resolves a bare program name against the current process's `PATH`. Returns
/// the input unchanged if it already contains a path separator (absolute or
/// explicitly relative). Returns `None` if the binary is not found or isn't
/// executable.
pub(crate) fn resolve_in_path(program: &str) -> Option<PathBuf> {
    if program.is_empty() {
        return None;
    }
    if program.contains('/') {
        let path = Path::new(program);
        return is_executable(path).then(|| path.to_path_buf());
    }
    let path_env = std::env::var_os("PATH")?;
    std::env::split_paths(&path_env)
        .map(|dir| dir.join(program))
        .find(|candidate| is_executable(candidate))
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool {
    path.is_file()
}

fn command_not_found_error(agent: &AgentDefinition) -> anyhow::Error {
    let path_env = std::env::var("PATH").unwrap_or_default();
    anyhow::anyhow!(
        "Can't find `{command}` on your PATH.\n\n\
         Install {name}, or if it's already installed, add its directory to your \
         shell startup file (on macOS: `~/.zprofile` or `~/.zshrc`) and restart Lastty.\n\n\
         PATH searched:\n{path}",
        command = agent.command,
        name = agent.name,
        path = path_env
    )
}

fn build_agent_env(_base_cwd: &Path) -> HashMap<String, String> {
    let mut env = HashMap::new();
    env.insert("TERM".to_string(), "xterm-256color".to_string());
    env.insert("COLORTERM".to_string(), "truecolor".to_string());
    env.insert("LASTTY".to_string(), "1".to_string());
    env
}

fn summarize_prompt(prompt: &str) -> String {
    const LIMIT: usize = 72;
    let single_line = prompt.replace('\n', " ");
    if single_line.len() <= LIMIT {
        single_line
    } else {
        format!("{}…", &single_line[..LIMIT])
    }
}

fn shell_quote(value: &str) -> String {
    if value.is_empty() {
        return "''".to_string();
    }
    format!("'{}'", value.replace('\'', r"'\''"))
}

fn sanitize_branch_component(value: &str) -> String {
    value
        .chars()
        .map(|ch| match ch {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '-' | '_' | '/' => ch,
            _ => '-',
        })
        .collect()
}

fn default_agents() -> Vec<AgentDefinition> {
    vec![
        AgentDefinition {
            id: "codex".to_string(),
            name: "Codex CLI".to_string(),
            command: "codex".to_string(),
            default_args: Vec::new(),
            prompt_transport: PromptTransport::Simple("argv".to_string()),
            shell: false,
            env: HashMap::new(),
            icon: Some("◎".to_string()),
            resume_command: Some("codex".to_string()),
            resume_args: vec!["resume".to_string(), "{{agent_session_id}}".to_string()],
        },
        AgentDefinition {
            id: "claude".to_string(),
            name: "Claude Code".to_string(),
            command: "claude".to_string(),
            default_args: Vec::new(),
            prompt_transport: PromptTransport::Simple("argv".to_string()),
            shell: false,
            env: HashMap::new(),
            icon: Some("◌".to_string()),
            resume_command: Some("claude".to_string()),
            resume_args: vec!["--resume".to_string(), "{{agent_session_id}}".to_string()],
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::{
        build_command_spec, load_rules, resolve_in_path, AgentDefinition, PromptTransport,
        RuleAction, RuleDefinition, RuleFilter, RuleTrigger,
    };
    use std::collections::HashMap;
    use std::fs;
    use std::path::PathBuf;

    #[test]
    fn argv_transport_appends_prompt() {
        let agent = AgentDefinition {
            id: "sh".to_string(),
            name: "sh".to_string(),
            // Absolute path bypasses PATH resolution; keeps the assertion stable
            // regardless of the test machine's PATH.
            command: "/bin/sh".to_string(),
            default_args: vec!["-c".to_string()],
            prompt_transport: PromptTransport::Simple("argv".to_string()),
            shell: false,
            env: HashMap::new(),
            icon: None,
            resume_command: None,
            resume_args: Vec::new(),
        };

        let spec = build_command_spec(&agent, Some("fix it")).unwrap();
        assert_eq!(spec.program, "/bin/sh");
        assert_eq!(spec.args, vec!["-c".to_string(), "fix it".to_string()]);
    }

    #[test]
    fn build_command_spec_errors_when_binary_missing() {
        let agent = AgentDefinition {
            id: "ghost".to_string(),
            name: "Ghost CLI".to_string(),
            command: "this-binary-definitely-does-not-exist-on-path-xyz".to_string(),
            default_args: Vec::new(),
            prompt_transport: PromptTransport::Simple("none".to_string()),
            shell: false,
            env: HashMap::new(),
            icon: None,
            resume_command: None,
            resume_args: Vec::new(),
        };

        let err = build_command_spec(&agent, None).unwrap_err().to_string();
        assert!(err.contains("Can't find"), "unexpected error: {err}");
        assert!(err.contains("Ghost CLI"), "unexpected error: {err}");
    }

    #[test]
    fn resolve_in_path_finds_standard_binaries() {
        let resolved = resolve_in_path("sh").expect("sh must be on PATH");
        assert!(resolved.is_absolute());
        assert!(resolved.ends_with("sh"));
    }

    #[test]
    fn resolve_in_path_passes_through_absolute_paths() {
        let resolved = resolve_in_path("/bin/sh").expect("/bin/sh must exist");
        assert_eq!(resolved, PathBuf::from("/bin/sh"));
    }

    #[test]
    fn resolve_in_path_returns_none_for_missing() {
        assert!(resolve_in_path("this-binary-does-not-exist-anywhere-zzz").is_none());
    }

    #[test]
    fn resolve_in_path_rejects_non_executable() {
        // A directory is not an executable file.
        assert!(resolve_in_path("/tmp").is_none());
    }

    #[test]
    fn loads_rules_from_agents_toml() {
        let temp_root = temp_dir("lastty-rules");
        fs::write(
            temp_root.join("agents.toml"),
            r#"
            [[agent]]
            id = "codex"
            name = "Codex"
            command = "codex"
            prompt_transport = "argv"

            [[rule]]
            name = "auto-test"
            debounce_ms = 2000

            [rule.trigger]
            event = "agent_finished"

            [rule.trigger.filter]
            agent_id = "codex"

            [rule.action]
            launch_agent = "claude"
            prompt = "Review {{summary}}"
            isolate_in_worktree = false
            "#,
        )
        .unwrap();

        let rules = load_rules(&temp_root).unwrap();

        assert_eq!(
            rules,
            vec![RuleDefinition {
                name: "auto-test".to_string(),
                trigger: RuleTrigger {
                    event: "agent_finished".to_string(),
                    filter: RuleFilter {
                        agent_id: Some("codex".to_string()),
                        ..RuleFilter::default()
                    },
                },
                action: RuleAction {
                    launch_agent: "claude".to_string(),
                    prompt: Some("Review {{summary}}".to_string()),
                    cwd: None,
                    isolate_in_worktree: false,
                    branch_name: None,
                },
                debounce_ms: Some(2_000),
            }]
        );
    }

    fn temp_dir(prefix: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "{prefix}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }
}
