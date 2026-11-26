//! The backup streams a backup host pulls over
//! SSH, and the record of the last one `doctor` reads. Nothing is written to
//! this host: a Studio that held its own backups would lose them with itself.

use std::path::{Component, Path, PathBuf};
use std::process::Stdio;

use db::rusqlite::{Connection, OpenFlags, OptionalExtension};
use foundation::config::Config;
use foundation::time::{parse_iso_instant, to_iso_string};
use jiff::Timestamp;
use serde_json::{Value, json};
use tokio::io::AsyncReadExt as _;

use crate::context::{OpError, Terminal};

/// How stale the newest export may be before `doctor` calls the deployment
/// unhealthy: media has no second route off this host.
const EXPORT_MAX_AGE_DAYS: f64 = 7.0;

/// Written in slices rather than as one buffer.
const FLUSH_BYTES: usize = 4 * 1024 * 1024;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum ExportKind {
    Media,
    Db,
}

impl ExportKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Media => "media",
            Self::Db => "db",
        }
    }

    fn state_key(self) -> String {
        format!("export:{}", self.as_str())
    }
}

/// `recordExport`.
pub(super) fn record_export(
    sqlite: &Connection,
    kind: ExportKind,
    bytes: Option<u64>,
    now: Timestamp,
) -> Result<(), OpError> {
    let at = to_iso_string(now);
    let state = json!({"at": at, "bytes": bytes}).to_string();
    sqlite.execute(
        r#"insert into "worker_state" ("name", "state_json", "updated_at") values (?1, ?2, ?3) on conflict ("worker_state"."name") do update set "state_json" = ?2, "updated_at" = ?3"#,
        (kind.state_key(), state, at),
    )?;
    Ok(())
}

/// `exportStatus`: `{kind, at, bytes, ageDays, ok}`.
pub(super) fn export_status(sqlite: &Connection, kind: ExportKind, now: Timestamp) -> Result<Value, OpError> {
    let state: Option<String> = sqlite
        .query_row(
            r#"select "state_json" from "worker_state" where "worker_state"."name" = ?"#,
            [kind.state_key()],
            |row| row.get(0),
        )
        .optional()?;
    let state: Value = state
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or(Value::Null);
    let at = state
        .as_object()
        .and_then(|state| state.get("at"))
        .and_then(Value::as_str);
    let bytes = state
        .as_object()
        .and_then(|state| state.get("bytes"))
        .filter(|bytes| bytes.is_number())
        .cloned()
        .unwrap_or(Value::Null);
    // `Date.parse` of something that is not a date is NaN, which prints as null
    // and is never fresh.
    let age_days = at.map(|at| {
        parse_iso_instant(at).map_or(f64::NAN, |then| {
            let days = (now.as_millisecond() - then.as_millisecond()) as f64 / (24.0 * 60.0 * 60.0 * 1000.0);
            (days * 100.0 + 0.5).floor() / 100.0
        })
    });
    let ok = age_days.is_some_and(|age| age <= EXPORT_MAX_AGE_DAYS);
    Ok(json!({
        "kind": kind.as_str(),
        "at": at,
        "bytes": bytes,
        "ageDays": age_days.filter(|age| age.is_finite()),
        "ok": ok,
    }))
}

fn media_sources(config: &Config) -> [PathBuf; 4] {
    [
        config.studio_media_dir.clone(),
        config.media_cache_dir.clone(),
        config.story_card_dir.clone(),
        config.site_public_dir.clone(),
    ]
}

/// `path.resolve`: absolute against the working directory, folded lexically.
fn resolve(path: &Path) -> PathBuf {
    let absolute = std::env::current_dir().unwrap_or_default().join(path);
    let mut resolved = PathBuf::from("/");
    for component in absolute.components() {
        match component {
            Component::ParentDir => {
                resolved.pop();
            }
            Component::Normal(part) => resolved.push(part),
            Component::RootDir | Component::CurDir | Component::Prefix(_) => {}
        }
    }
    resolved
}

/// `streamMediaArchive`: a gzipped tar of every media tree that exists,
/// relative to DATA_DIR so it restores onto a fresh volume unchanged, written
/// to the terminal's stdout; recorded only on a clean exit, because a
/// truncated archive counted as a backup would keep `doctor` green over it.
pub(super) async fn stream_media_archive(
    config: &Config,
    sqlite: &Connection,
    terminal: &dyn Terminal,
    now: Timestamp,
) -> Result<Value, OpError> {
    let present: Vec<PathBuf> = media_sources(config)
        .into_iter()
        .filter(|source| source.exists())
        .collect();
    if present.is_empty() {
        return Err(OpError::failed("no media directories exist to export"));
    }
    let data_dir = resolve(Path::new(&config.data_dir));
    let mut relative = Vec::new();
    for source in &present {
        match resolve(source).strip_prefix(&data_dir) {
            Ok(inside) => relative.push(inside.display().to_string()),
            Err(_) => {
                return Err(OpError::failed(
                    "every media directory must live under DATA_DIR for the archive to restore onto a fresh volume",
                ));
            }
        }
    }
    // Rust's stdout blocks, so tar writes to it directly; the slow reader's
    // backpressure is the pipe's.
    let mut child = tokio::process::Command::new("tar")
        .args(["-czf", "-", "-C", &config.data_dir])
        .args(&relative)
        .stdin(Stdio::null())
        .stdout(terminal.child_stdout()?)
        .stderr(Stdio::piped())
        .spawn()?;
    let mut stderr = String::new();
    if let Some(mut pipe) = child.stderr.take() {
        pipe.read_to_string(&mut stderr).await?;
    }
    let status = child.wait().await?;
    if !status.success() {
        let code = status.code().map_or_else(|| "null".to_owned(), |code| code.to_string());
        return Err(OpError::failed(format!(
            "tar failed ({code}): {}",
            foundation::js::trim(&stderr)
        )));
    }
    record_export(sqlite, ExportKind::Media, None, now)?;
    Ok(Value::Null)
}

/// `streamDatabase`: a consistent image of the database, taken under SQLite's
/// own lock (`serialize`) so a write landing mid-export cannot tear it.
pub(super) fn stream_database(
    db_path: &Path,
    sqlite: &Connection,
    terminal: &dyn Terminal,
    now: Timestamp,
) -> Result<Value, OpError> {
    let mut reader = Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    let snapshot = reader.serialize(db::rusqlite::MAIN_DB)?;
    for slice in snapshot.chunks(FLUSH_BYTES) {
        terminal.write(slice)?;
    }
    let bytes = snapshot.len() as u64;
    drop(snapshot);
    drop(reader);
    record_export(sqlite, ExportKind::Db, Some(bytes), now)?;
    Ok(json!(bytes))
}
