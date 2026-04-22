use std::sync::Mutex;

use dashmap::DashMap;
use pane_protocol::peer::{Addr, PeerMessage, Presence};
use tauri::{AppHandle, Manager, Runtime};

use crate::bus::{BusEvent, EventBus};
use crate::terminal::manager::TerminalManager;
use crate::terminal::session::SessionId;

mod channel;
mod outbound;

use channel::{ChannelMap, RingEntry};

pub struct PeerRouter<R: Runtime = tauri::Wry> {
    app: AppHandle<R>,
    channels: Mutex<ChannelMap>,
    presence: DashMap<String, Presence>,
    correlation_owners: DashMap<String, String>,
}

impl<R: Runtime> PeerRouter<R> {
    pub fn new(app: AppHandle<R>) -> Self {
        Self {
            app,
            channels: Mutex::new(ChannelMap::default()),
            presence: DashMap::new(),
            correlation_owners: DashMap::new(),
        }
    }

    /// A session's agent emitted an OSC 7770 peer message; route it.
    pub fn ingest_from_session(&self, session_id: &SessionId, message: PeerMessage) {
        let from_session_id = session_id.to_string();
        let from = Addr::Session(from_session_id.clone());
        self.route(&from_session_id, from, message);
    }

    /// The user (UI chat input, approval click, etc.) sent a peer message.
    /// Uses the user's `from_session_id` only for recording context — the
    /// `from` address is `Addr::User`.
    pub fn ingest_from_user(&self, context_session_id: Option<String>, message: PeerMessage) {
        let context = context_session_id.unwrap_or_default();
        self.route(&context, Addr::User, message);
    }

    /// Clear channel subscriptions + presence + correlations for an exited session.
    pub fn forget_session(&self, session_id: &str) {
        self.channels.lock().unwrap().forget_session(session_id);
        self.presence.remove(session_id);
        self.correlation_owners
            .retain(|_, owner| owner.as_str() != session_id);
    }

