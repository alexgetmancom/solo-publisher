//! Background loops: a task on an interval, never two cycles of it at once, and
//! a wake that runs it now. Loops live on the process's `LocalSet`, as
//! everything else does.

use std::cell::{Cell, RefCell};
use std::fmt::Display;
use std::rc::Rc;
use std::time::Duration;

use foundation::logger::{LogLevel, log};
use serde_json::json;
use tokio::task::JoinHandle;
use tokio::time::{Instant, MissedTickBehavior};

use crate::http::Fut;

/// A lifecycle hook; an `Err` is logged and does not stop the loop.
pub type Hook = Box<dyn Fn() -> Result<(), String>>;
/// Told how a cycle ended: `None`, or the cycle's error message.
pub type FinishHook = Box<dyn Fn(Option<&str>) -> Result<(), String>>;

#[derive(Default)]
pub struct LoopHooks {
    /// Before each cycle.
    pub on_start: Option<Hook>,
    /// Every `heartbeat_interval`, whether a cycle is running or not.
    pub on_heartbeat: Option<Hook>,
    pub heartbeat_interval: Option<Duration>,
    pub on_finish: Option<FinishHook>,
}

type Task = Box<dyn Fn() -> Fut<'static, Result<(), String>>>;

struct LoopState {
    name: String,
    task: Task,
    hooks: LoopHooks,
    running: Cell<bool>,
    /// A wake arrived mid-cycle: the running cycle may already have read the
    /// table, so another one follows it.
    again: Cell<bool>,
    stopped: Cell<bool>,
    /// The cycle task in flight; `stop` waits for it.
    completion: RefCell<Option<JoinHandle<()>>>,
}

pub struct ScheduledLoop {
    state: Rc<LoopState>,
    timers: Vec<JoinHandle<()>>,
}

impl ScheduledLoop {
    pub fn name(&self) -> &str {
        &self.state.name
    }

    /// Runs the task now instead of at the next tick. A wake arriving
    /// mid-cycle is not dropped: another cycle follows the running one.
    pub fn wake(&self) {
        run(&self.state);
    }

    /// The wake as a value, for the worker doorbells.
    pub fn waker(&self) -> Rc<dyn Fn()> {
        let state = Rc::clone(&self.state);
        Rc::new(move || run(&state))
    }

    /// No further cycles; waits for the one in flight.
    pub async fn stop(&self) {
        self.state.stopped.set(true);
        for timer in &self.timers {
            timer.abort();
        }
        let completion = self.state.completion.borrow_mut().take();
        if let Some(completion) = completion {
            let _ = completion.await;
        }
    }
}

/// Starts a named loop on an interval: the first cycle starts now.
/// Must be called inside the process's `LocalSet`.
pub fn start_loop<F, T, E>(name: &str, interval: Duration, task: F, hooks: LoopHooks) -> ScheduledLoop
where
    F: Fn() -> T + 'static,
    T: Future<Output = Result<(), E>> + 'static,
    E: Display,
{
    let task: Task = Box::new(move || {
        let cycle = task();
        Box::pin(async move { cycle.await.map_err(|error| error.to_string()) })
    });
    let state = Rc::new(LoopState {
        name: name.to_owned(),
        task,
        hooks,
        running: Cell::new(false),
        again: Cell::new(false),
        stopped: Cell::new(false),
        completion: RefCell::new(None),
    });
    let mut timers = vec![every(interval, {
        let state = Rc::clone(&state);
        move || run(&state)
    })];
    if let (Some(_), Some(heartbeat)) = (&state.hooks.on_heartbeat, state.hooks.heartbeat_interval) {
        timers.push(every(heartbeat, {
            let state = Rc::clone(&state);
            move || notify(&state, state.hooks.on_heartbeat.as_ref().map(|hook| hook()))
        }));
    }
    run(&state);
    ScheduledLoop { state, timers }
}

/// A tick every `period`, the first one a period from now.
fn every(period: Duration, tick: impl Fn() + 'static) -> JoinHandle<()> {
    let period = period.max(Duration::from_millis(1));
    tokio::task::spawn_local(async move {
        let mut ticker = tokio::time::interval_at(Instant::now() + period, period);
        ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);
        loop {
            ticker.tick().await;
            tick();
        }
    })
}

fn notify(state: &LoopState, outcome: Option<Result<(), String>>) {
    if let Some(Err(error)) = outcome {
        log(
            LogLevel::Warn,
            &format!("{} lifecycle hook failed", state.name),
            Some(json!({"error": error})),
        );
    }
}

fn run(state: &Rc<LoopState>) {
    if state.stopped.get() {
        return;
    }
    if state.running.get() {
        state.again.set(true);
        return;
    }
    begin(state);
    let cycles = tokio::task::spawn_local(cycles(Rc::clone(state)));
    *state.completion.borrow_mut() = Some(cycles);
}

fn begin(state: &LoopState) {
    state.running.set(true);
    notify(state, state.hooks.on_start.as_ref().map(|hook| hook()));
}

/// One cycle, and the ones wakes asked for while it ran.
async fn cycles(state: Rc<LoopState>) {
    loop {
        // Spawned so a panicking task fails its cycle instead of leaving the
        // loop marked running forever.
        let failure = match tokio::task::spawn_local((state.task)()).await {
            Ok(Ok(())) => None,
            Ok(Err(error)) => Some(error),
            Err(join) => Some(panic_message(join)),
        };
        if let Some(error) = &failure {
            log(
                LogLevel::Error,
                &format!("{} loop failed", state.name),
                Some(json!({"error": error})),
            );
        }
        notify(
            &state,
            state.hooks.on_finish.as_ref().map(|hook| hook(failure.as_deref())),
        );
        state.running.set(false);
        if !state.again.replace(false) || state.stopped.get() {
            return;
        }
        begin(&state);
    }
}

fn panic_message(join: tokio::task::JoinError) -> String {
    match join.try_into_panic() {
        Ok(payload) => payload
            .downcast_ref::<&str>()
            .map(|text| (*text).to_owned())
            .or_else(|| payload.downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "the task panicked".into()),
        Err(join) => join.to_string(),
    }
}
