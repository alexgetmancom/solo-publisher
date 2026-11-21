//! The shared application vocabulary every publication service (posts, videos)
//! implements directly, so the bot drives either through one contract.

use std::future::Future;

use content::Locale;
use jiff::Timestamp;

use super::conversation_flow::PublicationKind;
use crate::Result;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PublicationScheduleAxis {
    Locale,
    Target,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PublicationCapabilities {
    pub schedule_axis: PublicationScheduleAxis,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PublicationSchedule {
    /// One instant per schedule key (a locale or a target, by the axis), in
    /// the order the caller gave them.
    pub values: Vec<(String, Timestamp)>,
    pub allow_past: bool,
    pub immediate_key: Option<String>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PublicationRetrySummary {
    pub requeued: u32,
    pub already_queued: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PublicationView {
    pub id: i64,
    pub status: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Issue {
    pub target: Option<String>,
    pub locale: Option<Locale>,
    pub code: Option<String>,
    pub kind: Option<String>,
    pub label: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PreviewModel {
    pub view: PublicationView,
    pub issues: Vec<Issue>,
}

pub trait PublicationPipeline {
    fn kind(&self) -> PublicationKind;
    fn capabilities(&self) -> PublicationCapabilities;
    fn get(&self, actor_id: i64, publication_id: i64) -> Result<PublicationView>;
    fn preview(&self, actor_id: i64, publication_id: i64) -> Result<PreviewModel>;
    /// Asynchronous because a video asks its platforms what they accept.
    fn validate(&self, actor_id: i64, publication_id: i64) -> impl Future<Output = Result<Vec<Issue>>>;
    fn schedule(&self, actor_id: i64, publication_id: i64, schedule: &PublicationSchedule) -> Result<()>;
    fn publish(&self, actor_id: i64, publication_id: i64) -> Result<()>;
    fn cancel(&self, actor_id: i64, publication_id: i64) -> Result<()>;
    /// Asynchronous because a provider route asks the provider what became of
    /// the publication before it repeats it; the post path answers from its
    /// own tables.
    fn retry_target(
        &self,
        actor_id: i64,
        publication_id: i64,
        target: &str,
    ) -> impl Future<Output = Result<PublicationRetrySummary>>;
    fn remove_target(&self, actor_id: i64, publication_id: i64, target: &str) -> Result<()>;
    fn toggle_target(&self, actor_id: i64, publication_id: i64, target: &str) -> Result<()>;
    fn slot_time(&self, actor_id: i64, clock: &str) -> Result<Timestamp>;
}
