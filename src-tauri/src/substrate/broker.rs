use tokio::sync::broadcast;

use super::doc::DocPatch;
use super::ids::{AppId, SubscriptionId};
use super::intent::{Intent, IntentError};
use super::registry::AppRegistry;

#[derive(Clone, Default)]
pub struct Broker {
    pub registry: AppRegistry,
}

impl Broker {
    pub fn new(registry: AppRegistry) -> Self {
        Self { registry }
    }

    pub async fn send(&self, intent: Intent) -> Result<(), IntentError> {
        let app = self
            .registry
            .get(intent.target)
            .ok_or(IntentError::TargetNotFound(intent.target))?;
        app.inbox_tx
            .send(intent)
            .await
            .map_err(|e| IntentError::InvalidPayload {
                verb: "send".into(),
                reason: e.to_string(),
            })
    }

    pub fn subscribe(
        &self,
        target: AppId,
    ) -> Option<(SubscriptionId, broadcast::Receiver<DocPatch>)> {
        let app = self.registry.get(target)?;
        Some((SubscriptionId::new(), app.outbox.patches.subscribe()))
    }
}

#[cfg(test)]
mod tests {
    use super::super::app::new_app;
    use super::super::doc::Document;
    use super::super::intent::Intent;
    use super::super::registry::AppRegistry;
    use super::super::view::{ViewNode, ViewSpec};
    use super::Broker;
    use serde_json::json;
    use std::sync::Arc;

    fn blank_view() -> ViewSpec {
        ViewSpec {
            root: ViewNode::Stack {
                children: vec![],
                gap: 0,
            },
        }
    }

    #[tokio::test]
    async fn broker_routes_intent_to_target_app() {
        let registry = AppRegistry::default();
        let (app, mut handles) = new_app("test", Document::new(), blank_view());
        let app_id = app.id;
        registry.insert(Arc::new(app));
        let broker = Broker::new(registry);
        broker
            .send(Intent::new(app_id, "ping", json!({})))
            .await
            .unwrap();
        let intent = handles.inbox_rx.recv().await.unwrap();
        assert_eq!(intent.verb, "ping");
    }

    #[tokio::test]
    async fn subscribe_receives_broadcast_patches() {
        use super::super::doc::DocPatch;
        let registry = AppRegistry::default();
        let (app, handles) = new_app("test", Document::new(), blank_view());
        let app_id = app.id;
        registry.insert(Arc::new(app));
        let broker = Broker::new(registry);
        let (_sub, mut rx) = broker.subscribe(app_id).unwrap();
        handles
            .patches_tx
            .send(DocPatch::Put {
                path: vec!["x".into()],
                value: json!(1),
            })
            .unwrap();
        let patch = rx.recv().await.unwrap();
        if let DocPatch::Put { path, value } = patch {
            assert_eq!(path, vec!["x"]);
            assert_eq!(value, json!(1));
        } else {
            panic!("wrong patch kind");
        }
    }
}
