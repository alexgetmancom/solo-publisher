//! What every SQL-equivalence test shares with the run recorded in its golden:
//! how arguments name earlier results, how a database is dumped, how two runs
//! are compared, and the boundary fakes that answer as an empty Studio would.

#![allow(dead_code)]

use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::pin;
use std::task::{Context, Poll, Waker};

use content::Locale;
use db::rusqlite::Connection;
use domain::application::ports::StoryPublishMode;
use domain::publishing::boundaries::{
    AuthCircuit, AuthCircuitState, Jitter, StoryCardMedia, StoryCardState, StoryCards, UsageMeter, VideoCompletion,
};
use domain::studio::boundaries::{
    ChannelConnectLinks, ConnectPlatform, ConnectStart, MetaOauthPlatform, StoryDerivatives,
};
use foundation::config::Config;
use jiff::Timestamp;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value};

pub(crate) fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap()
}

/// Retry jitter that always draws the same value.
pub(crate) struct FixedJitter(pub f64);

impl Jitter for FixedJitter {
    fn unit(&self) -> f64 {
        self.0
    }
}

/// The boundaries as an empty Studio answers them: nothing recorded, nothing
/// held, and no OAuth app configured.
pub(crate) struct Inert;

impl AuthCircuit for Inert {
    fn record_failure(&self, _: &Connection, _: &str) -> domain::Result<()> {
        Ok(())
    }
    fn record_success(&self, _: &Connection, _: &str) -> domain::Result<()> {
        Ok(())
    }
    fn states(&self, _: &Connection) -> domain::Result<Vec<AuthCircuitState>> {
        Ok(Vec::new())
    }
}

impl UsageMeter for Inert {
    fn record(&self, _: &Connection, _: &str, _: bool, _: u64) {}
}

impl StoryCards for Inert {
    fn queue(&self, _: &Connection, _: i64) -> domain::Result<()> {
        Ok(())
    }
    fn for_draft(&self, _: &Connection, _: i64) -> domain::Result<Vec<StoryCardState>> {
        Ok(Vec::new())
    }
    fn ready_media(&self, _: &Connection, _: i64) -> domain::Result<Option<StoryCardMedia>> {
        Ok(None)
    }
    fn set_publish_mode(&self, _: &Connection, _: i64, _: StoryPublishMode) -> domain::Result<()> {
        Ok(())
    }
    fn discard(&self, _: &Connection, _: i64) -> domain::Result<()> {
        Ok(())
    }
}

impl VideoCompletion for Inert {
    fn record_if_final(&self, _: &Connection, _: i64) -> domain::Result<()> {
        Ok(())
    }
}

impl StoryDerivatives for Inert {
    fn ensure(&self, _: &str, _: bool, _: i64) {}
}

impl ChannelConnectLinks for Inert {
    fn meta_oauth_connect_url(&self, _: &Config, _: MetaOauthPlatform, _: Locale) -> domain::Result<String> {
        Err(domain::Error::message("not configured"))
    }
    fn meta_oauth_connect_path(&self, _: &Config, _: MetaOauthPlatform, _: Locale) -> domain::Result<String> {
        Err(domain::Error::message("not configured"))
    }
    fn x_oauth_connect_url(&self, _: &Config) -> domain::Result<String> {
        Err(domain::Error::message("not configured"))
    }
    fn x_oauth_connect_path(&self, _: &Config) -> domain::Result<String> {
        Err(domain::Error::message("not configured"))
    }
    fn start_connect(&self, _: &Config, _: ConnectPlatform, _: Locale, _: Timestamp) -> domain::Result<ConnectStart> {
        Err(domain::Error::message("not configured"))
    }
}

/// The fakes are synchronous, so every future is ready on its first poll.
pub(crate) fn ready<T>(future: impl Future<Output = T>) -> T {
    match pin!(future).poll(&mut Context::from_waker(Waker::noop())) {
        Poll::Ready(value) => value,
        Poll::Pending => panic!("a fake boundary never waits"),
    }
}

pub(crate) fn instant(value: &Value) -> Timestamp {
    foundation::time::parse_iso_instant(value.as_str().expect("clock is a string")).unwrap()
}

pub(crate) fn arg<T: DeserializeOwned>(args: &[Value], index: usize) -> T {
    serde_json::from_value(args.get(index).cloned().unwrap_or(Value::Null))
        .unwrap_or_else(|error| panic!("argument {index} of {args:?}: {error}"))
}

