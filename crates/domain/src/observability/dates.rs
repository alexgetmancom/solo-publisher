//! Every stored date, checked for being one (`observability/date-integrity.ts`)
//! and repaired by the three honest moves (`observability/date-repair.ts`).
//!
//! Dates are text here and every query compares them as text, so a value that
//! is not a date does not fail — it sorts. The columns are read from the
//! database itself, so a table added tomorrow is covered without a list.

use std::sync::LazyLock;

use db::rusqlite::types::Value as SqlValue;
use db::rusqlite::{Connection, params_from_iter};
use regex::Regex;
use serde::Serialize;
use serde_json::Value;

use crate::Result;

const INSTANT: &str = "[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*";
const DAY: &str = "[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]";
/// An hourly collector files its snapshot under the truncated timestamp.
const HOUR: &str = "[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DateExpectation {
    Instant,
    Day,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct DateViolation {
    pub table: String,
    pub column: String,
    pub expects: DateExpectation,
    pub rows: i64,
    pub sample: Value,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub enum RepairAction {
    #[serde(rename = "normalised")]
    Normalised,
    #[serde(rename = "deleted")]
    Deleted,
    #[serde(rename = "dated from last_seen_at")]
    DatedFromLastSeen,
    #[serde(rename = "unrepairable")]
    Unrepairable,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct DateRepair {
    #[serde(flatten)]
    pub violation: DateViolation,
    pub action: RepairAction,
    pub applied: bool,
}

/// `_on` and an export's period are calendar days; `_at` is a moment.
fn expectation_for(column: &str) -> Option<DateExpectation> {
    if column.ends_with("_at") {
        Some(DateExpectation::Instant)
    } else if column.ends_with("_on") || column == "period_start" || column == "period_end" {
        Some(DateExpectation::Day)
    } else {
        None
    }
}

static TEXT_TYPE: LazyLock<Regex> = LazyLock::new(|| Regex::new("(?i)text|char|clob").unwrap());

fn json_of(value: SqlValue) -> Value {
    match value {
        SqlValue::Null => Value::Null,
        SqlValue::Integer(number) => number.into(),
        SqlValue::Real(number) => serde_json::Number::from_f64(number).map_or(Value::Null, Value::Number),
        SqlValue::Text(text) => text.into(),
        SqlValue::Blob(bytes) => String::from_utf8_lossy(&bytes).into_owned().into(),
    }
}

/// `dateIntegrity`: every text date column holding a value of the wrong shape.
pub fn date_integrity(sqlite: &Connection) -> Result<Vec<DateViolation>> {
    let tables: Vec<String> = sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")?
        .query_map([], |row| row.get(0))?
        .collect::<db::rusqlite::Result<_>>()?;
    let mut violations = Vec::new();
    for table in tables {
        let columns: Vec<(String, String)> = sqlite
            .prepare(&format!(r#"PRAGMA table_info("{table}")"#))?
            .query_map([], |row| Ok((row.get("name")?, row.get("type")?)))?
            .collect::<db::rusqlite::Result<_>>()?;
        for (column, kind) in columns {
            let Some(expects) = expectation_for(&column) else {
                continue;
            };
            if !TEXT_TYPE.is_match(&kind) {
                continue;
            }
            let patterns: &[&str] = match expects {
                DateExpectation::Instant => &[INSTANT],
                DateExpectation::Day => &[DAY, HOUR],
            };
            let conditions = patterns
                .iter()
                .map(|_| format!(r#""{column}" NOT GLOB ?"#))
                .collect::<Vec<_>>()
                .join(" AND ");
            let (rows, sample) = sqlite.query_row(
                &format!(
                    r#"SELECT COUNT(*) AS rows, MIN("{column}") AS sample FROM "{table}"
           WHERE "{column}" IS NOT NULL AND {conditions}"#
                ),
                params_from_iter(patterns.iter()),
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, SqlValue>(1)?)),
            )?;
            if rows > 0 {
                violations.push(DateViolation {
                    table: table.clone(),
                    column,
                    expects,
                    rows,
                    sample: json_of(sample),
                });
            }
        }
    }
    Ok(violations)
}

/// Readings: a row is one measurement, and a measurement whose moment is
/// unknown is not one. Nothing else may be deleted to fix a date.
const READING_TABLES: [&str; 3] = ["metric_samples", "post_metrics", "x_activity_metric_snapshots"];

/// What SQLite's `CURRENT_TIMESTAMP` writes, in UTC, with a space where the
/// `T` belongs: the same instant, spelled so it sorts before every ISO row.
static SQLITE_STAMP: LazyLock<Regex> =
    LazyLock::new(|| Regex::new("^([0-9]{4}-[0-9]{2}-[0-9]{2}) ([0-9]{2}:[0-9]{2}:[0-9]{2})$").unwrap());
static ISO_INSTANT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}").unwrap());

/// `String(value)` of a stored cell, as the TypeScript tests ran on it.
fn text_of(value: &SqlValue) -> String {
    match value {
        SqlValue::Null => "null".into(),
        SqlValue::Integer(number) => number.to_string(),
        SqlValue::Real(number) => foundation::js::number_to_string(*number),
        SqlValue::Text(text) => text.clone(),
        SqlValue::Blob(bytes) => String::from_utf8_lossy(bytes).into_owned(),
    }
}

/// `repairStoredDates(backendDb, apply)`: a SQLite stamp is rewritten in
/// place; a reading stamped with a moment that never happened is deleted; an
/// X item's `first_seen_at` is dated from when it was last seen. Without
/// `apply` it only says what it would do.
pub fn repair_stored_dates(sqlite: &Connection, apply: bool) -> Result<Vec<DateRepair>> {
    let mut repairs = Vec::new();
    for violation in date_integrity(sqlite)? {
        let (table, column) = (violation.table.clone(), violation.column.clone());
        let values: Vec<SqlValue> = sqlite
            .prepare(&format!(
                r#"SELECT DISTINCT "{column}" AS value FROM "{table}" WHERE "{column}" IS NOT NULL"#
            ))?
            .query_map([], |row| row.get(0))?
            .collect::<db::rusqlite::Result<_>>()?;
        let stamped: Vec<&SqlValue> = values
            .iter()
            .filter(|value| SQLITE_STAMP.is_match(&text_of(value)))
            .collect();
        let broken: Vec<&SqlValue> = values
            .iter()
            .filter(|value| {
                let text = text_of(value);
                !SQLITE_STAMP.is_match(&text) && !ISO_INSTANT.is_match(&text)
            })
            .collect();
        if !stamped.is_empty() {
            if apply {
                for value in &stamped {
                    let normalised = SQLITE_STAMP.replace(&text_of(value), "${1}T${2}.000Z").into_owned();
                    sqlite.execute(
                        &format!(r#"UPDATE "{table}" SET "{column}"=? WHERE "{column}"=?"#),
                        (normalised, *value),
                    )?;
                }
            }
            repairs.push(DateRepair {
                violation: violation.clone(),
                action: RepairAction::Normalised,
                applied: apply,
            });
        }
        if broken.is_empty() {
            continue;
        }
        if READING_TABLES.contains(&table.as_str()) {
            if apply {
                for value in &broken {
                    sqlite.execute(&format!(r#"DELETE FROM "{table}" WHERE "{column}"=?"#), [*value])?;
                }
            }
            repairs.push(DateRepair {
                violation,
                action: RepairAction::Deleted,
                applied: apply,
            });
        } else if table == "x_activity_items" && column == "first_seen_at" {
            if apply {
                sqlite.execute(
                    "UPDATE x_activity_items SET first_seen_at=last_seen_at WHERE first_seen_at NOT GLOB ?",
                    [INSTANT],
                )?;
            }
            repairs.push(DateRepair {
                violation,
                action: RepairAction::DatedFromLastSeen,
                applied: apply,
            });
        } else {
            repairs.push(DateRepair {
                violation,
                action: RepairAction::Unrepairable,
                applied: false,
            });
        }
    }
    Ok(repairs)
}
