//! Observability's own tables as the interface loops use them: alert delivery
//! over the event journal, the claimable sync cursors in `analytics_sync`,
//! the credential breaker, the readiness report, runtime usage,
//! and the database side of the observability probes: credential checks,
//! publication failures, runtime health, and stored-date integrity. The probes
//! that read the process or call a provider live in the `channels` crate.

pub mod alerts;
pub mod auth_circuit;
pub mod capabilities;
pub mod credentials;
pub mod dates;
pub mod failures;
pub mod runtime_health;
pub mod sync_state;
pub mod usage;
