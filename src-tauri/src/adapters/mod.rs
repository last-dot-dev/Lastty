//! Provider-specific adapters that translate a CLI's structured output
//! into OSC 7770 `AgentUiMessage`s.
//!
//! Each adapter owns a real CLI process (spawned with piped stdio, **not**
//! under a PTY), parses its JSON-stream output line by line, and emits
//! `AgentUiMessage`s plus human-readable terminal echo bytes. The session
//! layer takes care of feeding those bytes through a keepalive child that
//! echoes to the PTY slave, so the existing `OscParser` ingests them
//! unchanged.

pub mod claude_code;
pub mod codex;
pub mod runner;

use pane_protocol::AgentUiMessage;

use crate::terminal::session::CommandSpec;

/// Bytes the adapter wants to surface to the user this tick.
#[derive(Debug, Default, Clone)]
pub struct AdapterYield {
    /// Structured messages to encode and forward to the UI.
    pub messages: Vec<AgentUiMessage>,
    /// Pretty-printed narration (raw bytes, may include ANSI) to display in
    /// the terminal grid.
    pub terminal_echo: Vec<u8>,
}

impl AdapterYield {
    pub fn empty() -> Self {
        Self::default()
    }

    pub fn message(msg: AgentUiMessage) -> Self {
        Self {
            messages: vec![msg],
            terminal_echo: Vec::new(),
        }
    }

    pub fn push_message(&mut self, msg: AgentUiMessage) {
        self.messages.push(msg);
    }

    pub fn push_echo(&mut self, bytes: impl AsRef<[u8]>) {
        self.terminal_echo.extend_from_slice(bytes.as_ref());
    }
}

/// A per-provider translator. Implementations receive raw bytes from a real
/// CLI's stdout, one line at a time, and return structured events.
pub trait AgentAdapter: Send + 'static {
    /// The CLI command + argv the runner should spawn with piped stdio.
    fn command(&self) -> CommandSpec;

    /// Translate one line of the CLI's stdout into events + terminal echo.
    fn on_stdout_line(&mut self, line: &[u8]) -> AdapterYield;

    /// Called once the child exits. Adapters typically emit a final
    /// `Finished` here if they did not already emit one from the stdout
    /// stream.
    fn on_exit(&mut self, status: std::process::ExitStatus) -> Vec<AgentUiMessage>;
}

/// Builds a fresh adapter for a given agent id from `agents.toml`. Returns
/// `None` if the id does not have a registered adapter — caller should fall
/// back to the raw-PTY launch path.
pub fn adapter_for(_agent_id: &str, _prompt: Option<&str>) -> Option<Box<dyn AgentAdapter>> {
    None
}