/// A result as JavaScript holds it: through `JSON.stringify`, so `12.0` read
/// from a JSON column is the number `12`, as in the recording.
pub(crate) fn out(value: impl Serialize) -> Value {
    serde_json::from_str(&domain::json::stringify(&serde_json::to_value(value).unwrap())).unwrap()
}

/// `{"$": "<name>.<field>"}` arguments replaced by fields of bound results.
pub(crate) fn resolve(value: &Value, vars: &Map<String, Value>) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(|item| resolve(item, vars)).collect()),
        Value::Object(object) => match object.get("$") {
            Some(Value::String(reference)) if object.len() == 1 => lookup(vars, reference).clone(),
            _ => Value::Object(
                object
                    .iter()
                    .map(|(key, item)| (key.clone(), resolve(item, vars)))
                    .collect(),
            ),
        },
        other => other.clone(),
    }
}

pub(crate) fn lookup<'a>(vars: &'a Map<String, Value>, reference: &str) -> &'a Value {
    let (name, field) = reference.split_once('.').expect("reference is <name>.<field>");
    &vars.get(name).unwrap_or_else(|| panic!("unbound {name}"))[field]
}

/// The dump the recording script took, statement for statement.
pub(crate) fn dump(sqlite: &Connection, ignored: &[String]) -> Map<String, Value> {
    let strings = |sql: &str, param: Option<&str>| -> Vec<String> {
        let mut statement = sqlite.prepare(sql).unwrap();
        let rows = statement
            .query_map(db::rusqlite::params_from_iter(param), |row| row.get(0))
            .unwrap();
        rows.map(Result::unwrap).collect()
    };
    let mut out = Map::new();
    for table in strings(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
        None,
    ) {
        if ignored.contains(&table) {
            continue;
        }
        let columns = strings("SELECT name FROM pragma_table_info(?) ORDER BY cid", Some(&table));
        let cells = columns
            .iter()
            .map(|column| format!(r#"typeof("{column}") || ':' || quote("{column}")"#))
            .collect::<Vec<_>>()
            .join(" || ' ' || ");
        let rows = strings(
            &format!(r#"SELECT quote(rowid) || ' ' || {cells} AS line FROM "{table}" ORDER BY rowid"#),
            None,
        );
        if !rows.is_empty() {
            out.insert(table, rows.into_iter().map(Value::String).collect());
        }
    }
    out
}

/// What the TypeScript backend recorded for a spec file before the cutover:
/// `<spec>.golden.json` beside it, with `<root>` standing for this checkout.
pub(crate) fn golden(spec: &Path) -> Value {
    let path = spec.with_extension("golden.json");
    let text = std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    serde_json::from_str(&text.replace("<root>", &repo_root().display().to_string())).unwrap()
}

/// Every step result and every table of every scenario, recording against
/// Rust; the differences, described.
pub(crate) fn differences(expected: &[Value], actual: &[Value]) -> Vec<String> {
    assert_eq!(expected.len(), actual.len(), "scenario count");
    let mut failures = Vec::new();
    for (expected, actual) in expected.iter().zip(actual) {
        let name = expected["name"].as_str().unwrap();
        let (expected_results, actual_results) = (
            expected["results"].as_array().unwrap(),
            actual["results"].as_array().unwrap(),
        );
        assert_eq!(expected_results.len(), actual_results.len(), "{name}: step count");
        for (index, (left, right)) in expected_results.iter().zip(actual_results).enumerate() {
            if left != right {
                failures.push(format!("{name}, call #{index}:\n  ts:   {left}\n  rust: {right}"));
            }
        }
        let (expected_tables, actual_tables) = (
            expected["tables"].as_object().unwrap(),
            actual["tables"].as_object().unwrap(),
        );
        for table in expected_tables
            .keys()
            .chain(actual_tables.keys().filter(|key| !expected_tables.contains_key(*key)))
        {
            let (left, right) = (&expected_tables.get(table), &actual_tables.get(table));
            if left != right {
                failures.push(format!(
                    "{name}, table {table}:\n  ts:   {}\n  rust: {}",
                    serde_json::to_string_pretty(left).unwrap(),
                    serde_json::to_string_pretty(right).unwrap()
                ));
            }
        }
    }
    failures
}
