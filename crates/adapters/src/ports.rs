//! The delivery boundary (`delivery/ports.ts`): what the publish workflow
//! asks of the adapter for one durable target. Publishing owns retry policy
//! and durable jobs; an adapter owns validation, preparation, the provider
//! calls and post-publish verification. It never sees Telegram, MCP or HTTP
//! request state.

use std::rc::Rc;
use std::sync::Arc;

use domain::application::ports::Clock;
use domain::publishing::errors::PublishResult;
use domain::publishing::queue::ClaimedPublishJob;
use foundation::config::Config;
use runtime::http::{Fut, HttpClient};
use serde_json::{Map, Value};

use crate::error::Result;

/// What every adapter call runs with: the configuration of this cycle, the
/// way out to the providers, and the clock delivery state is stamped with.
#[derive(Clone)]
pub struct AdapterContext {
    pub config: Arc<Config>,
    pub client: HttpClient,
    pub clock: Rc<dyn Clock>,
}

impl AdapterContext {
    pub(crate) fn now_ms(&self) -> i64 {
        self.clock.now().as_millisecond()
    }
}

/// An edit of a published post's text (`DeliveryEdit`'s input).
#[derive(Clone, Debug, PartialEq)]
pub struct EditRequest {
    pub external_id: String,
    pub text: String,
    /// The chat a Telegram message lives in, when not the channel.
    pub chat_id: Option<Value>,
    pub media_count: usize,
    pub external_id_count: usize,
}

/// What an edit came to (`{ ok, skipped?, error?, response? }`).
#[derive(Clone, Debug, PartialEq)]
pub struct EditOutcome {
    pub ok: bool,
    pub skipped: bool,
    pub error: Option<String>,
    pub response: Option<Value>,
}

impl EditOutcome {
    pub(crate) fn skipped(error: &str) -> Self {
        Self {
            ok: false,
            skipped: true,
            error: Some(error.to_owned()),
            response: None,
        }
    }

    /// The record TypeScript returned, for journals and goldens.
    pub fn to_json(&self) -> Map<String, Value> {
        let mut record = Map::new();
        record.insert("ok".into(), self.ok.into());
        if self.skipped {
            record.insert("skipped".into(), true.into());
        }
        if let Some(error) = &self.error {
            record.insert("error".into(), error.clone().into());
        }
        if let Some(response) = &self.response {
            record.insert("response".into(), response.clone());
        }
        record
    }
}

/// One durable target's adapter (`DeliveryAdapter`). `edit` and `remove` are
/// `None` for a target with no such port.
pub trait SocialAdapter {
    fn validate(&self, job: &ClaimedPublishJob) -> Result<()>;
    fn prepare(&self, job: ClaimedPublishJob) -> Fut<'_, Result<ClaimedPublishJob>>;
    /// The provider mutation. An answer lost after the provider may have
    /// acted is [`crate::AdapterError::Ambiguous`].
    fn publish<'a>(&'a self, job: &'a ClaimedPublishJob) -> Fut<'a, Result<PublishResult>>;
    /// Never fails: a verification that cannot be made is recorded on the
    /// result as `verification.status = "unavailable"`.
    fn verify<'a>(&'a self, job: &'a ClaimedPublishJob, result: PublishResult) -> Fut<'a, PublishResult>;
    fn edit<'a>(&'a self, _edit: &'a EditRequest) -> Option<Fut<'a, Result<EditOutcome>>> {
        None
    }
    fn remove<'a>(&'a self, _external_id: &'a str) -> Option<Fut<'a, Result<Value>>> {
        None
    }
}

/// The preparation a target's job goes through before it is published
/// (`createPlatformAdapters`' `prepare`). Telegram skips it.
pub trait PrepareJob {
    fn prepare<'a>(&'a self, job: ClaimedPublishJob, config: &'a Arc<Config>) -> Fut<'a, Result<ClaimedPublishJob>>;
}

/// No preparation: the job as it was claimed.
pub struct Unprepared;

impl PrepareJob for Unprepared {
    fn prepare<'a>(&'a self, job: ClaimedPublishJob, _: &'a Arc<Config>) -> Fut<'a, Result<ClaimedPublishJob>> {
        Box::pin(async move { Ok(job) })
    }
}

/// The adapters by durable target (`DeliveryPorts`), in the order TypeScript
/// registered them.
pub struct DeliveryPorts(pub(crate) Vec<(String, Box<dyn SocialAdapter>)>);

impl DeliveryPorts {
    pub fn get(&self, target: &str) -> Option<&dyn SocialAdapter> {
        self.0
            .iter()
            .find(|(name, _)| name == target)
            .map(|(_, adapter)| adapter.as_ref())
    }

    pub fn targets(&self) -> impl Iterator<Item = &str> {
        self.0.iter().map(|(name, _)| name.as_str())
    }
}
