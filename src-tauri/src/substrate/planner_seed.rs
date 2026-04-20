use automerge::{transaction::Transactable, ObjType, ReadDoc, ROOT};

use super::doc::Document;
use super::schema::{FieldKind, FieldSpec, NodeType, SchemaRegistry};
use super::view::{Binding, ChartKind, ViewNode, ViewSpec};

pub fn register_planner_types(reg: &SchemaRegistry) {
    reg.register(NodeType {
        name: "activity".into(),
        fields: vec![
            FieldSpec {
                name: "title".into(),
                kind: FieldKind::String,
                optional: false,
            },
            FieldSpec {
                name: "day".into(),
                kind: FieldKind::Integer,
                optional: false,
            },
            FieldSpec {
                name: "cost".into(),
                kind: FieldKind::Number,
                optional: true,
            },
        ],
    });
    reg.register(NodeType {
        name: "trip".into(),
        fields: vec![
            FieldSpec {
                name: "destination".into(),
                kind: FieldKind::String,
                optional: false,
            },
            FieldSpec {
                name: "activities".into(),
                kind: FieldKind::List {
                    of: Box::new(FieldKind::Node {
                        name: "activity".into(),
                    }),
                },
                optional: false,
            },
            FieldSpec {
                name: "budget".into(),
                kind: FieldKind::Number,
                optional: true,
            },
        ],
    });
}

pub fn seed_trip_doc(destination: &str) -> Document {
    let mut d = Document::new();
    {
        let am = d.inner_mut();
        am.put(ROOT, "destination", destination).unwrap();
        am.put(ROOT, "budget", 0.0_f64).unwrap();
        am.put_object(ROOT, "activities", ObjType::List).unwrap();
    }
    d
}

pub fn populate_demo_trip(doc: &mut Document) {
    let am = doc.inner_mut();
    am.put(ROOT, "budget", 2400.0_f64).unwrap();
    let (_, activities) = am.get(ROOT, "activities").unwrap().unwrap();
    let a = am.insert_object(&activities, 0, ObjType::Map).unwrap();
    am.put(&a, "title", "Shinjuku walking tour").unwrap();
    am.put(&a, "day", 1_i64).unwrap();
    am.put(&a, "cost", 0.0_f64).unwrap();
    let b = am.insert_object(&activities, 1, ObjType::Map).unwrap();
    am.put(&b, "title", "Tsukiji breakfast").unwrap();
    am.put(&b, "day", 2_i64).unwrap();
    am.put(&b, "cost", 45.0_f64).unwrap();
}

pub fn planner_view() -> ViewSpec {
    ViewSpec {
        root: ViewNode::Stack {
            gap: 12,
            children: vec![ViewNode::Card {
                title: Binding::Path {
                    path: "destination".into(),
                    fallback: Some("Untitled trip".into()),
                },
                body: Box::new(ViewNode::Stack {
                    gap: 8,
                    children: vec![
                        ViewNode::Progress {
                            value_path: "budget".into(),
                            max: 5000.0,
                        },
                        ViewNode::List {
                            items_path: "activities".into(),
                            item: Box::new(ViewNode::Row {
                                gap: 8,
                                children: vec![
                                    ViewNode::Text {
                                        binding: Binding::Path {
                                            path: "title".into(),
                                            fallback: None,
                                        },
                                    },
                                    ViewNode::Text {
                                        binding: Binding::Path {
                                            path: "day".into(),
                                            fallback: Some("-".into()),
                                        },
                                    },
                                ],
                            }),
                        },
                        ViewNode::Chart {
                            series_path: "activities".into(),
                            chart_kind: ChartKind::Bar,
                        },
                    ],
                }),
            }],
        },
    }
}
