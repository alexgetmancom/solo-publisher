//! Observability's own tables as the interface loops use them: alert delivery
//! over the event journal (`observability/alerts.ts`), the claimable sync
//! cursors in `analytics_sync` (`observability/sync-state.ts`), the credential
//! breaker (`observability/auth-circuit.ts`) and the readiness report
//! (`observability/capabilities.ts`) and runtime usage (`observability/usage.ts`).

pub mod alerts;
pub mod auth_circuit;
pub mod capabilities;
pub mod sync_state;
pub mod usage;
