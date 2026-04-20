use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use tokio::task;

use super::app::{new_app, App};
use super::broker::Broker;
use super::doc::Document;
use super::ids::{AppId, SubscriptionId};
use super::intent::Intent;
use super::planner_seed::{planner_view, populate_demo_trip, seed_trip_doc};
use super::registry::AppRegistry;
use super::view::ViewSpec;

#[derive(Clone)]
pub struct SubstrateState {
    pub registry: AppRegistry,
    pub broker: Broker,
}

impl SubstrateState {
    pub fn new() -> Self {
        let registry = AppRegistry::default();
        let broker = Broker::new(registry.clone());
        Self { registry, broker }
    }
}

impl Default for SubstrateState {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpawnedApp {
    pub id: AppId,
    pub kind: String,
    pub view: ViewSpec,
    pub doc: Value,
}

fn new_and_insert(
    state: &SubstrateState,
    kind: String,
    doc: Document,
    view: ViewSpec,
) -> (Arc<App>, super::app::AppHandles) {
    let (app, handles) = new_app(kind, doc, view);
    let arc = Arc::new(app);
    state.registry.insert(arc.clone());
    (arc, handles)
}

#[tauri::command]
pub async fn substrate_spawn_seed(
    kind: String,
    state: State<'_, SubstrateState>,
) -> Result<SpawnedApp, String> {
    let (mut doc, view) = match kind.as_str() {
        "planner" => {
            let mut d = seed_trip_doc("Tokyo");
            populate_demo_trip(&mut d);
            (d, planner_view())
        }
        other => return Err(format!("unknown seed: {other}")),
    };
    let materialized = doc.materialize();
    let heads = doc.heads_hex();
    tracing::info!("seed doc heads: {heads:?}");
    let (arc, handles) = new_and_insert(&state, kind.clone(), doc, view.clone());
    super::agent::spawn_app_reducer(arc.clone(), handles.inbox_rx);
    Ok(SpawnedApp {
        id: arc.id,
        kind,
        view,
        doc: materialized,
    })
}

#[tauri::command]
pub async fn substrate_materialize(
    app_id: AppId,
    state: State<'_, SubstrateState>,
) -> Result<Value, String> {
    let app = state
        .registry
        .get(app_id)
        .ok_or_else(|| "app not found".to_string())?;
    let doc = app.doc.lock();
    Ok(doc.materialize())
}

#[tauri::command]
pub async fn substrate_send_intent(
    target: AppId,
    verb: String,
    payload: Value,
    state: State<'_, SubstrateState>,
) -> Result<(), String> {
    let intent = Intent::new(target, verb, payload);
    state.broker.send(intent).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn substrate_subscribe(
    target: AppId,
    app_handle: AppHandle,
    state: State<'_, SubstrateState>,
) -> Result<SubscriptionId, String> {
    let (sub_id, mut rx) = state
        .broker
        .subscribe(target)
        .ok_or_else(|| "app not found".to_string())?;
    let handle = app_handle.clone();
    let event_name = format!("substrate:patch:{target}");
    task::spawn(async move {
        while let Ok(patch) = rx.recv().await {
            let _ = handle.emit(&event_name, &patch);
        }
    });
    Ok(sub_id)
}

#[tauri::command]
pub async fn substrate_fork(
    source: AppId,
    state: State<'_, SubstrateState>,
) -> Result<SpawnedApp, String> {
    let src = state
        .registry
        .get(source)
        .ok_or_else(|| "source not found".to_string())?;
    let (forked_doc, view, kind) = {
        let mut src_doc = src.doc.lock();
        let forked = src_doc.fork();
        (forked, src.view.lock().clone(), src.kind.clone())
    };
    let materialized = forked_doc.materialize();
    let (arc, handles) = new_and_insert(&state, kind.clone(), forked_doc, view.clone());
    super::agent::spawn_app_reducer(arc.clone(), handles.inbox_rx);
    Ok(SpawnedApp {
        id: arc.id,
        kind,
        view,
        doc: materialized,
    })
}

#[tauri::command]
pub async fn substrate_spawn_generative(
    prompt: String,
    state: State<'_, SubstrateState>,
) -> Result<SpawnedApp, String> {
    let raw = super::llm::generate_app_spec(&prompt).await?;
    let trimmed = super::llm::strip_json_fences(&raw);
    let parsed: Value = serde_json::from_str(trimmed)
        .map_err(|e| format!("bad llm json: {e}; body: {raw}"))?;
    let kind = parsed["kind"].as_str().unwrap_or("generated").to_string();
    let view: ViewSpec = serde_json::from_value(parsed["view"].clone())
        .map_err(|e| format!("bad view spec: {e}"))?;
    let initial = &parsed["initial_doc"];
    let mut doc = Document::new();
    super::llm::seed_doc_from_json(doc.inner_mut(), initial);
    let materialized = doc.materialize();
    let (arc, handles) = new_and_insert(&state, kind.clone(), doc, view.clone());
    super::agent::spawn_app_reducer(arc.clone(), handles.inbox_rx);
    if let Some(agent_prompt) = parsed["agent_prompt"].as_str() {
        super::agent::spawn_author_agent(arc.clone(), agent_prompt.to_string());
    }
    Ok(SpawnedApp {
        id: arc.id,
        kind,
        view,
        doc: materialized,
    })
}

#[derive(Serialize)]
pub struct HistoryEntry {
    pub hash: String,
    pub ts: i64,
    pub actor: String,
    pub message: String,
}

#[tauri::command]
pub async fn substrate_history(
    app_id: AppId,
    state: State<'_, SubstrateState>,
) -> Result<Vec<HistoryEntry>, String> {
    let app = state
        .registry
        .get(app_id)
        .ok_or_else(|| "app not found".to_string())?;
    let mut doc = app.doc.lock();
    Ok(doc
        .changes_summary()
        .into_iter()
        .map(|c| HistoryEntry {
            hash: c.hash,
            ts: c.ts,
            actor: c.actor,
            message: c.message,
        })
        .collect())
}

#[tauri::command]
pub async fn substrate_materialize_at(
    app_id: AppId,
    heads: Vec<String>,
    state: State<'_, SubstrateState>,
) -> Result<Value, String> {
    let app = state
        .registry
        .get(app_id)
        .ok_or_else(|| "app not found".to_string())?;
    let mut doc = app.doc.lock();
    doc.materialize_at(&heads).map_err(|e| e.to_string())
}
