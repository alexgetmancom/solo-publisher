//! The Rust handle against the database the TypeScript backend made
//! (`tests/fixtures/typescript-fresh.sql`, recorded before the cutover) and
//! against a copy of production's. Scratch files live under
//! `_trash-rust/tmp/db-tests`.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use std::{fs, thread};

use db::rusqlite::{self, Connection, ErrorCode};
use db::{BackendDb, unsafe_db};
use serde_json::{Value, json};

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap()
}

fn scratch(name: &str) -> PathBuf {
    let dir = repo_root().join("_trash-rust/tmp/db-tests").join(name);
    if dir.exists() {
        fs::remove_dir_all(&dir).unwrap();
    }
    fs::create_dir_all(&dir).unwrap();
    dir
}

/// Writes, at `path`, the database the backend recorded in the fixture: created
/// and migrated on an empty file.
fn typescript_database(path: &Path) {
    let sql =
        fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/typescript-fresh.sql")).unwrap();
    Connection::open(path).unwrap().execute_batch(&sql).unwrap();
}

fn journal_entries() -> u64 {
    let journal: Value = serde_json::from_str(
        &fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("migrations/meta/_journal.json")).unwrap(),
    )
    .unwrap();
    journal["entries"].as_array().unwrap().len() as u64
}

/// Everything a migrator or the date guards could make differ, one line each.
fn dump(path: &Path) -> Vec<String> {
    let sqlite = Connection::open(path).unwrap();
    let lines = |sql: &str| -> Vec<String> {
        let mut statement = sqlite.prepare(sql).unwrap();
        statement
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    };
    let mut dump = lines("SELECT 'user_version ' || user_version FROM pragma_user_version");
    dump.extend(lines(
        "SELECT 'schema ' || quote(type) || ' ' || quote(name) || ' ' || quote(tbl_name) || ' ' || quote(sql) \
         FROM sqlite_master ORDER BY rowid",
    ));
    dump.extend(lines(
        "SELECT 'migration ' || typeof(id) || ' ' || quote(id) || ' ' || quote(hash) || ' ' || typeof(created_at) \
         || ' ' || quote(created_at) FROM __drizzle_migrations ORDER BY rowid",
    ));
    dump.extend(lines(
        "SELECT 'column ' || m.name || ' ' || c.cid || ' ' || c.name || ' ' || quote(c.type) || ' ' || c.\"notnull\" \
         || ' ' || quote(c.dflt_value) || ' ' || c.pk \
         FROM sqlite_master AS m JOIN pragma_table_info(m.name) AS c WHERE m.type = 'table' ORDER BY m.name, c.cid",
    ));
    dump
}

fn assert_same(expected: &[String], actual: &[String]) {
    let first = expected.iter().zip(actual).position(|(left, right)| left != right);
    assert!(
        first.is_none() && expected.len() == actual.len(),
        "dumps differ at line {first:?} (lengths {} vs {}):\n  ts:   {:?}\n  rust: {:?}",
        expected.len(),
        actual.len(),
        first.and_then(|at| expected.get(at)),
        first.and_then(|at| actual.get(at)),
    );
}

fn count(lines: &[String], prefix: &str) -> usize {
    lines.iter().filter(|line| line.starts_with(prefix)).count()
}

#[test]
fn fresh_schema_matches_typescript() {
    let dir = scratch("fresh_schema");
    let ts = dir.join("ts.db");
    let rust = dir.join("rust.db");
    typescript_database(&ts);
    BackendDb::open(&rust).unwrap().close().unwrap();
    let expected = dump(&ts);
    assert_same(&expected, &dump(&rust));
    assert_eq!(count(&expected, "migration ") as u64, journal_entries());
    assert!(count(&expected, "schema 'trigger' 'date_guard_") > 0);
}

#[test]
fn rust_adopts_a_typescript_database() {
    let dir = scratch("rust_adopts");
    let path = dir.join("pipeline.db");
    typescript_database(&path);
    let before = dump(&path);
    let db = BackendDb::open(&path).unwrap();
    assert_eq!(db::install_date_guards(unsafe_db(&db)).unwrap(), 0);
    db.close().unwrap();
    assert_same(&before, &dump(&path));
}

