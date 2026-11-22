//! What every SQL-equivalence test shares with its TypeScript runner
//! (`scripts/rust/scenario-support.ts`): how arguments name earlier results,
//! how a database is dumped, and how two runs are compared.

#![allow(dead_code)]

use std::cell::Cell;
use std::path::{Path, PathBuf};
use std::process::Command;

use db::rusqlite::Connection;
use domain::application::ports::Clock;
use jiff::Timestamp;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value};

pub fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap()
}

pub struct FixedClock(pub Cell<Timestamp>);

impl Clock for FixedClock {
    fn now(&self) -> Timestamp {
        self.0.get()
    }
}

pub fn instant(value: &Value) -> Timestamp {
    foundation::time::parse_iso_instant(value.as_str().expect("clock is a string")).unwrap()
}

pub fn arg<T: DeserializeOwned>(args: &[Value], index: usize) -> T {
    serde_json::from_value(args.get(index).cloned().unwrap_or(Value::Null))
        .unwrap_or_else(|error| panic!("argument {index} of {args:?}: {error}"))
}

/// A result as JavaScript holds it: through `JSON.stringify`, so `12.0` read
/// from a JSON column is the number `12`, as on the TypeScript side.
pub fn out(value: impl Serialize) -> Value {
    serde_json::from_str(&domain::json::stringify(&serde_json::to_value(value).unwrap())).unwrap()
}

/// `{"$": "<name>.<field>"}` arguments replaced by fields of bound results.
pub fn resolve(value: &Value, vars: &Map<String, Value>) -> Value {
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

pub fn lookup<'a>(vars: &'a Map<String, Value>, reference: &str) -> &'a Value {
    let (name, field) = reference.split_once('.').expect("reference is <name>.<field>");
    &vars.get(name).unwrap_or_else(|| panic!("unbound {name}"))[field]
}

/// The TypeScript script's dump, statement for statement.
pub fn dump(sqlite: &Connection, ignored: &[String]) -> Map<String, Value> {
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

/// Runs a TypeScript scenario runner over a spec file and returns the JSON it
/// writes to a file: a large stdout write is cut short on a CI pipe.
pub fn typescript(script: &str, spec: &Path) -> Value {
    let tmp = repo_root().join("_trash-rust/tmp");
    std::fs::create_dir_all(&tmp).unwrap();
    let out = tmp.join(spec.file_name().unwrap()).with_extension("typescript.json");
    // A file left by an earlier run must not stand in for this one.
    let _ = std::fs::remove_file(&out);
    let output = Command::new("bun")
        .arg(script)
        .arg(spec)
        .arg(&out)
        .current_dir(repo_root())
        .env("TMPDIR", &tmp)
        .output()
        .expect("bun must be on PATH");
    assert!(
        output.status.success(),
        "bun failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_str(&std::fs::read_to_string(&out).expect("runner output")).unwrap()
}

/// Every step result and every table of every scenario, TypeScript against
/// Rust; the differences, described.
pub fn differences(expected: &[Value], actual: &[Value]) -> Vec<String> {
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
