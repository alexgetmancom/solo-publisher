//! Delivery: the workers that take durable publishing state to the platforms
//! and the public site, and settle what came back (`apps/backend/src/delivery/*`
//! minus the adapters, which are `crates/adapters`).
//!
//! Every write a worker makes after an earlier check carries that check in its
//! `WHERE` — the lease, the status, the external id — and anything that may
//! have reached an audience is settled as ambiguous rather than sent again.
//! Delivery owns its transactions directly.

pub mod external_edits;
pub mod external_removals;
pub mod maintenance;
pub mod media_prepare;
pub mod publish_workflow;
pub mod reconciliation;
pub mod routing;
#[cfg(feature = "site")]
pub mod site_content_index;
#[cfg(feature = "site")]
pub mod site_index_now;
#[cfg(feature = "site")]
pub mod site_jobs;
#[cfg(feature = "site")]
pub mod site_media;
pub mod site_media_storage;
pub mod story_derivatives;
pub mod story_media;
#[cfg(feature = "video")]
pub mod video_retention;
#[cfg(feature = "video")]
pub mod video_worker;

use adapters::AdapterContext;
use db::rusqlite::Connection;
use db::{BackendDb, unsafe_db};
use domain::application::ports::Clock;
use domain::publishing::{Boundaries, Publishing};
use foundation::config::Config;

pub use domain::{Error, Result};

/// What every delivery loop body runs with: the database, the boundaries
/// publishing reports to, and the adapter context — one configuration
/// snapshot, one HTTP client and one clock for the whole cycle.
pub struct Delivery<'a> {
    pub db: &'a BackendDb,
    pub boundaries: Boundaries<'a>,
    pub adapters: AdapterContext,
}

impl<'a> Delivery<'a> {
    pub fn new(db: &'a BackendDb, boundaries: Boundaries<'a>, adapters: AdapterContext) -> Self {
        Self {
            db,
            boundaries,
            adapters,
        }
    }

    pub fn sqlite(&self) -> &'a Connection {
        unsafe_db(self.db)
    }

    pub fn clock(&self) -> &dyn Clock {
        &*self.adapters.clock
    }

    /// The publishing handle on this cycle's connection and clock.
    pub fn publishing(&self) -> Publishing<'_> {
        Publishing::new(self.sqlite(), self.clock(), self.boundaries)
    }

    pub fn config(&self) -> &Config {
        &self.adapters.config
    }

    /// `new Date().toISOString()` on this cycle's clock.
    pub fn now(&self) -> String {
        foundation::time::to_iso_string(self.clock().now())
    }

    /// `Date.now()` on this cycle's clock.
    pub fn now_ms(&self) -> i64 {
        self.clock().now().as_millisecond()
    }
}

/// `new Date(ms).toISOString()`.
pub(crate) fn iso_at(ms: i64) -> String {
    foundation::time::to_iso_string(jiff::Timestamp::from_millisecond(ms).expect("instant within year ±9999"))
}
