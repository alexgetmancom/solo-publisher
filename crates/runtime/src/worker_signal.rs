//! The doorbells of the two queues a person waits on.
//!
//! Both workers poll every five seconds; a ring wakes one now. The poll stays
//! as the safety net. A ring made inside a transaction must not wake a worker
//! that cannot see the row yet, so it runs as its own task: on the
//! single-threaded runtime that is after the current task, and its commit,
//! have yielded. Rings collapse while one is pending: a publication enqueues
//! one job per target and needs exactly one wake.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;
use std::time::Duration;

use domain::publishing::boundaries::WorkerBell;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum WorkerQueue {
    Publish,
    TelegramEvents,
}

thread_local! {
    static WAKES: RefCell<HashMap<WorkerQueue, Rc<dyn Fn()>>> = RefCell::new(HashMap::new());
    static PENDING: RefCell<HashSet<WorkerQueue>> = RefCell::new(HashSet::new());
}

/// Called by the composition root once the loop exists; `None` unhooks it.
pub fn set_worker_wake(queue: WorkerQueue, wake: Option<Rc<dyn Fn()>>) {
    WAKES.with_borrow_mut(|wakes| match wake {
        Some(wake) => wakes.insert(queue, wake),
        None => wakes.remove(&queue),
    });
}

fn wake(queue: WorkerQueue) {
    // Cloned out first: the wake may ring again.
    let wake = WAKES.with_borrow(|wakes| wakes.get(&queue).cloned());
    if let Some(wake) = wake {
        wake();
    }
}

/// Wakes the queue's worker now. Must be called inside the process's `LocalSet`.
pub fn ring_worker(queue: WorkerQueue) {
    if !PENDING.with_borrow_mut(|pending| pending.insert(queue)) {
        return;
    }
    tokio::task::spawn_local(async move {
        PENDING.with_borrow_mut(|pending| pending.remove(&queue));
        wake(queue);
    });
}

/// Wakes the queue's worker after `delay`: a durable `next_attempt_at` is due then.
/// The polling interval remains the restart-safe fallback.
pub fn ring_worker_after(queue: WorkerQueue, delay: Duration) {
    tokio::task::spawn_local(async move {
        tokio::time::sleep(delay).await;
        wake(queue);
    });
}

/// Publishing's worker bell, on the process's doorbells.
pub struct WorkerSignals;

impl WorkerBell for WorkerSignals {
    fn ring_publish(&self) {
        ring_worker(WorkerQueue::Publish);
    }

    fn ring_publish_after(&self, delay_ms: u64) {
        ring_worker_after(WorkerQueue::Publish, Duration::from_millis(delay_ms));
    }
}
