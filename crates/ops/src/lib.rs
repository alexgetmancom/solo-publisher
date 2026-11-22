//! The operations registry and its projections: one table of operations, dispatched by the
//! `ops` CLI and listed as `ops_*` MCP tools beside the hand-written
//! `studio_*` tools.

pub mod cli;
pub mod context;
pub mod guide;
pub mod handlers;
pub mod host;
pub mod mcp;
pub mod registry;
pub mod schema;
