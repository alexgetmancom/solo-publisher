//! The callback boundary.
//!
//! A tap is acknowledged the moment it arrives, ahead of the per-chat queue;
//! the acknowledgement is the only real answer it gets, and every later answer
//! with a text becomes a chat message. A redelivered callback id is answered
//! and dropped; an older tap on the same supersedable button of the same
//! message, still waiting its turn, is dropped for the newer one.

use std::cell::Cell;
use std::rc::Rc;
use std::task::{Context, Poll, Waker};
use std::time::Instant;

use foundation::logger::{LogLevel, log};
use indexmap::IndexMap;
use serde_json::json;
use tokio::task::JoinHandle;

use crate::Fut;
use crate::callback::{callback_route, supersedable_screen};
use crate::context::Ctx;
use crate::effects::reply_safely;
use crate::error_text::{callback_toast, describe_error};
use crate::tap;

const DEDUPLICATION_TTL_MS: i64 = 15 * 60_000;
const DEDUPLICATION_LIMIT: usize = 10_000;

/// Process-local: suppresses Telegram's redelivery within one process, which
/// is all it is for; durable mutations stay idempotent on their own.
#[derive(Default)]
pub(crate) struct BoundaryState {
    seen: IndexMap<String, i64>,
    claims: std::collections::HashMap<String, u64>,
    taken: u64,
}

pub(crate) struct Claim {
    key: String,
    sequence: u64,
}

/// One tap's place, recorded at arrival.
pub(crate) struct TapState {
    received_at: Instant,
    duplicate: bool,
    acknowledgement: Option<JoinHandle<()>>,
    acknowledged_at: Rc<Cell<Option<Instant>>>,
    claim: Option<Claim>,
}

/// Starts `future` now, as a JavaScript promise starts: it runs until it first
/// waits before this returns, then continues as its own task.
pub(crate) fn start(ctx: &Ctx, future: Fut<'static, ()>) -> JoinHandle<()> {
    let mut future = match tap::current() {
        Some(account) => Box::pin(tap::scope(account, future)) as Fut<'static, ()>,
        None => future,
    };
    let mut context = Context::from_waker(Waker::noop());
    if future.as_mut().poll(&mut context) == Poll::Ready(()) {
        return ctx.bot.spawn(async {});
    }
    ctx.bot.spawn(future)
}

fn claim_callback_query(state: &mut BoundaryState, id: &str, now: i64) -> bool {
    state.seen.retain(|_, seen_at| now - *seen_at <= DEDUPLICATION_TTL_MS);
    if state.seen.contains_key(id) {
        return false;
    }
    state.seen.insert(id.to_owned(), now);
    while state.seen.len() > DEDUPLICATION_LIMIT {
        state.seen.shift_remove_index(0);
    }
    true
}

/// `acknowledgeCallback`.
pub(crate) fn acknowledge(ctx: &Rc<Ctx>) {
    let Some(query) = ctx.update.callback_query.as_ref() else {
        return;
    };
    let received_at = Instant::now();
    let now = ctx.now().as_millisecond();
    let fresh = claim_callback_query(&mut ctx.bot.boundary().borrow_mut(), &query.id, now);
    let acknowledged_at = Rc::new(Cell::new(None));
    if !fresh {
        let answering = Rc::clone(ctx);
        let acknowledgement = start(
            ctx,
            Box::pin(async move {
                if let Err(error) = answering.answer_callback_query_now(None, false).await {
                    log(
                        LogLevel::Warn,
                        "Failed to answer Telegram callback query",
                        Some(json!({"error": crate::effects::error_js_string(&*error)})),
                    );
                }
            }),
        );
        *ctx.tap.borrow_mut() = Some(TapState {
            received_at,
            duplicate: true,
            acknowledgement: Some(acknowledgement),
            acknowledged_at,
            claim: None,
        });
        return;
    }
    ctx.redirect_answers.set(true);
    let answering = Rc::clone(ctx);
    let settled = Rc::clone(&acknowledged_at);
    let acknowledgement = start(
        ctx,
        Box::pin(async move {
            if let Err(error) = answering.answer_callback_query_now(None, false).await {
                log(
                    LogLevel::Warn,
                    "Failed to acknowledge Telegram callback query",
                    Some(json!({"error": crate::effects::error_js_string(&*error)})),
                );
            }
            settled.set(Some(Instant::now()));
        }),
    );
    let claim = claim_supersession(ctx);
    *ctx.tap.borrow_mut() = Some(TapState {
        received_at,
        duplicate: false,
        acknowledgement: Some(acknowledgement),
        acknowledged_at,
        claim,
    });
}

