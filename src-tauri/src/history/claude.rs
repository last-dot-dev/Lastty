use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::thread;

use serde_json::{json, Value};

use crate::bus::{HistoryEntry, HistorySource};

const TITLE_SCAN_LINE_LIMIT: usize = 256;
const DISCOVERY_WORKERS: usize = 8;

struct CachedEntry {
    mtime_ms: u128,
    entry: HistoryEntry,
}

fn cache() -> &'static Mutex<HashMap<PathBuf, CachedEntry>> {
    static CACHE: std::sync::OnceLock<Mutex<HashMap<PathBuf, CachedEntry>>> =
        std::sync::OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

struct FileJob {
    path: PathBuf,
    session_uuid: String,
    project_cwd: PathBuf,
    mtime_ms: u128,
}

pub fn discover_all() -> Vec<HistoryEntry> {
    let Some(projects_dir) = super::home_dir().map(|h| h.join(".claude/projects")) else {
        return Vec::new();
    };
    let Ok(projects) = fs::read_dir(&projects_dir) else {
        return Vec::new();
    };

    let mut cached: Vec<HistoryEntry> = Vec::new();
    let mut todo: Vec<FileJob> = Vec::new();
    let mut seen_paths: Vec<PathBuf> = Vec::new();

    {
        let cache = cache().lock().unwrap();
        for project in projects.flatten() {
            if !project.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let project_path = project.path();
            let decoded_cwd = decode_project_dir(&project_path).unwrap_or(project_path.clone());
            let Ok(files) = fs::read_dir(&project_path) else {
                continue;
            };
            for file in files.flatten() {
                let Ok(file_name) = file.file_name().into_string() else {
                    continue;
                };
                let Some(session_uuid) = file_name.strip_suffix(".jsonl") else {
                    continue;
                };
                let path = file.path();
                let Ok(metadata) = file.metadata() else {
                    continue;
                };
                let mtime_ms = mtime_millis(&metadata);
                seen_paths.push(path.clone());

                if let Some(hit) = cache.get(&path) {
                    if hit.mtime_ms == mtime_ms {
                        cached.push(hit.entry.clone());
                        continue;
                    }
                }
                todo.push(FileJob {
                    path,
                    session_uuid: session_uuid.to_string(),
                    project_cwd: decoded_cwd.clone(),
                    mtime_ms,
                });
            }
        }
    }

    let parsed = parse_jobs_in_parallel(todo);

    {
        let mut cache = cache().lock().unwrap();
        let seen: std::collections::HashSet<&PathBuf> = seen_paths.iter().collect();
        cache.retain(|path, _| seen.contains(path));
        for (path, mtime_ms, entry) in &parsed {
            cache.insert(
                path.clone(),
                CachedEntry {
                    mtime_ms: *mtime_ms,
                    entry: entry.clone(),
                },
            );
        }
    }

    let mut out = cached;
    out.extend(parsed.into_iter().map(|(_, _, entry)| entry));
    out
}

fn parse_jobs_in_parallel(jobs: Vec<FileJob>) -> Vec<(PathBuf, u128, HistoryEntry)> {
    if jobs.is_empty() {
        return Vec::new();
    }
    let worker_count = DISCOVERY_WORKERS.min(jobs.len()).max(1);
    let chunk_size = jobs.len().div_ceil(worker_count);

    thread::scope(|scope| {
        let mut handles = Vec::with_capacity(worker_count);
        for chunk in jobs.chunks(chunk_size) {
            handles.push(scope.spawn(move || {
                let mut out = Vec::with_capacity(chunk.len());
                for job in chunk {
                    if let Some(entry) =
                        build_entry(&job.path, &job.session_uuid, &job.project_cwd, job.mtime_ms)
                    {
                        out.push((job.path.clone(), job.mtime_ms, entry));
                    }
                }
                out
            }));
        }
        handles
            .into_iter()
            .flat_map(|h| h.join().unwrap_or_default())
            .collect()
    })
}

pub fn read_transcript(session_uuid: &str) -> Result<String, String> {
    let path = find_jsonl(session_uuid).ok_or_else(|| "claude session not found".to_string())?;
    let file = fs::File::open(&path).map_err(|e| e.to_string())?;
    let reader = BufReader::new(file);

    let mut out = String::new();
    for line in reader.lines() {
        let line = match line {
            Ok(value) => value,
            Err(_) => continue,
        };
        let Ok(record) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let ts_ms = record
            .get("timestamp")
            .and_then(|v| v.as_str())
            .and_then(parse_iso_ms);
        if let Some(message) = map_record_to_ui_message(&record) {
            let mut envelope = json!({
                "agent_ui_message": message,
            });
            if let (Some(obj), Some(ts)) = (envelope.as_object_mut(), ts_ms) {
                obj.insert("ts_ms".into(), json!(ts));
            }
            out.push_str(&envelope.to_string());
            out.push('\n');
        }
    }
    Ok(out)
}

