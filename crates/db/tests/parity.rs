//! The Rust handle against the TypeScript one, by running both: the TS side is
//! `scripts/rust/db-reference.ts`, which opens databases through the real
//! `openBackendDb`. Scratch files live under `_trash-rust/tmp/db-tests`.

use std::path::{Path, PathBuf};
use std::process::Command;
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

fn typescript(args: &[&str]) -> Value {
    let output = Command::new("bun")
        .arg("scripts/rust/db-reference.ts")
        .args(args)
        .current_dir(repo_root())
        .output()
        .expect("bun must be on PATH");
    assert!(
        output.status.success(),
        "bun failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

fn journal_entries() -> u64 {
    let journal: Value =
        serde_json::from_str(&fs::read_to_string(repo_root().join("apps/backend/drizzle/meta/_journal.json")).unwrap())
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
    assert_eq!(
        typescript(&["open", ts.to_str().unwrap()]),
        json!({ "before": 0, "after": journal_entries() })
    );
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
    typescript(&["open", path.to_str().unwrap()]);
    let before = dump(&path);
    let db = BackendDb::open(&path).unwrap();
    assert_eq!(db::install_date_guards(unsafe_db(&db)).unwrap(), 0);
    db.close().unwrap();
    assert_same(&before, &dump(&path));
}

#[test]
fn typescript_adopts_a_rust_database() {
    let dir = scratch("typescript_adopts");
    let path = dir.join("pipeline.db");
    BackendDb::open(&path).unwrap().close().unwrap();
    let before = dump(&path);
    let entries = journal_entries();
    assert_eq!(
        typescript(&["open", path.to_str().unwrap()]),
        json!({ "before": entries, "after": entries })
    );
    assert_same(&before, &dump(&path));
}

/// The production copy carries 119 bookkeeping rows from before the baseline
/// was squashed to 37 files; adoption has to go by the newest `created_at`
/// alone, as drizzle does. The file is private and not in CI. Only schema and
/// bookkeeping are compared, never row contents.
#[test]
fn both_sides_adopt_the_production_database_alike() {
    let original = repo_root().join("_trash-rust/prod-db/pipeline.prod.db");
    if !original.exists() {
        eprintln!("skipped: no production copy at {}", original.display());
        return;
    }
    let dir = scratch("production");
    let (rust, ts) = (dir.join("rust.db"), dir.join("ts.db"));
    fs::copy(&original, &rust).unwrap();
    fs::copy(&original, &ts).unwrap();
    let before = dump(&rust);
    let applied = count(&before, "migration ") as u64;
    let guards = count(&before, "schema 'trigger' 'date_guard_");
    assert!(applied > journal_entries());
    assert!(guards > 0);
    // Without their guards, so each side installs its own from this schema.
    for copy in [&rust, &ts] {
        let sqlite = Connection::open(copy).unwrap();
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
    }

    BackendDb::open(&rust).unwrap().close().unwrap();
    assert_eq!(
        typescript(&["open", ts.to_str().unwrap()]),
        json!({ "before": applied, "after": applied })
    );
    let after = dump(&rust);
    assert_eq!(count(&after, "migration ") as u64, applied);
    assert_eq!(count(&after, "schema 'trigger' 'date_guard_"), guards);
    assert_same(&dump(&ts), &after);
}

#[test]
fn date_guards_reject_like_typescript() {
    let dir = scratch("date_guards");
    let ts = dir.join("ts.db");
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
        assert_eq!(
            typescript(&["exec", ts.to_str().unwrap(), statement]),
            rust,
            "{statement}"
        );
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
    let mut impatient = BackendDb::open_with_timeout(&path, Duration::from_millis(200)).unwrap();
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
