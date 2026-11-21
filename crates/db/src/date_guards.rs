//! The database refuses a date that is not one.
//!
//! A rule in a document is advice and a check in an importer guards one door;
//! "34Z" walked through a different one and took eight days of readings off the
//! charts without a single error. These triggers are the barrier itself: every
//! writer hits them, including raw SQL through `unsafe_db`, a migration copying
//! rows, and code written years from now by someone who never read the rule.
//!
//! They are installed from what the database actually holds rather than from a
//! list, so a column added by tomorrow's migration is guarded the next time the
//! process starts, with nobody remembering to add it. Names and SQL text are the
//! TypeScript Studio's, so either side finds the other's triggers already right.

use rusqlite::Connection;

const INSTANT: &str = "[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*";
const DAY: &str = "[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]";
/// `sampled_on` buckets by hour when the collector runs hourly, and the bucket
/// is the truncated timestamp: a day with an hour on it, still not a moment.
const HOUR: &str = "[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]";
const PREFIX: &str = "date_guard_";

/// A `_at` column is a moment; `_on` and an export's period are the day (or the
/// hour) something is filed under.
fn expectation_for(column: &str) -> Option<(&'static [&'static str], &'static str)> {
    if column.ends_with("_at") {
        return Some((&[INSTANT], "an ISO instant such as 2026-08-27T14:01:34Z"));
    }
    if column.ends_with("_on") || column == "period_start" || column == "period_end" {
        return Some((
            &[DAY, HOUR],
            "a calendar day such as 2026-08-27, or an hour bucket such as 2026-08-27T15",
        ));
    }
    None
}

/// Brings the `date_guard_*` triggers in line with the live schema and returns
/// how many it created.
pub fn install_date_guards(sqlite: &Connection) -> rusqlite::Result<usize> {
    // One query for every column in the database: a PRAGMA per table costs more
    // than the triggers themselves, and this runs on every open.
    let columns = sqlite
        .prepare(
            r#"SELECT m.name AS "table", info.name AS "column", info.type AS "type"
         FROM sqlite_master AS m
         JOIN pragma_table_info(m.name) AS info
        WHERE m.type='table' AND m.name NOT LIKE 'sqlite_%'"#,
        )?
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    // Insertion-ordered like the JavaScript Map it ports, so triggers land in
    // `sqlite_master` in the same order.
    let mut wanted: Vec<(String, String)> = Vec::new();
    for (table, column, kind) in &columns {
        let Some((patterns, shape)) = expectation_for(column) else {
            continue;
        };
        let kind = kind.to_lowercase();
        if !["text", "char", "clob"].iter().any(|affinity| kind.contains(affinity)) {
            continue;
        }
        let message = format!("{table}.{column} must be {shape}").replace('\'', "''");
        let rejects = patterns
            .iter()
            .map(|pattern| format!("NEW.\"{column}\" NOT GLOB '{pattern}'"))
            .collect::<Vec<_>>()
            .join(" AND ");
        for (event, clause) in [
            ("insert", format!("BEFORE INSERT ON \"{table}\"")),
            ("update", format!("BEFORE UPDATE OF \"{column}\" ON \"{table}\"")),
        ] {
            let name = format!("{PREFIX}{table}_{column}_{event}");
            let statement = format!(
                "CREATE TRIGGER \"{name}\" {clause}\n         FOR EACH ROW WHEN NEW.\"{column}\" IS NOT NULL AND {rejects}\n         BEGIN SELECT RAISE(ABORT, '{message}'); END"
            );
            match wanted.iter_mut().find(|(existing, _)| *existing == name) {
                Some(entry) => entry.1 = statement,
                None => wanted.push((name, statement)),
            }
        }
    }
    let existing = sqlite
        .prepare(&format!(
            "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE '{PREFIX}%'"
        ))?
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    // A column that stopped being a date, or a table that is gone, leaves a
    // trigger behind that would guard nothing and confuse the next reader.
    let stale: Vec<&String> = existing
        .iter()
        .filter(|name| !wanted.iter().any(|(wanted, _)| wanted == *name))
        .collect();
    let missing: Vec<&String> = wanted
        .iter()
        .filter(|(name, _)| !existing.contains(name))
        .map(|(_, statement)| statement)
        .collect();
    if stale.is_empty() && missing.is_empty() {
        return Ok(0);
    }
    let tx = sqlite.unchecked_transaction()?;
    for name in stale {
        tx.execute(&format!("DROP TRIGGER IF EXISTS \"{name}\""), [])?;
    }
    for statement in &missing {
        tx.execute(statement, [])?;
    }
    tx.commit()?;
    Ok(missing.len())
}
