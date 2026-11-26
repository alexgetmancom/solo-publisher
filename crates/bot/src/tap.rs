//! What one update spent waiting on somebody else.
//!
//! Updates are handled concurrently, so the account travels with the update's
//! task rather than in a global; work outside an update (worker ticks) runs
//! with no account and is counted by nobody.

use std::cell::RefCell;
use std::rc::Rc;
use std::time::Instant;

use serde_json::{Map, Value, json};

#[derive(Debug)]
pub struct TapMeasurement {
    pub api_sum_ms: f64,
    pub api_calls: u64,
    pub provider_ms: f64,
    pub provider_calls: u64,
    /// Bot API cost by method name, in call order.
    pub api_methods: Vec<(String, f64, u64)>,
    /// When the operator had their answer; the first report wins.
    pub answered_at: Option<Instant>,
    pub unchanged_edits: u64,
}

impl TapMeasurement {
    fn new() -> Self {
        Self {
            api_sum_ms: 0.0,
            api_calls: 0,
            provider_ms: 0.0,
            provider_calls: 0,
            api_methods: Vec::new(),
            answered_at: None,
            unchanged_edits: 0,
        }
    }

    /// `tapApiMethods`: rounded, and absent when the update made no call.
    pub fn api_methods_json(&self) -> Option<Value> {
        if self.api_methods.is_empty() {
            return None;
        }
        let mut methods = Map::new();
        for (method, ms, calls) in &self.api_methods {
            methods.insert(method.clone(), json!({"ms": ms.round() as i64, "calls": calls}));
        }
        Some(Value::Object(methods))
    }
}

pub type Tap = Rc<RefCell<TapMeasurement>>;

tokio::task_local! {
    static CURRENT: Tap;
}

pub fn new_tap() -> Tap {
    Rc::new(RefCell::new(TapMeasurement::new()))
}

/// Runs `future` with `tap` as its account.
pub async fn scope<F: Future>(tap: Tap, future: F) -> F::Output {
    CURRENT.scope(tap, future).await
}

/// The account of the update being handled, if any.
pub fn current() -> Option<Tap> {
    CURRENT.try_with(Rc::clone).ok()
}

fn with(change: impl FnOnce(&mut TapMeasurement)) {
    let _ = CURRENT.try_with(|tap| change(&mut tap.borrow_mut()));
}

/// One finished Bot API call.
pub fn record_api_call(method: &str, duration_ms: f64) {
    with(|tap| {
        tap.api_sum_ms += duration_ms;
        tap.api_calls += 1;
        match tap.api_methods.iter_mut().find(|(name, _, _)| name == method) {
            Some((_, ms, calls)) => {
                *ms += duration_ms;
                *calls += 1;
            }
            None => tap.api_methods.push((method.to_owned(), duration_ms, 1)),
        }
    });
}

/// The operator has their answer.
pub fn record_answered() {
    with(|tap| {
        tap.answered_at.get_or_insert_with(Instant::now);
    });
}

/// One screen edit the guard answered from memory.
pub fn record_unchanged_edit() {
    with(|tap| tap.unchanged_edits += 1);
}

/// One finished call to another provider (translation, a platform, media).
pub fn record_provider_call(duration_ms: f64) {
    with(|tap| {
        tap.provider_ms += duration_ms;
        tap.provider_calls += 1;
    });
}

/// The body of a provider call already counted, added to that same call.
pub fn record_provider_body_read(duration_ms: f64) {
    with(|tap| tap.provider_ms += duration_ms);
}
