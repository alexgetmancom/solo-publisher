//! Byte-for-byte replay of `parity/public-site/goldens.json`, recorded from
//! the TypeScript route before the cutover: every case runs its steps on a fresh database and DATA_DIR under the
//! same fixed clock, and every response (status, headers, body) and every
//! journalled event must come out identical.

use std::cell::Cell;
use std::fs;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::time::{Duration, UNIX_EPOCH};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use db::rusqlite::Connection;
use db::{BackendDb, unsafe_db};
use domain::application::ports::Clock;
use foundation::config::{Config, load_config};
use jiff::Timestamp;
use public_site::{PublicSite, SiteRequest, SiteResponse};
use serde_json::{Value, json};

const T0: &str = "2026-11-01T10:00:00.000Z";

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap()
}

struct FixedClock(Cell<Timestamp>);

impl Clock for FixedClock {
    fn now(&self) -> Timestamp {
        self.0.get()
    }
}

fn instant(value: &str) -> Timestamp {
    foundation::time::parse_iso_instant(value).unwrap()
}

struct Run<'a> {
    db: &'a BackendDb,
    external: &'a Connection,
    config: &'a Config,
    clock: &'a FixedClock,
    site: &'a PublicSite,
    previous: Cell<Option<String>>,
}

impl Run<'_> {
    /// One step; requests append their recorded response.
    fn step<'s>(
        &'s self,
        step: &'s Value,
        results: &'s std::cell::RefCell<Vec<Value>>,
    ) -> Pin<Box<dyn Future<Output = ()> + 's>> {
        Box::pin(async move {
            if let Some(clock) = step["clock"].as_str() {
                self.clock.0.set(instant(clock));
            } else if let Some(sql) = step["sql"].as_str() {
                unsafe_db(self.db)
                    .execute_batch(sql)
                    .unwrap_or_else(|error| panic!("{sql}: {error}"));
            } else if let Some(sql) = step["external_sql"].as_str() {
                self.external
                    .execute_batch(sql)
                    .unwrap_or_else(|error| panic!("{sql}: {error}"));
            } else if let Some(file) = step["write"].as_str() {
                let path = self.config.site_public_dir.join(file);
                fs::create_dir_all(path.parent().unwrap()).unwrap();
                fs::write(&path, STANDARD.decode(step["base64"].as_str().unwrap()).unwrap()).unwrap();
                let mtime = UNIX_EPOCH + Duration::from_secs(step["mtime"].as_u64().unwrap());
                fs::File::options()
                    .write(true)
                    .open(&path)
                    .unwrap()
                    .set_modified(mtime)
                    .unwrap();
            } else {
                let request = &step["request"];
                let previous = self.previous.take();
                self.previous.set(previous.clone());
                let if_none_match = match request["if_none_match"].as_str() {
                    Some("$previous") => Some(previous.unwrap_or_default()),
                    other => other.map(str::to_owned),
                };
                let respond = self.site.respond(
                    self.db,
                    self.config,
                    self.clock,
                    SiteRequest {
                        if_none_match: if_none_match.as_deref(),
                        prefer: request["prefer"].as_str(),
                    },
                );
                let during = async {
                    if let Some(during) = step["during"].as_array() {
                        tokio::time::sleep(Duration::from_millis(20)).await;
                        for inner in during {
                            self.step(inner, results).await;
                        }
                    }
                };
                let (response, ()) = tokio::join!(respond, during);
                let response: SiteResponse = response.unwrap();
                let header = |name: &str| {
                    response
                        .headers
                        .iter()
                        .find(|(key, _)| *key == name)
                        .map(|(_, value)| value.clone())
                };
                if let Some(etag) = header("etag") {
                    self.previous.set(Some(etag));
                }
                results.borrow_mut().push(json!({
                    "status": response.status,
                    "headers": {
                        "content-type": header("content-type"),
                        "etag": header("etag"),
                        "cache-control": header("cache-control"),
                    },
                    "body": response.body,
                }));
            }
        })
    }
}

fn events(db: &BackendDb) -> Vec<Value> {
    let mut statement = unsafe_db(db)
        .prepare(
            "SELECT publication_key, event_type, severity, target, message, details_json, created_at FROM publication_events ORDER BY id",
        )
        .unwrap();
    statement
        .query_map([], |row| {
            Ok(json!({
                "publication_key": row.get::<_, Option<String>>(0)?,
                "event_type": row.get::<_, String>(1)?,
                "severity": row.get::<_, String>(2)?,
                "target": row.get::<_, Option<String>>(3)?,
                "message": row.get::<_, String>(4)?,
                "details_json": row.get::<_, Option<String>>(5)?,
                "created_at": row.get::<_, String>(6)?,
            }))
        })
        .unwrap()
        .map(Result::unwrap)
        .collect()
}

async fn replay(case: &Value, base: &Path) -> (Vec<Value>, Vec<Value>) {
    let name = case["name"].as_str().unwrap();
    let slug: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let data_dir = base.join(slug);
    fs::create_dir_all(&data_dir).unwrap();
    let db_path = data_dir.join("pipeline.db");
    let db = BackendDb::open(&db_path).unwrap();
    let config = load_config([
        ("DATA_DIR", data_dir.to_str().unwrap()),
        ("PUBLIC_BASE_URL", "https://studio.example.com"),
    ])
    .unwrap();
    let external = Connection::open(&db_path).unwrap();
    external.busy_timeout(Duration::from_secs(5)).unwrap();
    let clock = FixedClock(Cell::new(instant(T0)));
    let site = PublicSite::new();
    let run = Run {
        db: &db,
        external: &external,
        config: &config,
        clock: &clock,
        site: &site,
        previous: Cell::new(None),
    };
    let results = std::cell::RefCell::new(Vec::new());
    for step in case["steps"].as_array().unwrap() {
        run.step(step, &results).await;
    }
    (results.into_inner(), events(&db))
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn public_site_matches_typescript_goldens() {
    let goldens: Value =
        serde_json::from_str(&fs::read_to_string(repo_root().join("parity/public-site/goldens.json")).unwrap())
            .unwrap();
    let base = repo_root().join("_trash-rust/tmp/public-site-goldens-rust");
    let _ = fs::remove_dir_all(&base);
    let cases = goldens["cases"].as_array().unwrap();
    assert!(!cases.is_empty());
    let mut failures = Vec::new();
    let mut compared = 0;
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let (results, events) = replay(case, &base).await;
        let expected = case["results"].as_array().unwrap();
        assert_eq!(expected.len(), results.len(), "{name}: response count");
        for (index, (left, right)) in expected.iter().zip(&results).enumerate() {
            compared += 1;
            if left != right {
                failures.push(format!("{name}, response #{index}:\n  ts:   {left}\n  rust: {right}"));
            }
        }
        if case["events"].as_array().unwrap() != &events {
            failures.push(format!(
                "{name}, events:\n  ts:   {}\n  rust: {:?}",
                case["events"], events
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {compared} differ:\n{}",
        failures.len(),
        failures.join("\n")
    );
}
