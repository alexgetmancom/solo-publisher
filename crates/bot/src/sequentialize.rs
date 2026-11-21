//! `sequentialize(ctx => ctx.chat?.id.toString())` (`@grammyjs/runner`): every
//! update of one chat runs after the previous one has finished; updates
//! without a chat run unserialised. The lock is FIFO, so updates run in the
//! order they reached it.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::Arc;

use std::pin::Pin;
use std::task::{Context, Poll};

use tokio::sync::{Mutex, OwnedMutexGuard};

/// Lets every other ready task run once before this one continues, in the
/// order they became ready (a JavaScript `await` on a settled promise).
/// `tokio::task::yield_now` defers its wake-ups and replays them last-first,
/// which would hand a burst of updates the per-chat lock in reverse.
pub(crate) fn yield_now() -> YieldNow {
    YieldNow { yielded: false }
}

pub(crate) struct YieldNow {
    yielded: bool,
}

impl Future for YieldNow {
    type Output = ();

    fn poll(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<()> {
        if self.yielded {
            return Poll::Ready(());
        }
        self.yielded = true;
        context.waker().wake_by_ref();
        Poll::Pending
    }
}

/// One chat's lock and how many updates hold or wait for it.
type Chain = (Arc<Mutex<()>>, usize);

#[derive(Clone, Default)]
pub(crate) struct Sequence {
    chains: Rc<RefCell<HashMap<String, Chain>>>,
}

/// Held while one update of a chat runs.
pub(crate) struct Turn {
    sequence: Sequence,
    key: String,
    _guard: OwnedMutexGuard<()>,
}

impl Drop for Turn {
    fn drop(&mut self) {
        let mut chains = self.sequence.chains.borrow_mut();
        if let Some((_, waiting)) = chains.get_mut(&self.key) {
            *waiting -= 1;
            if *waiting == 0 {
                chains.remove(&self.key);
            }
        }
    }
}

impl Sequence {
    pub(crate) async fn turn(&self, key: Option<String>) -> Option<Turn> {
        let key = key?;
        let mutex = {
            let mut chains = self.chains.borrow_mut();
            let (mutex, waiting) = chains
                .entry(key.clone())
                .or_insert_with(|| (Arc::new(Mutex::new(())), 0));
            *waiting += 1;
            Arc::clone(mutex)
        };
        let guard = mutex.lock_owned().await;
        Some(Turn {
            sequence: self.clone(),
            key,
            _guard: guard,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[test]
    fn one_chat_runs_one_update_at_a_time() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let local = tokio::task::LocalSet::new();
        let order = Rc::new(RefCell::new(Vec::new()));
        local.block_on(&runtime, async {
            let sequence = Sequence::default();
            let mut handles = Vec::new();
            for (index, chat) in [(0, "a"), (1, "a"), (2, "b"), (3, "a")] {
                let sequence = sequence.clone();
                let order = Rc::clone(&order);
                handles.push(tokio::task::spawn_local(async move {
                    let _turn = sequence.turn(Some(chat.to_owned())).await;
                    order.borrow_mut().push(format!("start {index}"));
                    tokio::time::sleep(std::time::Duration::from_millis(if index == 0 { 30 } else { 1 })).await;
                    order.borrow_mut().push(format!("end {index}"));
                }));
            }
            for handle in handles {
                handle.await.unwrap();
            }
            assert!(sequence.chains.borrow().is_empty());
        });
        assert_eq!(
            *order.borrow(),
            [
                "start 0", "start 2", "end 2", "end 0", "start 1", "end 1", "start 3", "end 3"
            ]
        );
    }
}