fn build_entry(
    path: &Path,
    session_uuid: &str,
    project_cwd: &Path,
    mtime_ms: u128,
) -> Option<HistoryEntry> {
    let file = fs::File::open(path).ok()?;
    let reader = BufReader::new(file);

    let mut started_at_ms: u128 = 0;
    let mut title: Option<String> = None;
    let mut prompt_summary: Option<String> = None;

    for line in reader.lines().take(TITLE_SCAN_LINE_LIMIT).flatten() {
        let Ok(record) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if started_at_ms == 0 {
            if let Some(ts) = record
                .get("timestamp")
                .and_then(|v| v.as_str())
                .and_then(parse_iso_ms)
            {
                started_at_ms = ts;
            }
        }

        if title.is_none() && record.get("type").and_then(Value::as_str) == Some("user") {
            if let Some(text) = first_user_text(&record) {
                let trimmed = first_line_summary(&text, 72);
                if !trimmed.is_empty() {
                    prompt_summary = Some(trimmed.clone());
                    title = Some(trimmed);
                }
            }
        }

        if title.is_some() && started_at_ms != 0 {
            break;
        }
    }

    let last_event_ms = mtime_ms;
    if started_at_ms == 0 {
        started_at_ms = mtime_ms;
    }

    Some(HistoryEntry {
        session_id: format!("claude:{session_uuid}"),
        title: title
            .clone()
            .unwrap_or_else(|| format!("Claude · {session_uuid}")),
        agent_id: Some("claude".to_string()),
        cwd: project_cwd.display().to_string(),
        worktree_path: None,
        prompt_summary,
        started_at_ms,
        last_event_ms,
        exit_code: None,
        pinned: false,
        agent_session_id: Some(session_uuid.to_string()),
        source: HistorySource::ClaudeDisk,
    })
}

