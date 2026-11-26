//! The channels a Studio publishes through and the credentials behind them
//! with the observability probes that need the process or a provider (the
//! cycle, memory, runtime health and token health). The database-only probes live in
//! `domain::observability`; the registry reads publishing needs live in
//! `domain::channels`, and channel administration in
//! `domain::studio::services::channels`.
//!
//! Credentials that change while the process runs are written to the live
//! [`SharedConfig`](foundation::config::SharedConfig) as one swap per change,
//! rather than mutated in place.

pub mod api_keys;
pub mod connect;
pub mod credentials;
mod encode;
pub mod entropy;
pub mod error;
pub mod loops;
pub mod meta;
pub mod oauth_routes;
pub mod observability;
pub mod registry;
pub mod token_store;
pub mod x;
pub mod youtube;
pub mod zernio;

pub use error::{Error, Result};
