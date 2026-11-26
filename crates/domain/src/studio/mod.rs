//! Studio: the one application boundary every interface drives. Telegram, MCP
//! and the operations CLI receive the same services; only rendering and
//! transport live outside it.
//!
//! Studio goes through the persistence ports (`ApplicationPorts`) and the
//! publishing module; it writes no SQL of its own. What it reaches beyond
//! them — reminders, Story derivatives, credential readiness, connection
//! links, the YouTube and Zernio adapters — is a trait in [`boundaries`],
//! implemented by the area that owns it.

pub mod access;
pub mod boundaries;
pub mod config;
pub mod projections;
pub mod services;
pub mod video_fsm;

use std::future::Future;
use std::time::Instant;

use db::rusqlite::Connection;
use foundation::config::Config;
use jiff::Timestamp;

use crate::Result;
use crate::application::ports::ApplicationPorts;
use crate::publishing::Publishing;
use boundaries::StudioBoundaries;

/// What every Studio service runs on: the publishing handle (connection,
/// clock and publishing's boundaries), the host configuration, and Studio's
/// own boundaries.
#[derive(Clone, Copy)]
pub struct Studio<'a> {
    pub publishing: Publishing<'a>,
    pub config: &'a Config,
    pub boundaries: StudioBoundaries<'a>,
}

impl<'a> Studio<'a> {
    pub fn new(publishing: Publishing<'a>, config: &'a Config, boundaries: StudioBoundaries<'a>) -> Self {
        Self {
            publishing,
            config,
            boundaries,
        }
    }

    pub(crate) fn ports(&self) -> ApplicationPorts<'a> {
        ApplicationPorts::within(self.publishing.sqlite, self.publishing.clock)
    }

    /// The connection boundary implementations work on; Studio itself only
    /// hands it on.
    pub(crate) fn sqlite(&self) -> &'a Connection {
        self.publishing.sqlite
    }

    pub(crate) fn now(&self) -> Timestamp {
        self.publishing.clock.now()
    }

    pub(crate) fn now_iso(&self) -> String {
        foundation::time::to_iso_string(self.now())
    }

    pub(crate) fn accessible_actor_ids(&self, actor_id: i64) -> Vec<i64> {
        access::accessible_studio_actor_ids(self.config, actor_id)
    }

    pub(crate) fn can_access(&self, actor_id: i64, owner_id: i64) -> bool {
        access::can_access_studio_owner(self.config, actor_id, owner_id)
    }

    /// `trackUsageSync`: the call is counted, successful or not.
    pub(crate) fn track<T>(&self, feature_key: &str, operation: impl FnOnce() -> Result<T>) -> Result<T> {
        let started = Instant::now();
        let result = operation();
        self.record_usage(feature_key, result.is_ok(), started);
        result
    }

    /// `trackUsageAsync`.
    pub(crate) async fn track_async<T>(
        &self,
        feature_key: &str,
        operation: impl Future<Output = Result<T>>,
    ) -> Result<T> {
        let started = Instant::now();
        let result = operation.await;
        self.record_usage(feature_key, result.is_ok(), started);
        result
    }

    fn record_usage(&self, feature_key: &str, success: bool, started: Instant) {
        self.publishing.boundaries.usage.record(
            self.sqlite(),
            feature_key,
            success,
            started.elapsed().as_millis() as u64,
        );
    }
}
