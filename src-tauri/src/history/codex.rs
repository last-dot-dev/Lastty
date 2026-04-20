use std::fs;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;

use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Value};

use crate::bus::{HistoryEntry, HistorySource};

pub fn discover_all() -> Vec<HistoryEntry> {
    let Some(conn) = open_state_db() else {
        return Vec::new();
    };

    let mut stmt = match conn.prepare(
        "SELECT id, title, first_user_message, created_at, updated_at, cwd
         FROM threads WHERE archived = 0",
    ) {
        Ok(stmt) => stmt,
        Err(err) => {
            tracing::debug!("codex threads query failed: {err}");
            return Vec::new();
        }
    };

    let mapped = stmt.query_map([], |row| {
        Ok((
            CodexThreadRow {
                id: row.get(0)?,
                title: row.get::<_, Option<String>>(1)?,
                first_user_message: row.get::<_, Option<String>>(2)?,
                created_at_ms: row.get::<_, i64>(3)? as u128,
                updated_at_ms: row.get::<_, i64>(4)? as u128,
            },
            row.get::<_, String>(5)?,
        ))
    });

    match mapped {
        Ok(iter) => iter
            .filter_map(Result::ok)
            .map(|(row, cwd)| row.into_history_entry(&cwd))
            .collect(),
        Err(err) => {
            tracing::debug!("codex threads iter failed: {err}");
            Vec::new()
        }
    }
}

pub fn read_transcript(session_id: &str) -> Result<String, String> {
    let Some(conn) = open_state_db() else {
        return Ok(String::new());
    };
    let rollout: Option<String> = conn
        .query_row(
            "SELECT rollout_path FROM threads WHERE id = ?1",
            [session_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    let Some(path) = rollout.filter(|p| !p.is_empty()) else {
        return Ok(String::new());
    };
    let path = PathBuf::from(path);
    if !path.is_file() {
        return Ok(String::new());
    }

    let file = fs::File::open(&path).map_err(|e| e.to_string())?;
    let reader = BufReader::new(file);
    let mut out = String::new();
    for line in reader.lines().flatten() {
        let Ok(record) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let Some(message) = map_record_to_ui_message(&record) else {
            continue;
        };
        let mut envelope = json!({ "agent_ui_message": message });
        if let (Some(obj), Some(ts)) = (envelope.as_object_mut(), record_timestamp_ms(&record)) {
            obj.insert("ts_ms".into(), json!(ts));
        }
        out.push_str(&envelope.to_string());
        out.push('\n');
    }
    Ok(out)
}

pub(crate) fn find_entry(session_id: &str) -> Option<HistoryEntry> {
    let conn = open_state_db()?;
    let (thread, cwd) = conn
        .query_row(
            "SELECT id, title, first_user_message, created_at, updated_at, cwd
             FROM threads WHERE id = ?1",
            [session_id],
            |row| {
                Ok((
                    CodexThreadRow {
                        id: row.get(0)?,
                        title: row.get::<_, Option<String>>(1)?,
                        first_user_message: row.get::<_, Option<String>>(2)?,
                        created_at_ms: row.get::<_, i64>(3)? as u128,
                        updated_at_ms: row.get::<_, i64>(4)? as u128,
                    },
                    row.get::<_, String>(5)?,
                ))
            },
        )
        .ok()?;
    Some(thread.into_history_entry(&cwd))
}

fn open_state_db() -> Option<Connection> {
    let path = super::home_dir()?.join(".codex/state_5.sqlite");
    if !path.exists() {
        return None;
    }
    match Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY) {
        Ok(conn) => Some(conn),
        Err(err) => {
            tracing::debug!("codex state db open failed: {err}");
            None
        }
    }
}

struct CodexThreadRow {
    id: String,
    title: Option<String>,
    first_user_message: Option<String>,
    created_at_ms: u128,
    updated_at_ms: u128,
}

impl CodexThreadRow {
    fn into_history_entry(self, cwd: &str) -> HistoryEntry {
        let summary = self
            .first_user_message
            .as_deref()
            .map(|s| summarize(s, 72))
            .filter(|s| !s.is_empty());
        let title = self
            .title
            .clone()
            .filter(|s| !s.is_empty())
            .or_else(|| summary.clone())
            .unwrap_or_else(|| format!("Codex · {}", short_id(&self.id)));
        HistoryEntry {
            session_id: format!("codex:{}", self.id),
            title,
            agent_id: Some("codex".to_string()),
            cwd: cwd.to_string(),
            worktree_path: None,
            prompt_summary: summary,
            started_at_ms: self.created_at_ms,
            last_event_ms: self.updated_at_ms,
            exit_code: None,
            pinned: false,
            agent_session_id: Some(self.id),
            source: HistorySource::CodexDisk,
        }
    }
}

fn summarize(text: &str, max_len: usize) -> String {
    let line = text.lines().next().unwrap_or("").trim();
    if line.chars().count() <= max_len {
        return line.to_string();
    }
    line.chars().take(max_len).collect::<String>() + "…"
}

fn short_id(id: &str) -> String {
    id.chars().take(8).collect()
}

fn record_timestamp_ms(record: &Value) -> Option<u128> {
    if let Some(ms) = record.get("timestamp_ms").and_then(Value::as_u64) {
        return Some(ms as u128);
    }
    record
        .get("timestamp")
        .and_then(Value::as_str)
        .and_then(super::claude::parse_iso_ms)
}

fn map_record_to_ui_message(record: &Value) -> Option<Value> {
    let role = record
        .get("role")
        .and_then(Value::as_str)
        .or_else(|| record.get("type").and_then(Value::as_str))?;
    let text = extract_text(record)?;
    Some(json!({
        "type": "Notification",
        "data": { "level": role, "message": text },
    }))
}

fn extract_text(record: &Value) -> Option<String> {
    if let Some(s) = record.get("text").and_then(Value::as_str) {
        return Some(s.to_string());
    }
    match record.get("content")? {
        Value::String(s) => Some(s.clone()),
        Value::Array(blocks) => blocks
            .iter()
            .find_map(|b| b.get("text").and_then(Value::as_str).map(|s| s.to_string())),
        _ => None,
    }
}
