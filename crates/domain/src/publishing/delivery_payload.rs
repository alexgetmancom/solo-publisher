//! The payload of a publish job, which no one can write by hand.
//!
//! Continuation state a delivery adapter left on its job — the external ids it
//! has already published — lives under keys with the resume prefix. It is the
//! only thing standing between a retry and a second post in front of the
//! audience, and the reason a requeue may not rebuild a payload from the
//! source alone. So a job's payload is a [`DeliveryPayload`], which only the
//! constructors here produce, and each is a different answer to: has this
//! delivery already put something in front of an audience, and is this write
//! continuing it or replacing it?

use serde_json::{Map, Value};

use crate::{Error, Result};

const RESUME_KEY_PREFIX: &str = "_";

/// A job payload whose author has said what the delivery already published.
#[derive(Clone, Debug, PartialEq)]
pub struct DeliveryPayload(Map<String, Value>);

impl DeliveryPayload {
    pub fn fields(&self) -> &Map<String, Value> {
        &self.0
    }

    pub fn into_fields(self) -> Map<String, Value> {
        self.0
    }
}

/// Why a delivery is sent again from the beginning. There is no safe default:
/// continuing onto a deleted post and republishing a live one are the same
/// mistake pointing in opposite directions.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RestartReason {
    PostsRemoved,
    OperatorRepublish,
}

pub fn resume_state(payload: &Map<String, Value>) -> Map<String, Value> {
    crate::json::object_entries(payload)
        .filter(|(key, _)| key.starts_with(RESUME_KEY_PREFIX))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect()
}

pub fn has_resume_state(payload: &Map<String, Value>) -> bool {
    payload.keys().any(|key| key.starts_with(RESUME_KEY_PREFIX))
}

/// A delivery that has published nothing yet.
pub fn new_delivery_payload(fields: Map<String, Value>) -> DeliveryPayload {
    DeliveryPayload(fields)
}

/// A delivery being finished: whatever the previous job had already published
/// travels with it, so the adapter writes only the remainder.
pub fn continued_delivery_payload(
    previous: Option<&Map<String, Value>>,
    fields: Map<String, Value>,
) -> DeliveryPayload {
    let mut payload = fields;
    if let Some(previous) = previous {
        for (key, value) in resume_state(previous) {
            payload.insert(key, value);
        }
    }
    DeliveryPayload(payload)
}

/// A delivery sent again from the beginning, correct only when what it
/// published before is gone.
pub fn restarted_delivery_payload(fields: Map<String, Value>, reason: RestartReason) -> DeliveryPayload {
    let _ = reason;
    DeliveryPayload(fields)
}

/// A delivery mid-flight at the provider: the adapter's own progress, plus —
/// only once something has reached the audience — the ids it must never
/// publish again. Progress must not wear the resume prefix: a container being
/// processed has reached nobody.
pub fn deferred_delivery_payload(
    previous: &Map<String, Value>,
    progress_key: &str,
    progress: Value,
    published: Option<(&str, Value)>,
) -> Result<DeliveryPayload> {
    if progress_key.starts_with(RESUME_KEY_PREFIX) {
        return Err(Error::message(format!(
            "progress key {progress_key} claims to be resume state: it says nothing reached an audience"
        )));
    }
    if let Some((key, _)) = &published
        && !key.starts_with(RESUME_KEY_PREFIX)
    {
        return Err(Error::message(format!(
            "resume key {key} must carry the {RESUME_KEY_PREFIX} prefix"
        )));
    }
    let mut payload = previous.clone();
    payload.insert(progress_key.to_owned(), progress);
    if let Some((key, ids)) = published {
        payload.insert(key.to_owned(), ids);
    }
    Ok(DeliveryPayload(payload))
}

/// A delivery pointed at the ids it is to continue from, named rather than
/// inherited.
pub fn resumed_delivery_payload(previous: &Map<String, Value>, resume_key: &str, value: Value) -> DeliveryPayload {
    let mut payload = previous.clone();
    payload.insert(resume_key.to_owned(), value);
    DeliveryPayload(payload)
}
