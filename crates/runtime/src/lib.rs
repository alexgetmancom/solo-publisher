//! The process-level runtime every worker and adapter builds on: calls to other
//! providers over an injectable transport, ffmpeg and ffprobe, background loops
//! and their heartbeats, the worker doorbells, and the data directories.
//!
//! Single-threaded like the rest of the Studio: loops, rings and transports run
//! on the process's `LocalSet`, and their futures are not `Send`.

pub mod data_dirs;
pub mod ffmpeg;
pub mod git;
pub mod http;
pub mod job_heartbeat;
pub mod scheduler;
pub mod timeout;
pub mod worker_signal;
pub mod worker_state;
