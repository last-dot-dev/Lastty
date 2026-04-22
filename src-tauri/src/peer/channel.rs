use std::collections::{HashMap, HashSet, VecDeque};

use pane_protocol::peer::Addr;
use serde_json::Value;

pub(crate) const RING_CAP: usize = 50;

#[derive(Debug, Clone)]
pub(crate) struct RingEntry {
    #[allow(dead_code)]
    pub from: Addr,
    pub body: Value,
    pub reply_to: Option<String>,
    #[allow(dead_code)]
    pub ts_ms: u128,
}

#[derive(Debug, Default)]
pub(crate) struct ChannelState {
    pub subscribers: HashSet<String>,
    pub ring: VecDeque<RingEntry>,
}

#[derive(Debug, Default)]
pub(crate) struct ChannelMap {
    channels: HashMap<String, ChannelState>,
}

impl ChannelMap {
    pub fn join(&mut self, channel: &str, session_id: &str) -> Vec<RingEntry> {
        let state = self.channels.entry(channel.to_string()).or_default();
        state.subscribers.insert(session_id.to_string());
        state.ring.iter().cloned().collect()
    }

    pub fn leave(&mut self, channel: &str, session_id: &str) {
        if let Some(state) = self.channels.get_mut(channel) {
            state.subscribers.remove(session_id);
        }
    }

    pub fn forget_session(&mut self, session_id: &str) {
        for state in self.channels.values_mut() {
            state.subscribers.remove(session_id);
        }
    }

    /// Append a post to the channel ring and return the current subscribers.
    pub fn post(&mut self, channel: &str, entry: RingEntry) -> Vec<String> {
        let state = self.channels.entry(channel.to_string()).or_default();
        if state.ring.len() == RING_CAP {
            state.ring.pop_front();
        }
        state.ring.push_back(entry);
        state.subscribers.iter().cloned().collect()
    }

    pub fn subscribers_snapshot(&self, channel: &str) -> Vec<String> {
        self.channels
            .get(channel)
            .map(|state| state.subscribers.iter().cloned().collect())
            .unwrap_or_default()
    }

    #[cfg(test)]
    pub fn subscriber_count(&self, channel: &str) -> usize {
        self.channels
            .get(channel)
            .map(|state| state.subscribers.len())
            .unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn entry(text: &str) -> RingEntry {
        RingEntry {
            from: Addr::Session("s".into()),
            body: json!(text),
            reply_to: None,
            ts_ms: 0,
        }
    }

    #[test]
    fn join_replays_ring() {
        let mut map = ChannelMap::default();
        map.post("c", entry("a"));
        map.post("c", entry("b"));
        let replay = map.join("c", "late");
        assert_eq!(replay.len(), 2);
        assert_eq!(replay[0].body, json!("a"));
    }

    #[test]
    fn ring_caps_at_fifty() {
        let mut map = ChannelMap::default();
        for i in 0..(RING_CAP + 10) {
            map.post("c", entry(&i.to_string()));
        }
        let replay = map.join("c", "x");
        assert_eq!(replay.len(), RING_CAP);
        assert_eq!(replay[0].body, json!("10"));
    }

    #[test]
    fn leave_removes_subscriber() {
        let mut map = ChannelMap::default();
        map.join("c", "s1");
        map.join("c", "s2");
        assert_eq!(map.subscriber_count("c"), 2);
        map.leave("c", "s1");
        assert_eq!(map.subscriber_count("c"), 1);
    }

    #[test]
    fn forget_session_removes_from_all_channels() {
        let mut map = ChannelMap::default();
        map.join("a", "s1");
        map.join("b", "s1");
        map.join("a", "s2");
        map.forget_session("s1");
        assert_eq!(map.subscriber_count("a"), 1);
        assert_eq!(map.subscriber_count("b"), 0);
    }
}