fn claim_supersession(ctx: &Ctx) -> Option<Claim> {
    let data = ctx.callback_data()?;
    let message_id = ctx.update.callback_message_id()?;
    let chat_id = ctx.chat_id()?;
    let screen = supersedable_screen(data)?;
    let mut state = ctx.bot.boundary().borrow_mut();
    state.taken += 1;
    let claim = Claim {
        key: format!("{chat_id}:{message_id}:{}", screen.name()),
        sequence: state.taken,
    };
    state.claims.insert(claim.key.clone(), claim.sequence);
    Some(claim)
}

async fn settle(acknowledgement: Option<JoinHandle<()>>) {
    if let Some(acknowledgement) = acknowledgement {
        // A panicked acknowledgement has already been reported by its task.
        let _ = acknowledgement.await;
    }
}

fn ms(from: Instant, to: Instant) -> i64 {
    to.saturating_duration_since(from).as_millis() as i64
}

/// `runCallbackBoundary`: runs `next` for a tap that is neither a duplicate
/// nor superseded; a failure becomes a chat message.
pub(crate) async fn run(ctx: &Ctx, next: Fut<'_, crate::Result<()>>) -> crate::Result<()> {
    let state = ctx.tap.borrow_mut().take().unwrap_or_else(|| TapState {
        received_at: Instant::now(),
        duplicate: false,
        acknowledgement: None,
        acknowledged_at: Rc::new(Cell::new(None)),
        claim: None,
    });
    let started_at = Instant::now();
    let route = callback_route(ctx.callback_data());
    if state.duplicate {
        tap::record_answered();
        settle(state.acknowledgement).await;
        return Ok(());
    }
    let superseded = state
        .claim
        .as_ref()
        .is_some_and(|claim| ctx.bot.boundary().borrow().claims.get(&claim.key) != Some(&claim.sequence));
    if superseded {
        tap::record_answered();
        settle(state.acknowledgement).await;
        log(
            LogLevel::Info,
            "Telegram callback superseded",
            Some(json!({"callback": route, "queuedMs": ms(state.received_at, started_at)})),
        );
        return Ok(());
    }
    let handler_started_at = Instant::now();
    if let Err(error) = next.await {
        reply_safely(ctx, &callback_toast(&describe_error(&*error))).await;
    }
    let handler_finished_at = Instant::now();
    tap::record_answered();
    settle(state.acknowledgement).await;
    if let Some(claim) = &state.claim {
        let mut boundary = ctx.bot.boundary().borrow_mut();
        if boundary.claims.get(&claim.key) == Some(&claim.sequence) {
            boundary.claims.remove(&claim.key);
        }
    }
    let acknowledged_at = state.acknowledged_at.get().unwrap_or(state.received_at);
    let measurement = tap::current();
    let measurement = measurement.as_ref().map(|tap| tap.borrow());
    let mut details = json!({
        "callback": route,
        "acknowledgeMs": ms(state.received_at, acknowledged_at),
        "queuedMs": ms(state.received_at, started_at),
        "handlerMs": ms(handler_started_at, handler_finished_at),
        "apiSumMs": measurement.as_ref().map_or(0, |tap| tap.api_sum_ms.round() as i64),
        "apiCalls": measurement.as_ref().map_or(0, |tap| tap.api_calls),
    });
    if let Some(methods) = measurement.as_ref().and_then(|tap| tap.api_methods_json()) {
        details["apiMethods"] = methods;
    }
    details["unchangedEdits"] = measurement.as_ref().map_or(0, |tap| tap.unchanged_edits).into();
    details["providerMs"] = measurement
        .as_ref()
        .map_or(0, |tap| tap.provider_ms.round() as i64)
        .into();
    details["providerCalls"] = measurement.as_ref().map_or(0, |tap| tap.provider_calls).into();
    details["answerMs"] = ms(state.received_at, handler_finished_at).into();
    log(LogLevel::Info, "Telegram callback timing", Some(details));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn callback_ids_are_remembered_for_fifteen_minutes() {
        let mut state = BoundaryState::default();
        assert!(claim_callback_query(&mut state, "a", 0));
        assert!(!claim_callback_query(&mut state, "a", DEDUPLICATION_TTL_MS));
        assert!(claim_callback_query(&mut state, "a", 2 * DEDUPLICATION_TTL_MS + 1));
    }
}
