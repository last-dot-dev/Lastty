use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeType {
    pub name: String,
    pub fields: Vec<FieldSpec>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FieldSpec {
    pub name: String,
    pub kind: FieldKind,
    #[serde(default)]
    pub optional: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "type")]
pub enum FieldKind {
    String,
    Integer,
    Number,
    Boolean,
    List { of: Box<FieldKind> },
    Map,
    Node { name: String },
}

#[derive(Default, Clone)]
pub struct SchemaRegistry {
    types: Arc<DashMap<String, NodeType>>,
}

impl SchemaRegistry {
    pub fn register(&self, t: NodeType) {
        self.types.insert(t.name.clone(), t);
    }

    pub fn get(&self, name: &str) -> Option<NodeType> {
        self.types.get(name).map(|r| r.clone())
    }

    pub fn names(&self) -> Vec<String> {
        self.types.iter().map(|r| r.key().clone()).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn register_and_lookup() {
        let reg = SchemaRegistry::default();
        reg.register(NodeType {
            name: "activity".into(),
            fields: vec![FieldSpec {
                name: "title".into(),
                kind: FieldKind::String,
                optional: false,
            }],
        });
        assert!(reg.get("activity").is_some());
        assert_eq!(reg.names().len(), 1);
    }
}
