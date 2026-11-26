//! Everything that speaks to a provider outside the Studio: the platform
//! adapters delivery publishes through, the channels a Studio connects and the
//! credentials behind them, and the provider helpers both of those and the bot
//! share. Every request goes through `runtime::http::HttpClient`.

pub mod adapters;
pub mod channels;
pub mod external;
