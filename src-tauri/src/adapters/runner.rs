//! Lifecycle glue for `AgentAdapter`: spawns the real CLI with piped stdio,
//! reads its stdout line by line, and writes adapter-synthesized bytes
//! (encoded OSC 7770 + terminal echo) into a provided writer.

use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};

use pane_protocol::encode;

use super::{AdapterYield, AgentAdapter};

/// Writer that receives adapter-synthesized bytes. In the session path this
/// is a clone of the PTY master write fd; in tests it's typically a
/// `Vec<u8>` wrapped in a `Mutex`.
pub(crate) trait AdapterSink: Send + 'static {
    fn write_all(&mut self, bytes: &[u8]) -> std::io::Result<()>;
}

impl AdapterSink for std::fs::File {
    fn write_all(&mut self, bytes: &[u8]) -> std::io::Result<()> {
        Write::write_all(self, bytes)?;
        self.flush()
    }
}

impl AdapterSink for Arc<Mutex<Vec<u8>>> {
    fn write_all(&mut self, bytes: &[u8]) -> std::io::Result<()> {
        let mut guard = self
            .lock()
            .map_err(|_| std::io::Error::other("mutex poisoned"))?;
        guard.extend_from_slice(bytes);
        Ok(())
    }
}

/// Drives a single adapter: spawns the child, reads stdout, writes the
/// translated bytes into `sink`, flushes final messages on exit.
///
/// Returns a join handle for the orchestrator thread. The caller can wait
/// on it to observe completion, or drop it to detach.
pub(crate) fn spawn_adapter<S: AdapterSink>(
    mut adapter: Box<dyn AgentAdapter>,
    mut sink: S,
) -> std::io::Result<JoinHandle<()>> {
    let spec = adapter.command();
    let mut child = Command::new(&spec.program)
        .args(&spec.args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| std::io::Error::other("child stdout not piped"))?;

    let handle = thread::spawn(move || {
        pump_stdout(&mut *adapter, stdout, &mut sink);
        let status = child.wait().ok();
        let messages = match status {
            Some(status) => adapter.on_exit(status),
            None => adapter.on_exit(fake_exit_status()),
        };
        let _ = flush_messages(&messages, &mut sink);
    });

    Ok(handle)
}

fn pump_stdout<S: AdapterSink>(
    adapter: &mut dyn AgentAdapter,
    stdout: std::process::ChildStdout,
    sink: &mut S,
) {
    let reader = BufReader::new(stdout);
    for line in reader.lines() {
        let Ok(line) = line else { break };
        let yielded = adapter.on_stdout_line(line.as_bytes());
        if write_yield(&yielded, sink).is_err() {
            break;
        }
    }
}

fn write_yield<S: AdapterSink>(yielded: &AdapterYield, sink: &mut S) -> std::io::Result<()> {
    if !yielded.terminal_echo.is_empty() {
        sink.write_all(&yielded.terminal_echo)?;
    }
    flush_messages(&yielded.messages, sink)
}

fn flush_messages<S: AdapterSink>(
    messages: &[pane_protocol::AgentUiMessage],
    sink: &mut S,
) -> std::io::Result<()> {
    for msg in messages {
        let encoded = encode(msg);
        sink.write_all(&encoded)?;
    }
    Ok(())
}

#[cfg(unix)]
fn fake_exit_status() -> std::process::ExitStatus {
    use std::os::unix::process::ExitStatusExt;
    std::process::ExitStatus::from_raw(0)
}

#[cfg(not(unix))]
fn fake_exit_status() -> std::process::ExitStatus {
    use std::os::windows::process::ExitStatusExt;
    std::process::ExitStatus::from_raw(0)
}
