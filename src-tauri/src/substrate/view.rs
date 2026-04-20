use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ViewNode {
    Stack {
        children: Vec<ViewNode>,
        #[serde(default)]
        gap: u16,
    },
    Row {
        children: Vec<ViewNode>,
        #[serde(default)]
        gap: u16,
    },
    Text {
        binding: Binding,
    },
    List {
        items_path: String,
        item: Box<ViewNode>,
    },
    Card {
        title: Binding,
        body: Box<ViewNode>,
    },
    Progress {
        value_path: String,
        max: f64,
    },
    Button {
        label: String,
        intent_verb: String,
        #[serde(default)]
        intent_payload: Option<serde_json::Value>,
    },
    TextInput {
        value_path: String,
        #[serde(default)]
        placeholder: Option<String>,
    },
    Image {
        src_path: String,
    },
    Chart {
        series_path: String,
        chart_kind: ChartKind,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChartKind {
    Bar,
    Line,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Binding {
    Literal(String),
    Path {
        path: String,
        #[serde(default)]
        fallback: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ViewSpec {
    pub root: ViewNode,
}
