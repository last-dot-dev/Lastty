use std::collections::HashSet;
use std::sync::{Condvar, Mutex};

use crate::terminal::session::SessionId;

pub struct DirtyState {
    pub generation: u64,
    pub sessions: Vec<SessionId>,
    pub total_wakeups: u64,
}

struct Inner {
    generation: u64,
    pending: HashSet<SessionId>,
    total_wakeups: u64,
}

pub struct RenderCoordinator {
    inner: Mutex<Inner>,
    cv: Condvar,
}

impl Default for RenderCoordinator {
    fn default() -> Self {
        Self::new()
    }
}

impl RenderCoordinator {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(Inner {
                generation: 0,
                pending: HashSet::new(),
                total_wakeups: 0,
            }),
            cv: Condvar::new(),
        }
    }

    pub(crate) fn mark_dirty(&self, session_id: SessionId) {
        let mut inner = self.inner.lock().expect("render coordinator poisoned");
        inner.generation = inner.generation.wrapping_add(1);
        inner.total_wakeups = inner.total_wakeups.wrapping_add(1);
        inner.pending.insert(session_id);
        self.cv.notify_one();
    }

    pub(crate) fn wait_for_next(&self) -> DirtyState {
        let mut inner = self.inner.lock().expect("render coordinator poisoned");
        while inner.pending.is_empty() {
            inner = self.cv.wait(inner).expect("render coordinator poisoned");
        }
        DirtyState {
            generation: inner.generation,
            sessions: inner.pending.drain().collect(),
            total_wakeups: inner.total_wakeups,
        }
    }

    pub(crate) fn current_generation(&self) -> u64 {
        self.inner
            .lock()
            .expect("render coordinator poisoned")
            .generation
    }

    pub(crate) fn total_wakeups(&self) -> u64 {
        self.inner
            .lock()
            .expect("render coordinator poisoned")
            .total_wakeups
    }
}
