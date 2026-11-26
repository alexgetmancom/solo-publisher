//! `OperationContext`: what an operation runs on. Config and the database are
//! resolved on demand — `restore` operates on the file itself and must not
//! have it opened underneath it, and `guide` runs when there is no usable
//! database at all — through the [`Surface`] that is running it (the CLI
//! process, or the Studio server for MCP).

use std::fmt;
use std::future::Future;
use std::io;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;

use db::BackendDb;
use db::rusqlite::Connection;
use domain::application::ports::Clock;
use domain::publishing::boundaries::UsageMeter;
use domain::studio::Studio;
use domain::studio::services::{StudioServices, create_studio_services};
use foundation::config::Config;
use providers::adapters::ProviderCalls;
use runtime::http::HttpClient;
use serde_json::{Map, Value};

pub type Fut<'a, T> = Pin<Box<dyn Future<Output = T> + 'a>>;

/// Why an operation did not answer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OpError {
    /// `OperationInputError`: what the caller wrote is wrong (MCP `-32602`).
    Input(String),
    /// The operation failed (a thrown `Error`; MCP `-32603`).
    Failed(String),
}

impl OpError {
    pub fn failed(message: impl Into<String>) -> Self {
        Self::Failed(message.into())
    }

    pub fn message(&self) -> &str {
        match self {
            Self::Input(message) | Self::Failed(message) => message,
        }
    }
}

impl fmt::Display for OpError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.message())
    }
}

impl std::error::Error for OpError {}

impl From<domain::Error> for OpError {
    fn from(error: domain::Error) -> Self {
        Self::Failed(error.to_string())
    }
}

impl From<db::Error> for OpError {
    fn from(error: db::Error) -> Self {
        Self::Failed(error.to_string())
    }
}

impl From<db::rusqlite::Error> for OpError {
    fn from(error: db::rusqlite::Error) -> Self {
        Self::Failed(error.to_string())
    }
}

impl From<io::Error> for OpError {
    fn from(error: io::Error) -> Self {
        Self::Failed(error.to_string())
    }
}

impl From<serde_json::Error> for OpError {
    fn from(error: serde_json::Error) -> Self {
        Self::Failed(error.to_string())
    }
}

impl From<foundation::errors::StudioError> for OpError {
    fn from(error: foundation::errors::StudioError) -> Self {
        Self::Failed(error.to_string())
    }
}

pub type OpResult = Result<Value, OpError>;

/// Serializes a result the way `JSON.stringify` would see it.
pub fn to_value(value: impl serde::Serialize) -> OpResult {
    serde_json::to_value(value).map(js_numbers).map_err(OpError::from)
}

/// Every number as JavaScript prints it: a double with no fraction is written
/// without one (`1080`, not serde's `1080.0`), and `-0` is `0`.
pub fn js_numbers(value: Value) -> Value {
    match value {
        Value::Number(number) if number.is_f64() => {
            let float = number.as_f64().unwrap_or_default();
            foundation::js::json_number(if float == 0.0 { 0.0 } else { float })
        }
        Value::Array(items) => Value::Array(items.into_iter().map(js_numbers).collect()),
        Value::Object(map) => Value::Object(map.into_iter().map(|(key, value)| (key, js_numbers(value))).collect()),
        other => other,
    }
}

/// The process (or request) an operation runs inside.
pub trait Surface {
    /// The database, opened on first use.
    fn db(&self) -> Result<&BackendDb, OpError>;
    /// The complete runtime configuration (`loadRuntimeConfig`): .env, the
    /// Studio's own settings and the stored credentials.
    fn config(&self) -> Result<Arc<Config>, OpError>;
    /// Studio over the surface's database, its clock and its boundaries.
    fn studio<'a>(&'a self, config: &'a Config) -> Result<Studio<'a>, OpError>;
    /// The adapters Studio waits on.
    fn adapters(&self) -> Result<&ProviderCalls, OpError>;
    /// Where `recordUsage` buffers.
    fn usage(&self) -> &dyn UsageMeter;
}

