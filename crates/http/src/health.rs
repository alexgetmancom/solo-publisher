//! `/healthz`, `/tg-feed/healthz` and `/readyz` (`interfaces/http/health.ts`).

use std::path::Path;

use axum::Router;
use axum::extract::State;
use axum::response::Response;
use axum::routing::get;
use db::unsafe_db;
use domain::application::ports::ApplicationPorts;
use domain::studio::config::studio_config;
use rustix::fs::{Access, access};
use rustix::io::Errno;
use serde_json::{Map, Value, json};

use crate::HttpState;
use crate::local::Local;
use crate::response::{HandlerResult, json_response, on_local, text};

pub(crate) fn routes() -> Router<Local> {
    Router::new()
        .route("/healthz", get(ok))
        .route("/tg-feed/healthz", get(ok))
        .route("/readyz", get(readyz))
}

async fn ok() -> Response {
    text("ok\n", 200)
}

async fn readyz(State(local): State<Local>) -> Response {
    on_local(&local, |state| async move { readiness(&state) }).await
}

/// Readiness for the deploy gate. A real query and real write permissions, not
/// a stat: the old check stayed green on a read-only volume, a corrupt database
/// and an unwritable media mount alike. Worker heartbeats are reported for
/// diagnosis but never gate: at activation no cycle has necessarily run yet.
fn readiness(state: &HttpState) -> HandlerResult {
    let backend = &*state.backend;
    let config = backend.config();
    let sqlite = unsafe_db(backend.db());
    let mut checks = Map::new();
    checks.insert(
        "database".into(),
        attempt(
            sqlite
                .query_row("SELECT count(*) FROM worker_state", [], |_| Ok(()))
                .map_err(|error| error.to_string()),
        ),
    );
    // The data directory holds the database and its WAL; unwritable means
    // every write fails while reads keep looking healthy.
    checks.insert(
        "data_dir_writable".into(),
        attempt(writable(Path::new(&config.data_dir))),
    );
    // Media mounts are created lazily, so absence is not a failure; an
    // existing directory this process cannot write to is.
    let site_enabled = studio_config(ApplicationPorts::new(backend.db(), backend.clock())).site_enabled()?;
    let mut directories = vec![
        ("media_cache_dir", &config.media_cache_dir),
        ("studio_media_dir", &config.studio_media_dir),
    ];
    if site_enabled {
        directories.push(("site_public_dir", &config.site_public_dir));
    }
    for (name, dir) in directories {
        if dir.exists() {
            checks.insert(format!("{name}_writable"), attempt(writable(dir)));
        }
    }
    let now = backend.clock().now();
    let mut workers = Map::new();
    let mut statement = sqlite.prepare("SELECT name, state_json, updated_at FROM worker_state")?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
        ))
    })?;
    for row in rows {
        let (name, state_json, updated_at) = row?;
        let state = match serde_json::from_str::<Value>(&state_json)? {
            Value::Object(state) => state,
            _ => Map::new(),
        };
        let liveness = runtime::worker_state::worker_liveness(&state, &updated_at, now);
        workers.insert(
            name,
            json!({
                "updated_at": updated_at,
                "ageSeconds": liveness.age_seconds,
                "stale": liveness.stale,
                "lastHeartbeatAt": liveness.last_heartbeat_at,
            }),
        );
    }
    let ok = checks.values().all(|check| check["ok"] == true);
    let status = if ok { 200 } else { 503 };
    Ok(json_response(
        &json!({"ok": ok, "checks": checks, "workers": workers}),
        status,
    ))
}

fn attempt(check: Result<(), String>) -> Value {
    match check {
        Ok(()) => json!({"ok": true}),
        Err(detail) => json!({"ok": false, "detail": detail}),
    }
}

/// `fs.accessSync(dir, fs.constants.W_OK)`, failing with Node's message.
fn writable(path: &Path) -> Result<(), String> {
    access(path, Access::WRITE_OK).map_err(|errno| {
        let (code, description) = match errno {
            Errno::ACCESS => ("EACCES", "permission denied"),
            Errno::NOENT => ("ENOENT", "no such file or directory"),
            Errno::ROFS => ("EROFS", "read-only file system"),
            Errno::NOTDIR => ("ENOTDIR", "not a directory"),
            Errno::PERM => ("EPERM", "operation not permitted"),
            Errno::LOOP => ("ELOOP", "too many symbolic links encountered"),
            Errno::NAMETOOLONG => ("ENAMETOOLONG", "name too long"),
            Errno::IO => ("EIO", "i/o error"),
            other => return format!("{}, access '{}'", std::io::Error::from(other), path.display()),
        };
        format!("{code}: {description}, access '{}'", path.display())
    })
}