    fn route(&self, source_session_id: &str, from: Addr, message: PeerMessage) {
        let ts_ms = now_ms();
        match message {
            PeerMessage::Dm {
                to,
                body,
                correlation_id,
            } => {
                if let Some(ref cid) = correlation_id {
                    self.correlation_owners
                        .insert(cid.clone(), source_session_id.to_string());
                }
                self.publish_event(BusEvent::PeerMessage {
                    session_id: source_session_id.to_string(),
                    from: from.clone(),
                    to: to.clone(),
                    kind: "dm".to_string(),
                    channel: None,
                    correlation_id: correlation_id.clone(),
                    body: body.clone(),
                });
                let reconstructed = PeerMessage::Dm {
                    to: to.clone(),
                    body,
                    correlation_id,
                };
                self.deliver_addr(source_session_id, &to, &reconstructed);
            }
            PeerMessage::Post {
                channel,
                body,
                reply_to,
            } => {
                let subscribers = {
                    let mut map = self.channels.lock().unwrap();
                    map.post(
                        &channel,
                        RingEntry {
                            from: from.clone(),
                            body: body.clone(),
                            reply_to: reply_to.clone(),
                            ts_ms,
                        },
                    )
                };
                self.publish_event(BusEvent::PeerMessage {
                    session_id: source_session_id.to_string(),
                    from: from.clone(),
                    to: Addr::Channel(channel.clone()),
                    kind: "post".to_string(),
                    channel: Some(channel.clone()),
                    correlation_id: None,
                    body: body.clone(),
                });
                let reconstructed = PeerMessage::Post {
                    channel,
                    body,
                    reply_to,
                };
                if let Some(manager) = self.manager() {
                    outbound::fanout(&manager, source_session_id, subscribers, &reconstructed);
                }
            }
            PeerMessage::Join { channel } => {
                let replay = {
                    let mut map = self.channels.lock().unwrap();
                    map.join(&channel, source_session_id)
                };
                self.publish_event(BusEvent::PeerMessage {
                    session_id: source_session_id.to_string(),
                    from: from.clone(),
                    to: Addr::Channel(channel.clone()),
                    kind: "join".to_string(),
                    channel: Some(channel.clone()),
                    correlation_id: None,
                    body: serde_json::Value::Null,
                });
                if replay.is_empty() {
                    return;
                }
                let Some(manager) = self.manager() else {
                    return;
                };
                let Ok(target_sid) = SessionId::parse(source_session_id) else {
                    return;
                };
                for entry in replay {
                    let replay_msg = PeerMessage::Post {
                        channel: channel.clone(),
                        body: entry.body,
                        reply_to: entry.reply_to,
                    };
                    outbound::deliver(&manager, &target_sid, &replay_msg);
                }
            }
            PeerMessage::Leave { channel } => {
                self.channels
                    .lock()
                    .unwrap()
                    .leave(&channel, source_session_id);
                self.publish_event(BusEvent::PeerMessage {
                    session_id: source_session_id.to_string(),
                    from,
                    to: Addr::Channel(channel.clone()),
                    kind: "leave".to_string(),
                    channel: Some(channel),
                    correlation_id: None,
                    body: serde_json::Value::Null,
                });
            }
            PeerMessage::Presence { status } => {
                self.presence.insert(source_session_id.to_string(), status);
                self.publish_event(BusEvent::PeerPresence {
                    session_id: source_session_id.to_string(),
                    from,
                    status,
                });
            }
            PeerMessage::Reply {
                correlation_id,
                body,
                error,
            } => {
                let owner = self
                    .correlation_owners
                    .get(&correlation_id)
                    .map(|entry| entry.value().clone());
                let Some(owner) = owner else {
                    tracing::debug!(
                        correlation_id = %correlation_id,
                        "peer reply dropped: no owner (replay or unsolicited)"
                    );
                    return;
                };
                self.correlation_owners.remove(&correlation_id);
                self.publish_event(BusEvent::PeerMessage {
                    session_id: source_session_id.to_string(),
                    from: from.clone(),
                    to: Addr::Session(owner.clone()),
                    kind: "reply".to_string(),
                    channel: None,
                    correlation_id: Some(correlation_id.clone()),
                    body: body.clone(),
                });
                if let Some(manager) = self.manager() {
                    if let Ok(target) = SessionId::parse(&owner) {
                        let reconstructed = PeerMessage::Reply {
                            correlation_id,
                            body,
                            error,
                        };
                        outbound::deliver(&manager, &target, &reconstructed);
                    }
                }
            }
        }
    }

    fn deliver_addr(&self, source_session_id: &str, to: &Addr, message: &PeerMessage) {
        let Some(manager) = self.manager() else {
            return;
        };
        match to {
            Addr::Session(sid) => {
                if let Ok(target) = SessionId::parse(sid) {
                    outbound::deliver(&manager, &target, message);
                }
            }
            Addr::Agent(agent_id) => {
                let recipients: Vec<String> = manager
                    .list_sessions()
                    .into_iter()
                    .filter(|info| info.agent_id.as_deref() == Some(agent_id.as_str()))
                    .map(|info| info.session_id)
                    .collect();
                outbound::fanout(&manager, source_session_id, recipients, message);
            }
            Addr::Channel(name) => {
                let subscribers = {
                    let map = self.channels.lock().unwrap();
                    // Read-only view of current subscribers via join-with-no-replay trick.
                    // We re-use `post`-style lock but without mutation.
                    map.subscribers_snapshot(name)
                };
                outbound::fanout(&manager, source_session_id, subscribers, message);
            }
            Addr::User => {
                // UI consumes via BusEvent::PeerMessage already published upstream.
            }
        }
    }

    fn publish_event(&self, event: BusEvent) {
        if let Some(bus) = self.app.try_state::<EventBus<R>>() {
            bus.publish(event);
        }
    }

    fn manager(&self) -> Option<tauri::State<'_, TerminalManager<R>>> {
        self.app.try_state::<TerminalManager<R>>()
    }
}

fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or_default()
}
