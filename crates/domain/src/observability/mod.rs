//! Observability's own tables as the interface loops use them: alert delivery
//! over the event journal (`observability/alerts.ts`), the claimable sync
//! cursors in `analytics_sync` (`observability/sync-state.ts`), the credential
//! breaker (`observability/auth-circuit.ts`) and the readiness report
//! (`observability/capabilities.ts`), runtime usage (`observability/usage.ts`),
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