/// The terminal a CLI run is attached to. Only operations off the agent
/// surface reach it; an MCP call has none.
pub trait Terminal {
    /// Bytes to standard output, unformatted (`process.stdout.write`).
    fn write(&self, bytes: &[u8]) -> io::Result<()>;
    /// A line to standard output (`console.log`).
    fn print_line(&self, text: &str) -> io::Result<()> {
        self.write(format!("{text}\n").as_bytes())
    }
    /// `process.stdout.isTTY`.
    fn stdout_is_tty(&self) -> bool;
    /// Standard output for a child process (`stdio: "inherit"`).
    fn child_stdout(&self) -> io::Result<std::process::Stdio>;
    /// All of standard input (`Bun.stdin.text()`).
    fn read_stdin(&self) -> io::Result<String>;
    /// `prompt(question)`, trimmed; empty when standard input has ended.
    fn ask(&self, question: &str) -> String;
}

pub struct OperationContext<'a> {
    pub db_path: PathBuf,
    /// Which surface is running this, for the action journal.
    pub actor_type: &'static str,
    /// The `fetchImpl` operations reach platforms through.
    pub http: HttpClient,
    pub clock: &'a dyn Clock,
    /// The environment the process was started with (`process.env`).
    pub env: &'a dyn Fn(&str) -> Option<String>,
    /// The working directory `guide` looks for the launcher's `.env.local` in.
    pub cwd: PathBuf,
    pub terminal: Option<&'a dyn Terminal>,
    pub surface: &'a dyn Surface,
}

impl<'a> OperationContext<'a> {
    pub fn db(&self) -> Result<&'a BackendDb, OpError> {
        self.surface.db()
    }

    pub fn sqlite(&self) -> Result<&'a Connection, OpError> {
        Ok(db::unsafe_db(self.surface.db()?))
    }

    pub fn config(&self) -> Result<Arc<Config>, OpError> {
        self.surface.config()
    }

    pub fn studio<'c>(&self, config: &'c Config) -> Result<Studio<'c>, OpError>
    where
        'a: 'c,
    {
        self.surface.studio(config)
    }

    /// `createStudioServices(context.db(), context.config())`.
    pub fn services<'c>(&self, config: &'c Config) -> Result<StudioServices<'c, ProviderCalls>, OpError>
    where
        'a: 'c,
    {
        Ok(create_studio_services(
            self.surface.studio(config)?,
            self.surface.adapters()?,
        ))
    }

    pub fn adapters(&self) -> Result<&'a ProviderCalls, OpError> {
        self.surface.adapters()
    }

    pub fn now(&self) -> jiff::Timestamp {
        self.clock.now()
    }

    pub fn terminal(&self) -> Result<&'a dyn Terminal, OpError> {
        self.terminal
            .ok_or_else(|| OpError::failed("this command needs a terminal"))
    }
}

/// The parsed input of one operation, after coercion and transforms.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Input(pub Map<String, Value>);

impl Input {
    pub fn get(&self, name: &str) -> Option<&Value> {
        self.0.get(name).filter(|value| !value.is_null())
    }

    /// A required string field.
    pub fn str(&self, name: &str) -> &str {
        self.opt_str(name).unwrap_or_default()
    }

    pub fn opt_str(&self, name: &str) -> Option<&str> {
        self.get(name).and_then(Value::as_str)
    }

    pub fn bool(&self, name: &str) -> bool {
        self.get(name).and_then(Value::as_bool).unwrap_or(false)
    }

    pub fn opt_bool(&self, name: &str) -> Option<bool> {
        self.get(name).and_then(Value::as_bool)
    }

    /// A required integer field.
    pub fn int(&self, name: &str) -> i64 {
        self.opt_int(name).unwrap_or_default()
    }

    pub fn opt_int(&self, name: &str) -> Option<i64> {
        self.get(name)
            .and_then(|value| value.as_i64().or_else(|| value.as_f64().map(|f| f as i64)))
    }

    /// A string-list field (`targetList`).
    pub fn strings(&self, name: &str) -> Vec<String> {
        self.get(name)
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default()
    }
}
