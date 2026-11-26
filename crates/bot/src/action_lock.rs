//! The double-tap guard: a mutating action runs
//! only if its key is not already in flight. Process-local on purpose; durable
//! idempotency is the services' business.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

/// A held lock expires on its own, so an action that never settles cannot
/// leave its button dead until a restart.
const TTL_MS: i64 = 5 * 60_000;

#[derive(Clone, Default)]
pub struct ActionLocks {
    in_flight: Rc<RefCell<HashMap<String, i64>>>,
}

/// Releases its key when dropped (`finally { inFlight.delete(key) }`).
pub struct ActionLockGuard {
    locks: ActionLocks,
    key: String,
}

impl Drop for ActionLockGuard {
    fn drop(&mut self) {
        self.locks.in_flight.borrow_mut().remove(&self.key);
    }
}

impl ActionLocks {
    /// `None` when the key is held and not yet expired.
    pub fn acquire(&self, key: &str, now_ms: i64) -> Option<ActionLockGuard> {
        let mut in_flight = self.in_flight.borrow_mut();
        if in_flight.get(key).is_some_and(|since| now_ms - since < TTL_MS) {
            return None;
        }
        in_flight.insert(key.to_owned(), now_ms);
        Some(ActionLockGuard {
            locks: self.clone(),
            key: key.to_owned(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_held_key_refuses_until_released_or_expired() {
        let locks = ActionLocks::default();
        let held = locks.acquire("a", 0).unwrap();
        assert!(locks.acquire("a", 1).is_none());
        assert!(locks.acquire("b", 1).is_some());
        assert!(locks.acquire("a", TTL_MS).is_some());
        drop(held);
        assert!(locks.acquire("a", 2).is_some());
    }
}