/// The production copy carries 119 bookkeeping rows from before the baseline
/// was squashed to 37 files; adoption has to go by the newest `created_at`
/// alone, as drizzle did, apply nothing, and leave schema and bookkeeping as
/// they were, its date guards reinstalled identically when they are missing.
/// The file is private and not in CI. Only schema and bookkeeping are
/// compared, never row contents.
#[test]
fn rust_adopts_the_production_database_as_it_is() {
    let original = repo_root().join("_trash-rust/prod-db/pipeline.prod.db");
    if !original.exists() {
        eprintln!("skipped: no production copy at {}", original.display());
        return;
    }
    let dir = scratch("production");
    let (as_is, unguarded) = (dir.join("as-is.db"), dir.join("unguarded.db"));
    fs::copy(&original, &as_is).unwrap();
    fs::copy(&original, &unguarded).unwrap();
    let before = dump(&as_is);
    let applied = count(&before, "migration ") as u64;
    let guards = count(&before, "schema 'trigger' 'date_guard_");
    assert!(applied > journal_entries());
    assert!(guards > 0);

    BackendDb::open(&as_is).unwrap().close().unwrap();
    assert_same(&before, &dump(&as_is));

    // Without its guards, Rust installs the same ones from this schema.
    let sqlite = Connection::open(&unguarded).unwrap();
    let names: Vec<String> = sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name GLOB 'date_guard_*'")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    for name in names {
        sqlite.execute(&format!("DROP TRIGGER \"{name}\""), []).unwrap();
    }
    drop(sqlite);
    BackendDb::open(&unguarded).unwrap().close().unwrap();
    let reinstalled = dump(&unguarded);
    assert_eq!(count(&reinstalled, "migration ") as u64, applied);
    assert_eq!(count(&reinstalled, "schema 'trigger' 'date_guard_"), guards);
    // Dropped and created again, the triggers sit later in sqlite_master, and
    // production's own were written with other indentation.
    let normalized = |lines: Vec<String>| {
        let mut lines: Vec<String> = lines
            .iter()
            .map(|line| line.split_whitespace().collect::<Vec<_>>().join(" "))
            .collect();
        lines.sort();
        lines
    };
    assert_same(&normalized(before), &normalized(reinstalled));
}

#[test]
fn date_guards_reject_as_typescript_did() {
    let dir = scratch("date_guards");
    let db = BackendDb::open(dir.join("rust.db")).unwrap();
    let statements = [
        "INSERT INTO worker_state VALUES ('w', '{}', '34Z')",
        "INSERT INTO worker_state VALUES ('w', '{}', '2026-08-27T14:01:34Z')",
        "UPDATE worker_state SET updated_at = '2026-08-27 14:01:34' WHERE name = 'w'",
        "INSERT INTO creator_profile_snapshots (platform, account, sampled_on, metrics_json, source, sampled_at) \
         VALUES ('x', 'a', 'Aug 27', '{}', 's', '2026-08-27T14:01:34Z')",
        "INSERT INTO creator_profile_snapshots (platform, account, sampled_on, metrics_json, source, sampled_at) \
         VALUES ('x', 'a', '2026-08-27T15', '{}', 's', '2026-08-27T15:00:00.000Z')",
    ];
    let mut outcomes = Vec::new();
    for statement in statements {
        let rust = match unsafe_db(&db).execute(statement, []) {
            Ok(_) => json!({ "ok": true }),
            Err(rusqlite::Error::SqliteFailure(_, Some(message))) => json!({ "error": message }),
            Err(other) => panic!("{statement}: {other}"),
        };
        outcomes.push(rust);
    }
    assert_eq!(
        outcomes,
        [
            json!({ "error": "worker_state.updated_at must be an ISO instant such as 2026-08-27T14:01:34Z" }),
            json!({ "ok": true }),
            json!({ "error": "worker_state.updated_at must be an ISO instant such as 2026-08-27T14:01:34Z" }),
            json!({ "error": "creator_profile_snapshots.sampled_on must be a calendar day such as 2026-08-27, or an hour bucket such as 2026-08-27T15" }),
            json!({ "ok": true }),
        ]
    );
}

#[test]
fn immediate_writer_waits_for_the_lock_then_reports_busy() {
    let dir = scratch("immediate");
    let path = dir.join("pipeline.db");
    let mut first = BackendDb::open(&path).unwrap();
    let mut impatient = BackendDb::open(&path).unwrap();
    unsafe_db(&impatient).busy_timeout(Duration::from_millis(200)).unwrap();
    let mut patient = BackendDb::open(&path).unwrap();
    let waiter = first
        .immediate_transaction(|tx| {
            tx.execute(
                "INSERT INTO worker_state VALUES ('a', '{}', '2026-08-27T14:01:34Z')",
                [],
            )?;
            let started = Instant::now();
            let busy = impatient
                .immediate_transaction(|_| Ok::<_, rusqlite::Error>(()))
                .unwrap_err();
            assert_eq!(busy.sqlite_error_code(), Some(ErrorCode::DatabaseBusy));
            assert!(started.elapsed() >= Duration::from_millis(200));
            let waiter = thread::spawn(move || {
                let started = Instant::now();
                patient.immediate_transaction(|tx| {
                    tx.execute(
                        "INSERT INTO worker_state VALUES ('b', '{}', '2026-08-27T14:01:35Z')",
                        [],
                    )
                })?;
                Ok::<_, rusqlite::Error>(started.elapsed())
            });
            thread::sleep(Duration::from_millis(300));
            Ok::<_, rusqlite::Error>(waiter)
        })
        .unwrap();
    assert!(waiter.join().unwrap().unwrap() >= Duration::from_millis(250));
    let rows: i64 = unsafe_db(&first)
        .query_row("SELECT count(*) FROM worker_state", [], |row| row.get(0))
        .unwrap();
    assert_eq!(rows, 2);
}
