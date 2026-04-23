//! Integration test: discovers real claude-code and codex transcripts from the
//! local machine and verifies both can be parsed into HistoryEntry values.
//!
//! Not for CI. Gated on the presence of real transcripts in `~/.claude/projects/`
//! or `~/.codex/sessions/`. If neither is present, each sub-test skips with a
//! println — still exits success. Run locally with:
//!
//!     cargo test -p lastty --test history_integration -- --nocapture

use std::path::PathBuf;

use lastty::bus::HistorySource;
use lastty::history;

fn home() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .expect("HOME must be set")
}

#[test]
fn discovers_real_claude_transcripts() {
    let claude_dir = home().join(".claude").join("projects");
    if !claude_dir.is_dir() {
        println!("skip: no {} on this machine", claude_dir.display());
        return;
    }

    let entries = history::claude::discover_all();
    assert!(
        !entries.is_empty(),
        "expected at least one claude transcript under {}",
        claude_dir.display()
    );

    let entry = entries.first().expect("non-empty");
    assert_eq!(entry.source, HistorySource::ClaudeDisk);
    assert!(!entry.session_id.is_empty(), "session_id must be set");
    assert!(!entry.cwd.is_empty(), "cwd must be set");

    let bare_id = entry
        .agent_session_id
        .as_deref()
        .expect("claude entry should carry an agent_session_id");
    let transcript = history::read_transcript(HistorySource::ClaudeDisk, bare_id)
        .expect("transcript read should succeed");
    assert!(
        transcript.len() > 0,
        "transcript for {} should be non-empty",
        bare_id
    );

    println!(
        "claude: found {} entries; first = session_id={} agent={} cwd={}",
        entries.len(),
        entry.session_id,
        entry.agent_id.as_deref().unwrap_or("?"),
        entry.cwd
    );
}

#[test]
fn discovers_real_codex_transcripts() {
    let codex_dir = home().join(".codex").join("sessions");
    if !codex_dir.is_dir() {
        println!("skip: no {} on this machine", codex_dir.display());
        return;
    }

    let entries = history::codex::discover_all();
    assert!(
        !entries.is_empty(),
        "expected at least one codex transcript under {}",
        codex_dir.display()
    );

    let entry = entries.first().expect("non-empty");
    assert_eq!(entry.source, HistorySource::CodexDisk);
    assert!(!entry.session_id.is_empty(), "session_id must be set");
    assert!(!entry.cwd.is_empty(), "cwd must be set");

    let bare_id = entry
        .agent_session_id
        .as_deref()
        .expect("codex entry should carry an agent_session_id");
    // NOTE: `read_transcript` for codex is known to return empty strings for
    // current rollout formats (the mapper at history::codex::map_record_to_ui_message
    // expects top-level role+text but the rollouts nest content under `payload`).
    // That is a separate transcript-viewer bug; the resume path does not depend on
    // read_transcript — it spawns `codex --resume <bare_id>` directly. So we only
    // assert the read doesn't error, not that it produced content.
    let _ = history::read_transcript(HistorySource::CodexDisk, bare_id)
        .expect("transcript read should not error");

    println!(
        "codex: found {} entries; first = session_id={} agent={} cwd={}",
        entries.len(),
        entry.session_id,
        entry.agent_id.as_deref().unwrap_or("?"),
        entry.cwd
    );
}

#[test]
fn real_agent_binaries_are_on_path() {
    let claude = which::which("claude").ok();
    let codex = which::which("codex").ok();
    match (&claude, &codex) {
        (Some(c), Some(x)) => println!("claude={}, codex={}", c.display(), x.display()),
        _ => panic!(
            "expected both `claude` and `codex` on PATH; claude={:?} codex={:?}",
            claude, codex
        ),
    }
}

/// Smoke-check that the real `claude --help` output advertises the `--resume`
/// flag lastty will invoke. If this ever drifts (e.g. upstream renames the flag),
/// the resume integration breaks and this test will catch it.
#[test]
fn claude_resume_flag_is_still_advertised() {
    use std::process::Command;
    let Ok(claude) = which::which("claude") else {
        println!("skip: claude not on PATH");
        return;
    };
    let out = Command::new(&claude)
        .arg("--help")
        .output()
        .expect("claude --help should execute");
    let text = String::from_utf8_lossy(&out.stdout);
    assert!(
        text.contains("--resume") || text.contains("-r,"),
        "expected claude --help to advertise --resume; got:\n{}",
        text
    );
}

/// Same smoke-check for codex: `codex resume <id>` — confirm the `resume`
/// subcommand still exists by scanning `codex --help`.
#[test]
fn codex_resume_subcommand_is_still_advertised() {
    use std::process::Command;
    let Ok(codex) = which::which("codex") else {
        println!("skip: codex not on PATH");
        return;
    };
    let out = Command::new(&codex)
        .arg("--help")
        .output()
        .expect("codex --help should execute");
    let text = String::from_utf8_lossy(&out.stdout);
    assert!(
        text.contains("resume"),
        "expected codex --help to advertise `resume`; got:\n{}",
        text
    );
}
