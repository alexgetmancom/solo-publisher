//! Observability's own tables as the interface loops use them: alert delivery
//! over the event journal (`observability/alerts.ts`) and the claimable sync
//! cursors in `analytics_sync` (`observability/sync-state.ts`).

pub mod alerts;
pub mod sync_state;
