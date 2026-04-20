use automerge::{transaction::Transactable, AutoCommit, ObjId, ObjType, ReadDoc, Value as AmValue, ROOT};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, thiserror::Error)]
pub enum DocError {
    #[error("automerge error: {0}")]
    Automerge(String),
    #[error("path not found: {0}")]
    PathNotFound(String),
}

impl From<automerge::AutomergeError> for DocError {
    fn from(e: automerge::AutomergeError) -> Self {
        Self::Automerge(e.to_string())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum DocPatch {
    Put {
        path: Vec<String>,
        value: Value,
    },
    Insert {
        path: Vec<String>,
        index: usize,
        value: Value,
    },
    Delete {
        path: Vec<String>,
    },
}

pub struct Document {
    inner: AutoCommit,
}

impl Default for Document {
    fn default() -> Self {
        Self::new()
    }
}

impl Document {
    pub fn new() -> Self {
        Self {
            inner: AutoCommit::new(),
        }
    }

    pub fn put_root_map(&mut self, key: &str) -> Result<(), DocError> {
        self.inner.put_object(ROOT, key, ObjType::Map)?;
        Ok(())
    }

    pub fn put_root_list(&mut self, key: &str) -> Result<(), DocError> {
        self.inner.put_object(ROOT, key, ObjType::List)?;
        Ok(())
    }

    pub fn put_root_string(&mut self, key: &str, value: &str) -> Result<(), DocError> {
        self.inner.put(ROOT, key, value)?;
        Ok(())
    }

    pub fn materialize(&self) -> Value {
        object_to_json(&self.inner, &ROOT)
    }

    pub fn fork(&mut self) -> Self {
        Self {
            inner: self.inner.fork(),
        }
    }

    pub fn heads_hex(&mut self) -> Vec<String> {
        self.inner
            .get_heads()
            .iter()
            .map(|h| h.to_string())
            .collect()
    }

    pub fn materialize_at(&mut self, heads_hex: &[String]) -> Result<Value, DocError> {
        let heads: Result<Vec<automerge::ChangeHash>, _> =
            heads_hex.iter().map(|s| s.parse()).collect();
        let heads = heads.map_err(|e| DocError::Automerge(e.to_string()))?;
        let forked = self.inner.fork_at(&heads)?;
        Ok(object_to_json(&forked, &ROOT))
    }

    pub fn changes_summary(&mut self) -> Vec<ChangeSummary> {
        self.inner
            .get_changes(&[])
            .iter()
            .map(|c| ChangeSummary {
                hash: c.hash().to_string(),
                ts: c.timestamp(),
                actor: c.actor_id().to_string(),
                message: c.message().cloned().unwrap_or_default(),
            })
            .collect()
    }

    pub(crate) fn inner_mut(&mut self) -> &mut AutoCommit {
        &mut self.inner
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ChangeSummary {
    pub hash: String,
    pub ts: i64,
    pub actor: String,
    pub message: String,
}

fn object_to_json<R: ReadDoc>(doc: &R, obj: &ObjId) -> Value {
    match doc.object_type(obj) {
        Ok(ObjType::Map) | Ok(ObjType::Table) => {
            let mut out = serde_json::Map::new();
            let keys: Vec<String> = doc.keys(obj).collect();
            for k in keys {
                if let Ok(Some((v, id))) = doc.get(obj, &k) {
                    out.insert(k, value_to_json(doc, v, id));
                }
            }
            Value::Object(out)
        }
        Ok(ObjType::List) | Ok(ObjType::Text) => {
            let mut arr = Vec::new();
            let len = doc.length(obj);
            for i in 0..len {
                if let Ok(Some((v, id))) = doc.get(obj, i) {
                    arr.push(value_to_json(doc, v, id));
                }
            }
            Value::Array(arr)
        }
        Err(_) => Value::Null,
    }
}

fn value_to_json<R: ReadDoc>(doc: &R, v: AmValue<'_>, id: ObjId) -> Value {
    match v {
        AmValue::Object(_) => object_to_json(doc, &id),
        AmValue::Scalar(s) => scalar_to_json(&s),
    }
}

fn scalar_to_json(s: &std::borrow::Cow<'_, automerge::ScalarValue>) -> Value {
    use automerge::ScalarValue as SV;
    match s.as_ref() {
        SV::Str(v) => Value::String(v.to_string()),
        SV::Int(v) => Value::from(*v),
        SV::Uint(v) => Value::from(*v),
        SV::F64(v) => {
            if v.is_finite() {
                serde_json::Number::from_f64(*v)
                    .map(Value::Number)
                    .unwrap_or(Value::Null)
            } else {
                Value::Null
            }
        }
        SV::Boolean(v) => Value::Bool(*v),
        SV::Bytes(b) => Value::String(format!("0x{}", hex_encode(b))),
        SV::Counter(c) => Value::from(i64::from(c)),
        SV::Timestamp(t) => Value::from(*t),
        SV::Null => Value::Null,
        _ => Value::Null,
    }
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn put_and_materialize_round_trip() {
        let mut d = Document::new();
        d.put_root_string("destination", "Tokyo").unwrap();
        let json = d.materialize();
        assert_eq!(json["destination"], "Tokyo");
    }

    #[test]
    fn fork_is_independent() {
        let mut a = Document::new();
        a.put_root_string("destination", "Tokyo").unwrap();
        let mut b = a.fork();
        b.put_root_string("destination", "Kyoto").unwrap();
        assert_eq!(a.materialize()["destination"], "Tokyo");
        assert_eq!(b.materialize()["destination"], "Kyoto");
    }

    #[test]
    fn materialize_at_returns_prior_state() {
        let mut d = Document::new();
        d.put_root_string("destination", "Tokyo").unwrap();
        let heads = d.heads_hex();
        d.put_root_string("destination", "Kyoto").unwrap();
        let past = d.materialize_at(&heads).unwrap();
        assert_eq!(past["destination"], "Tokyo");
        assert_eq!(d.materialize()["destination"], "Kyoto");
    }
}