fn find_jsonl(session_uuid: &str) -> Option<PathBuf> {
    let projects_dir = super::home_dir()?.join(".claude/projects");
    for project in fs::read_dir(projects_dir).ok()?.flatten() {
        let candidate = project.path().join(format!("{session_uuid}.jsonl"));
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

pub(crate) fn find_entry(session_uuid: &str) -> Option<HistoryEntry> {
    let jsonl = find_jsonl(session_uuid)?;
    let project_dir = jsonl.parent()?;
    let decoded = decode_project_dir(project_dir)?;
    let metadata = fs::metadata(&jsonl).ok()?;
    let mtime_ms = mtime_millis(&metadata);
    build_entry(&jsonl, session_uuid, &decoded, mtime_ms)
}

fn mtime_millis(metadata: &fs::Metadata) -> u128 {
    metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn decode_project_dir(project_dir: &Path) -> Option<PathBuf> {
    let name = project_dir.file_name()?.to_str()?;
    if !name.starts_with('-') {
        return None;
    }
    Some(PathBuf::from(name.replace('-', "/")))
}

fn first_user_text(record: &Value) -> Option<String> {
    let content = record.get("message")?.get("content")?;
    match content {
        Value::String(s) => Some(s.clone()),
        Value::Array(blocks) => {
            for block in blocks {
                if block.get("type").and_then(Value::as_str) == Some("text") {
                    if let Some(text) = block.get("text").and_then(Value::as_str) {
                        if !is_system_preamble(text) {
                            return Some(text.to_string());
                        }
                    }
                }
            }
            None
        }
        _ => None,
    }
}

fn is_system_preamble(text: &str) -> bool {
    let trimmed = text.trim_start();
    trimmed.starts_with("<ide_opened_file>")
        || trimmed.starts_with("<command-name>")
        || trimmed.starts_with("<system-reminder>")
        || trimmed.starts_with("<local-command-stdout>")
}

fn first_line_summary(text: &str, max_len: usize) -> String {
    let line = text.lines().next().unwrap_or("").trim();
    if line.chars().count() <= max_len {
        return line.to_string();
    }
    line.chars().take(max_len).collect::<String>() + "…"
}

fn map_record_to_ui_message(record: &Value) -> Option<Value> {
    let rec_type = record.get("type").and_then(Value::as_str)?;
    match rec_type {
        "user" => {
            let text = first_user_text(record)?;
            Some(json!({
                "type": "Notification",
                "data": { "level": "user", "message": text },
            }))
        }
        "assistant" => {
            let content = record.get("message")?.get("content")?;
            let blocks = content.as_array()?;
            for block in blocks {
                let block_type = block.get("type").and_then(Value::as_str)?;
                match block_type {
                    "text" => {
                        let text = block.get("text").and_then(Value::as_str)?.to_string();
                        return Some(json!({
                            "type": "Notification",
                            "data": { "level": "assistant", "message": text },
                        }));
                    }
                    "tool_use" => {
                        let id = block
                            .get("id")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string();
                        let name = block
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or("tool")
                            .to_string();
                        let args = block
                            .get("input")
                            .cloned()
                            .unwrap_or_else(|| Value::Object(serde_json::Map::new()));
                        return Some(json!({
                            "type": "ToolCall",
                            "data": { "id": id, "name": name, "args": args },
                        }));
                    }
                    "tool_result" => {
                        let id = block
                            .get("tool_use_id")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string();
                        let result = block.get("content").cloned().unwrap_or(Value::Null);
                        return Some(json!({
                            "type": "ToolResult",
                            "data": { "id": id, "result": result },
                        }));
                    }
                    _ => continue,
                }
            }
            None
        }
        _ => None,
    }
}

pub(super) fn parse_iso_ms(ts: &str) -> Option<u128> {
    let bytes = ts.as_bytes();
    if bytes.len() < 20 {
        return None;
    }
    let year: i64 = std::str::from_utf8(&bytes[0..4]).ok()?.parse().ok()?;
    let month: u32 = std::str::from_utf8(&bytes[5..7]).ok()?.parse().ok()?;
    let day: u32 = std::str::from_utf8(&bytes[8..10]).ok()?.parse().ok()?;
    let hour: u32 = std::str::from_utf8(&bytes[11..13]).ok()?.parse().ok()?;
    let minute: u32 = std::str::from_utf8(&bytes[14..16]).ok()?.parse().ok()?;
    let second: u32 = std::str::from_utf8(&bytes[17..19]).ok()?.parse().ok()?;

    let mut ms: u32 = 0;
    if bytes.len() >= 24 && bytes[19] == b'.' {
        ms = std::str::from_utf8(&bytes[20..23]).ok()?.parse().ok()?;
    }

    let unix_days = days_from_civil(year, month, day);
    let total_secs =
        unix_days * 86_400 + (hour as i64) * 3600 + (minute as i64) * 60 + second as i64;
    if total_secs < 0 {
        return None;
    }
    Some((total_secs as u128) * 1000 + ms as u128)
}

// Howard Hinnant's days_from_civil — converts Y/M/D to days since 1970-01-01.
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let m = m as i64;
    let d = d as i64;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_iso_timestamps() {
        let got = parse_iso_ms("1970-01-01T00:00:00.000Z").unwrap();
        assert_eq!(got, 0);
        let got = parse_iso_ms("2026-04-18T04:27:03.337Z").unwrap();
        assert_eq!(got, 1_776_486_423_337);
    }

    #[test]
    fn maps_user_text_to_notification() {
        let record = serde_json::json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": [{ "type": "text", "text": "hello world" }],
            },
        });
        let ui = map_record_to_ui_message(&record).unwrap();
        assert_eq!(ui["type"], "Notification");
        assert_eq!(ui["data"]["level"], "user");
        assert_eq!(ui["data"]["message"], "hello world");
    }

    #[test]
    fn skips_ide_preamble_when_extracting_title() {
        let record = serde_json::json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": [
                    { "type": "text", "text": "<ide_opened_file>foo</ide_opened_file>" },
                    { "type": "text", "text": "real prompt" },
                ],
            },
        });
        assert_eq!(first_user_text(&record).as_deref(), Some("real prompt"));
    }

    #[test]
    fn maps_assistant_tool_use() {
        let record = serde_json::json!({
            "type": "assistant",
            "message": {
                "role": "assistant",
                "content": [
                    {
                        "type": "tool_use",
                        "id": "call_1",
                        "name": "Read",
                        "input": { "path": "/tmp/x" },
                    },
                ],
            },
        });
        let ui = map_record_to_ui_message(&record).unwrap();
        assert_eq!(ui["type"], "ToolCall");
        assert_eq!(ui["data"]["id"], "call_1");
        assert_eq!(ui["data"]["name"], "Read");
        assert_eq!(ui["data"]["args"]["path"], "/tmp/x");
    }

    #[test]
    fn decodes_project_dir_back_to_absolute_path() {
        let decoded = decode_project_dir(Path::new(
            "/home/x/.claude/projects/-Users-pabloeder-Lastty-Lastty",
        ))
        .unwrap();
        assert_eq!(decoded.to_str().unwrap(), "/Users/pabloeder/Lastty/Lastty");
    }
}
