use std::sync::{Condvar, Mutex};
use std::time::Duration;

use crate::terminal::session::SessionId;

#[derive(Clone, Copy)]
pub struct DirtyState {
    pub generation: u64,
    pub session_id: SessionId,
    pub total_wakeups: u64,
}

struct Inner {
    generation: u64,
    session_id: Option<SessionId>,
    total_wakeups: u64,
}

pub struct RenderCoordinator {
    inner: Mutex<Inner>,
    cv: Condvar,
}

impl RenderCoordinator {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(Inner {
                generation: 0,
                session_id: None,
                total_wakeups: 0,
            }),
            cv: Condvar::new(),
        }
    }

    pub fn mark_dirty(&self, session_id: SessionId) {
        let mut inner = self.inner.lock().expect("render coordinator poisoned");
        inner.generation = inner.generation.wrapping_add(1);
        inner.total_wakeups = inner.total_wakeups.wrapping_add(1);
        inner.session_id = Some(session_id);
        self.cv.notify_one();
    }

    pub fn wait_for_next(&self, rendered_generation: u64) -> DirtyState {
        let mut inner = self.inner.lock().expect("render coordinator poisoned");
        while inner.generation == rendered_generation || inner.session_id.is_none() {
            inner = self.cv.wait(inner).expect("render coordinator poisoned");
        }

        DirtyState {
            generation: inner.generation,
            session_id: inner.session_id.expect("session id should be set"),
            total_wakeups: inner.total_wakeups,
        }
    }

    pub fn wait_for_next_timeout(
        &self,
        rendered_generation: u64,
        timeout: Duration,
    ) -> Option<DirtyState> {
        let inner = self.inner.lock().expect("render coordinator poisoned");
        let (inner, timeout_result) = self
            .cv
            .wait_timeout_while(inner, timeout, |inner| {
                inner.generation == rendered_generation || inner.session_id.is_none()
            })
            .expect("render coordinator poisoned");

        if timeout_result.timed_out()
            && (inner.generation == rendered_generation || inner.session_id.is_none())
        {
            return None;
        }

        Some(DirtyState {
            generation: inner.generation,
            session_id: inner.session_id.expect("session id should be set"),
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
