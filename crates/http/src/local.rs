//! Runs route bodies on the process's `LocalSet`.
//!
//! axum needs `Send` handlers; the Studio's state is `Rc` and lives on one
//! thread. A handler extracts what it needs from the request (all `Send`) and
//! gives [`Local::run`] a closure; the dispatcher task, spawned on the
//! `LocalSet`, runs the closure's future there as its own task and sends the
//! answer back. A caller that stops waiting (the client disconnected) drops
//! that task's work, which ends a long poll.

use std::future::Future;
use std::pin::Pin;
use std::rc::Rc;

use tokio::sync::{mpsc, oneshot};

use crate::HttpState;

type Job = Box<dyn FnOnce(Rc<HttpState>) -> Pin<Box<dyn Future<Output = ()>>> + Send>;

/// The handle the routes share: cheap to clone, `Send + Sync`.
#[derive(Clone)]
pub struct Local(mpsc::UnboundedSender<Job>);

/// The local side is gone (the `LocalSet` stopped) or the work panicked.
#[derive(Debug)]
pub struct Gone;

impl Local {
    /// Spawns the dispatcher; must be called inside a `LocalSet`. It runs
    /// until every handle is dropped.
    pub fn start(state: HttpState) -> Self {
        let (sender, mut jobs) = mpsc::unbounded_channel::<Job>();
        let state = Rc::new(state);
        tokio::task::spawn_local(async move {
            while let Some(job) = jobs.recv().await {
                tokio::task::spawn_local(job(Rc::clone(&state)));
            }
        });
        Self(sender)
    }

    /// Runs `work` on the local side and returns what it produced.
    pub async fn run<F, W, T>(&self, work: F) -> Result<T, Gone>
    where
        F: FnOnce(Rc<HttpState>) -> W + Send + 'static,
        W: Future<Output = T> + 'static,
        T: Send + 'static,
    {
        let (reply, answer) = oneshot::channel();
        let job: Job = Box::new(move |state| {
            Box::pin(async move {
                let mut reply = reply;
                let work = work(state);
                tokio::select! {
                    value = work => {
                        let _ = reply.send(value);
                    }
                    () = reply.closed() => {}
                }
            })
        });
        self.0.send(job).map_err(|_| Gone)?;
        answer.await.map_err(|_| Gone)
    }
}
