//! The platform adapters (the adapter ports, the social platforms, Zernio, the
//! remote media processor and the provider calls of the video publishers): one
//! module per platform, every request through `runtime::http::HttpClient` so a
//! test transport sees exactly what production sends.
//!
//! The delivery workflow builds against [`SocialAdapter`]; what reached an
//! audience and lost its answer comes back as [`AdapterError::Ambiguous`].

pub mod discord;
pub mod error;
pub mod instagram;
mod js;
pub mod multipart;
pub mod payload;
pub mod platform_adapters;
pub mod ports;
pub mod providers;
pub mod remote_media_processor;
pub mod social_ports;
pub mod telegram;
pub mod telegram_stories;
pub mod threads;
pub mod video_publishers;
pub mod x;
pub mod x_content_state;
pub mod zernio;

pub use error::{AdapterError, Result};
pub use platform_adapters::{Route, TargetRouting, create_platform_adapters};
pub use ports::{AdapterContext, DeliveryPorts, EditOutcome, EditRequest, PrepareJob, SocialAdapter, Unprepared};
pub use providers::ProviderCalls;
pub use social_ports::{MediaPreparation, PreparedMedia};
pub use telegram_stories::StoriesClient;
