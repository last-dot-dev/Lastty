use automerge::{transaction::Transactable, ObjType, ReadDoc, ROOT};
use serde_json::Value;
use std::sync::Arc;
use tokio::sync::mpsc;

use super::app::App;
use super::doc::DocPatch;
use super::intent::Intent;

pub fn spawn_app_reducer(app: Arc<App>, mut inbox: mpsc::Receiver<Intent>) {
    tokio::spawn(async move {
        while let Some(intent) = inbox.recv().await {
            handle_intent(&app, intent);
        }
    });
}

fn handle_intent(app: &Arc<App>, intent: Intent) {
    let mut doc = app.doc.lock();
    let am = doc.inner_mut();
    match intent.verb.as_str() {
        "set_field" => {
            let Some(path) = intent.payload.get("path").and_then(|v| v.as_str()) else {
                return;
            };
            let value = intent
                .payload
                .get("value")
                .cloned()
                .unwrap_or(Value::Null);
            if apply_root_scalar(am, path, &value).is_ok() {
                let _ = app.outbox.patches.send(DocPatch::Put {
                    path: vec![path.to_string()],
                    value,
                });
            }
        }
        "add_activity" => {
            let title = intent
                .payload
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("new activity");
            let day = intent
                .payload
                .get("day")
                .and_then(|v| v.as_i64())
                .unwrap_or(1);
            let cost = intent
                .payload
                .get("cost")
                .and_then(|v| v.as_f64())
                .unwrap_or(0.0);
            let Some((_, list_id)) = am.get(ROOT, "activities").ok().flatten() else {
                return;
            };
            let idx = am.length(&list_id);
            let Ok(item) = am.insert_object(&list_id, idx, ObjType::Map) else {
                return;
            };
            let _ = am.put(&item, "title", title);
            let _ = am.put(&item, "day", day);
            let _ = am.put(&item, "cost", cost);
            let _ = app.outbox.patches.send(DocPatch::Insert {
                path: vec!["activities".into()],
                index: idx,
                value: serde_json::json!({
                    "title": title,
                    "day": day,
                    "cost": cost,
                }),
            });
        }
        "merge_node" => {
            let Some(list_path) = intent.payload.get("list_path").and_then(|v| v.as_str())
            else {
                return;
            };
            let Some(item) = intent.payload.get("item") else {
                return;
            };
            let Some((_, list_id)) = am.get(ROOT, list_path).ok().flatten() else {
                return;
            };
            let idx = am.length(&list_id);
            let Ok(map) = am.insert_object(&list_id, idx, ObjType::Map) else {
                return;
            };
            if let Some(obj) = item.as_object() {
                for (k, v) in obj {
                    match v {
                        Value::String(s) => {
                            let _ = am.put(&map, k.as_str(), s.as_str());
                        }
                        Value::Number(n) => {
                            if let Some(f) = n.as_f64() {
                                let _ = am.put(&map, k.as_str(), f);
                            } else if let Some(i) = n.as_i64() {
                                let _ = am.put(&map, k.as_str(), i);
                            }
                        }
                        Value::Bool(b) => {
                            let _ = am.put(&map, k.as_str(), *b);
                        }
                        _ => {}
                    }
                }
            }
            let _ = app.outbox.patches.send(DocPatch::Insert {
                path: vec![list_path.to_string()],
                index: idx,
                value: item.clone(),
            });
        }
        _ => {}
    }
}

fn apply_root_scalar(
    am: &mut automerge::AutoCommit,
    path: &str,
    value: &Value,
) -> Result<(), automerge::AutomergeError> {
    match value {
        Value::String(s) => am.put(ROOT, path, s.as_str())?,
        Value::Number(n) => {
            if let Some(f) = n.as_f64() {
                am.put(ROOT, path, f)?;
            } else if let Some(i) = n.as_i64() {
                am.put(ROOT, path, i)?;
            }
        }
        Value::Bool(b) => am.put(ROOT, path, *b)?,
        _ => {}
    }
    Ok(())
}

pub fn spawn_author_agent(app: Arc<App>, prompt: String) {
    tokio::spawn(async move {
        let system = "You are an author agent populating a Lastty app. Emit ONLY a newline-separated list of JSON intents. Each line: {\"verb\":\"add_activity\"|\"set_field\",\"payload\":{...}}. For add_activity, payload has title (string), day (int), cost (number). For set_field, payload has path (string, e.g. 'destination' or 'budget') and value. Emit at most 8 intents. No prose, no markdown, no commentary.";
        let user = format!("App purpose: {prompt}\nEmit intents now, one JSON object per line.");
        let Ok(body) = super::llm::complete(system, &user).await else {
            tracing::warn!("author agent: llm call failed");
            return;
        };
        for line in body.lines() {
            let line = line.trim();
            if line.is_empty() || !line.starts_with('{') {
                continue;
            }
            let Ok(v) = serde_json::from_str::<Value>(line) else {
                continue;
            };
            let verb = v["verb"].as_str().unwrap_or("noop").to_string();
            let payload = v["payload"].clone();
            let intent = Intent::new(app.id, verb, payload);
            let _ = app.inbox_tx.send(intent).await;
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        }
    });
}
