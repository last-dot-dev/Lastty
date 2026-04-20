use parking_lot::Mutex;
use std::sync::Arc;
use tokio::sync::{broadcast, mpsc};

use super::doc::{DocPatch, Document};
use super::ids::AppId;
use super::intent::Intent;
use super::view::ViewSpec;

pub struct AppOutbox {
    pub patches: broadcast::Sender<DocPatch>,
}

pub struct App {
    pub id: AppId,
    pub kind: String,
    pub doc: Arc<Mutex<Document>>,
    pub view: Arc<Mutex<ViewSpec>>,
    pub inbox_tx: mpsc::Sender<Intent>,
    pub outbox: AppOutbox,
}

pub struct AppHandles {
    pub inbox_rx: mpsc::Receiver<Intent>,
    pub patches_tx: broadcast::Sender<DocPatch>,
}

pub fn new_app(kind: impl Into<String>, doc: Document, view: ViewSpec) -> (App, AppHandles) {
    let (inbox_tx, inbox_rx) = mpsc::channel(64);
    let (patches_tx, _) = broadcast::channel(256);
    let app = App {
        id: AppId::new(),
        kind: kind.into(),
        doc: Arc::new(Mutex::new(doc)),
        view: Arc::new(Mutex::new(view)),
        inbox_tx,
        outbox: AppOutbox {
            patches: patches_tx.clone(),
        },
    };
    (
        app,
        AppHandles {
            inbox_rx,
            patches_tx,
        },
    )
}
