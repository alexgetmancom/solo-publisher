//! Publishing: a draft becomes a publication plan, the plan becomes durable
//! delivery jobs, and the queue settles each job under the lease that earned
//! it. Retry, requeue, cancellation and abandonment are the only ways a job
//! changes hands, and each carries the condition it was decided on in the
//! `WHERE` of the write it guards. Videos follow the same rules through their
//! own targets and jobs.
//!
//! Publishing owns its transactions directly. What it reaches beyond its own
//! tables — the worker doorbell, the credential breaker, runtime usage,
//! generated Story cards, the video worker's completion notice, the video
//! provider and the media prober — is a trait here, implemented by the area
//! that owns it.

pub mod abandon;
pub mod article_publish;
pub mod article_status;
pub mod boundaries;
pub mod cancellation;
pub mod chain_plan;
pub mod delivery_payload;
pub mod draft_lifecycle;
pub mod errors;
pub mod extra_delivery;
pub mod job_policy;
pub mod media_policy;
pub mod payload;
pub mod platform_profiles;
pub mod preflight;
pub mod publication_owner;
pub mod publication_plan;
pub mod publication_source;
pub mod publication_status;
pub mod publication_workflow;
pub mod publication_writer;
pub mod queue;
pub mod queue_state;
pub mod requeue;
pub mod schedule;
pub mod scheduled_draft_mutation;
pub mod source_store;
pub mod state;
pub mod targets;
pub mod threads_text;
pub mod video_assets;
pub mod video_audio;
pub mod video_data;
pub mod video_fence;
pub mod video_metadata_limits;
pub mod video_service;
pub mod video_settle;
pub mod video_types;

use db::rusqlite::Connection;

pub use boundaries::Boundaries;

use crate::application::ports::Clock;

/// One connection, the clock every write is stamped with, and the boundaries
/// publishing reports to. Over a transaction's connection, every write
/// publishing makes joins that transaction (its own become savepoints).
#[derive(Clone, Copy)]
pub struct Publishing<'a> {
    pub sqlite: &'a Connection,
    pub clock: &'a dyn Clock,
    pub boundaries: Boundaries<'a>,
}

impl<'a> Publishing<'a> {
    pub fn new(sqlite: &'a Connection, clock: &'a dyn Clock, boundaries: Boundaries<'a>) -> Self {
        Self {
            sqlite,
            clock,
            boundaries,
        }
    }

    /// The clock's instant as the ISO text every column stores.
    pub(crate) fn now(&self) -> String {
        foundation::time::to_iso_string(self.clock.now())
    }

    pub(crate) fn now_ms(&self) -> i64 {
        self.clock.now().as_millisecond()
    }
}
