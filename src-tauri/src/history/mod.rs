pub mod claude;
pub mod codex;

use std::path::PathBuf;

use crate::bus::{HistoryEntry, HistorySource};

pub(crate) fn discover_all() -> Vec<HistoryEntry> {
    let mut entries = Vec::new();
    entries.extend(claude::discover_all());
    entries.extend(codex::discover_all());
    entries
}

pub(crate) fn read_transcript(source: HistorySource, session_id: &str) -> Result<String, String> {
    match source {
        HistorySource::Lastty => Err("lastty recordings are served by the event bus".to_string()),
        HistorySource::ClaudeDisk => claude::read_transcript(session_id),
        HistorySource::CodexDisk => codex::read_transcript(session_id),
    }
}

pub(crate) fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}
