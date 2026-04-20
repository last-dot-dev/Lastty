use automerge::{transaction::Transactable, AutoCommit, ObjType, ROOT};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Serialize)]
struct Request {
    model: String,
    max_tokens: u32,
    system: String,
    messages: Vec<Msg>,
}

#[derive(Serialize, Deserialize)]
struct Msg {
    role: String,
    content: String,
}

pub async fn complete(system: &str, user: &str) -> Result<String, String> {
    let key = std::env::var("ANTHROPIC_API_KEY")
        .map_err(|_| "ANTHROPIC_API_KEY not set".to_string())?;
    let client = Client::new();
    let req = Request {
        model: "claude-sonnet-4-6".into(),
        max_tokens: 4096,
        system: system.into(),
        messages: vec![Msg {
            role: "user".into(),
            content: user.into(),
        }],
    };
    let resp = client
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", key)
        .header("anthropic-version", "2023-06-01")
        .json(&req)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let body: Value = resp.json().await.map_err(|e| e.to_string())?;
    let text = body["content"][0]["text"]
        .as_str()
        .ok_or_else(|| format!("bad response: {body}"))?;
    Ok(text.to_string())
}

pub async fn generate_app_spec(prompt: &str) -> Result<String, String> {
    let system = r#"You output STRICT JSON with this exact shape:
{
  "kind": "<short app kind identifier>",
  "view": { "root": <ViewNode> },
  "initial_doc": { ... initial document state ... },
  "agent_prompt": "<instructions for the author agent to populate this app>"
}

ViewNode kinds available (use lowercase snake_case):
- {"kind":"stack","children":[<ViewNode>...],"gap":<u16>}
- {"kind":"row","children":[<ViewNode>...],"gap":<u16>}
- {"kind":"text","binding":{"path":"<doc.path>","fallback":"<str>"}}
- {"kind":"list","items_path":"<doc.path>","item":<ViewNode>}
- {"kind":"card","title":{"path":"<doc.path>","fallback":"<str>"},"body":<ViewNode>}
- {"kind":"progress","value_path":"<doc.path>","max":<number>}
- {"kind":"button","label":"<str>","intent_verb":"<str>","intent_payload":<any>}
- {"kind":"text_input","value_path":"<doc.path>","placeholder":"<str>"}
- {"kind":"image","src_path":"<doc.path>"}
- {"kind":"chart","series_path":"<doc.path>","chart_kind":"bar"|"line"}

initial_doc may use string, number, boolean values for scalar fields, and empty arrays/objects for list/map fields (the runtime seeds structure-only from arrays/objects; populate them via agent intents).

No markdown. No prose. No commentary. Just the JSON object."#;
    let user = format!("Design a Lastty app for: {prompt}");
    complete(system, &user).await
}

pub fn seed_doc_from_json(am: &mut AutoCommit, value: &Value) {
    if let Some(obj) = value.as_object() {
        for (k, v) in obj {
            match v {
                Value::String(s) => {
                    let _ = am.put(ROOT, k.as_str(), s.as_str());
                }
                Value::Number(n) => {
                    if let Some(f) = n.as_f64() {
                        let _ = am.put(ROOT, k.as_str(), f);
                    } else if let Some(i) = n.as_i64() {
                        let _ = am.put(ROOT, k.as_str(), i);
                    }
                }
                Value::Bool(b) => {
                    let _ = am.put(ROOT, k.as_str(), *b);
                }
                Value::Array(_) => {
                    let _ = am.put_object(ROOT, k.as_str(), ObjType::List);
                }
                Value::Object(_) => {
                    let _ = am.put_object(ROOT, k.as_str(), ObjType::Map);
                }
                Value::Null => {}
            }
        }
    }
}
