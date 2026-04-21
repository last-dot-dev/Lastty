use std::collections::{HashSet, VecDeque};
use std::sync::{Condvar, Mutex};
use std::time::Duration;

use crate::terminal::session::SessionId;

pub struct DirtyState {
    pub generation: u64,
    pub session_id: SessionId,
    pub total_wakeups: u64,
}

struct Inner {
    generation: u64,
    queue: VecDeque<SessionId>,
    queued: HashSet<SessionId>,
    total_wakeups: u64,
}

impl Inner {
    fn pop(&mut self) -> Option<SessionId> {
        let sid = self.queue.pop_front()?;
        self.queued.remove(&sid);
        Some(sid)
    }
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
                queue: VecDeque::new(),
                queued: HashSet::new(),
                total_wakeups: 0,
            }),
            cv: Condvar::new(),
        }
    }

    pub fn mark_dirty(&self, session_id: SessionId) {
        let mut inner = self.inner.lock().expect("render coordinator poisoned");
        inner.generation = inner.generation.wrapping_add(1);
        inner.total_wakeups = inner.total_wakeups.wrapping_add(1);
        // Dedup: if a session already has a pending render, don't re-queue.
        // Any grid state it accumulates before its turn is swept up by the
        // single render (alacritty tracks damage until reset_damage).
        if inner.queued.insert(session_id) {
            inner.queue.push_back(session_id);
        }
        self.cv.notify_one();
    }

    pub fn wait_for_next(&self) -> DirtyState {
        let mut inner = self.inner.lock().expect("render coordinator poisoned");
        while inner.queue.is_empty() {
            inner = self.cv.wait(inner).expect("render coordinator poisoned");
        }
        let session_id = inner.pop().expect("queue non-empty");
        DirtyState {
            generation: inner.generation,
            session_id,
            total_wakeups: inner.total_wakeups,
        }
    }

    pub fn wait_for_next_timeout(&self, timeout: Duration) -> Option<DirtyState> {
        let inner = self.inner.lock().expect("render coordinator poisoned");
        let (mut inner, timeout_result) = self
            .cv
            .wait_timeout_while(inner, timeout, |inner| inner.queue.is_empty())
            .expect("render coordinator poisoned");

        if timeout_result.timed_out() && inner.queue.is_empty() {
            return None;
        }

        let session_id = inner.pop().expect("queue non-empty");
        Some(DirtyState {
            generation: inner.generation,
            session_id,
            total_wakeups: inner.total_wakeups,
        })
    }

    pub fn current_generation(&self) -> u64 {
        self.inner
            .lock()
            .expect("render coordinator poisoned")
            .generation
    }

    pub fn total_wakeups(&self) -> u64 {
        self.inner
            .lock()
            .expect("render coordinator poisoned")
            .total_wakeups
    }
}
