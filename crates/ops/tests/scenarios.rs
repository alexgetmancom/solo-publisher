//! Every case of `tests/scenarios/<area>.json` replayed against the goldens
//! recorded in `parity/ops/scenarios/<area>.json`: the same steps on a fresh database and
//! DATA_DIR under the same fixed clock, every step as its own process, the
//! same canned HTTP answers. Compared: every step's output (key order
//! included), every request, every table and every file.
//!
//! `OPS_SCENARIOS=area[,area…]` limits the run to those specs.

use std::cell::{Cell, RefCell};
use std::path::{Path, PathBuf};
use std::rc::Rc;

use db::rusqlite::types::ValueRef;
use domain::application::ports::Clock;
use jiff::Timestamp;
use ops::cli::{CliRun, CliSurface, run_cli};
use ops::context::{OpError, OperationContext, Terminal};
use ops::host::ProcessSurface;
use ops::mcp::McpServer;
use ops::registry::run_operation;
use runtime::http::{Fut, HttpClient, HttpRequest, HttpResponse, Transport, TransportFailure};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

fn repo() -> PathBuf {
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

fn instant(text: &str) -> Timestamp {
    foundation::time::parse_iso_instant(text).unwrap()
}

/// Canned answers, each served once to the first request with its method and URL.
struct Canned {
    responses: RefCell<Vec<Value>>,
    requests: RefCell<Vec<Value>>,
}

impl Transport for Canned {
    fn send(&self, request: HttpRequest) -> Fut<'_, Result<HttpResponse, TransportFailure>> {
        Box::pin(async move {
            let url = url::Url::parse(&request.url).map_or(request.url.clone(), |url| url.to_string());
            let mut headers: Vec<(String, String)> = request
                .headers
                .iter()
                .map(|(name, value)| (name.to_lowercase(), value.clone()))
                .collect();
            headers.sort();
            let headers: Map<String, Value> = headers.into_iter().map(|(k, v)| (k, Value::from(v))).collect();
            let body = match request.body.as_bytes() {
                Some(bytes) if bytes.is_empty() => Value::Null,
                Some(bytes) => Value::from(String::from_utf8_lossy(&bytes).into_owned()),
                None => Value::from("<file>"),
            };
            let method = request.method.as_str();
            self.requests
                .borrow_mut()
                .push(json!({"method": method, "url": url, "headers": headers, "body": body}));
            let mut responses = self.responses.borrow_mut();
            let index = responses
                .iter()
                .position(|canned| canned["method"].as_str().unwrap_or("GET") == method && canned["url"] == url);
            let Some(index) = index else {
                return Err(TransportFailure {
                    message: "fetch failed".into(),
                    timed_out: false,
                });
            };
            let canned = responses.remove(index);
            let payload = match &canned["json"] {
                Value::Null => canned["body"].as_str().unwrap_or_default().to_owned(),
                json => serde_json::to_string(json).unwrap(),
            };
            let headers = canned["headers"]
                .as_object()
                .map(|headers| {
                    headers
                        .iter()
                        .map(|(k, v)| (k.clone(), v.as_str().unwrap_or_default().to_owned()))
                        .collect()
                })
                .unwrap_or_default();
            Ok(HttpResponse::buffered(
                canned["status"].as_u64().unwrap_or(200) as u16,
                headers,
                payload,
            ))
        })
    }
}

/// A terminal whose stdout is kept and whose stdin is the step's.
struct Captured {
    stdout: RefCell<Vec<u8>>,
    stdin: Option<String>,
}

impl Terminal for Captured {
    fn write(&self, bytes: &[u8]) -> std::io::Result<()> {
        self.stdout.borrow_mut().extend_from_slice(bytes);
        Ok(())
    }
    fn stdout_is_tty(&self) -> bool {
        false
    }
    fn child_stdout(&self) -> std::io::Result<std::process::Stdio> {
        Ok(std::process::Stdio::null())
    }
    fn read_stdin(&self) -> std::io::Result<String> {
        Ok(self.stdin.clone().unwrap_or_default())
    }
    fn ask(&self, _question: &str) -> String {
        String::new()
    }
}

fn dump(sqlite: &db::rusqlite::Connection, ignored: &[String]) -> Map<String, Value> {
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
            out.insert(table, json!(rows));
        }
    }
    out
}

fn rows(sqlite: &db::rusqlite::Connection, sql: &str) -> Value {
    let mut statement = sqlite.prepare(sql).unwrap();
    let names: Vec<String> = statement.column_names().map(str::to_owned).collect();
    let mut out = Vec::new();
    let mut cursor = statement.query([]).unwrap();
    while let Some(row) = cursor.next().unwrap() {
        let mut record = Map::new();
        for (index, name) in names.iter().enumerate() {
            let value = match row.get_ref(index).unwrap() {
                ValueRef::Null => Value::Null,
                ValueRef::Integer(n) => json!(n),
                ValueRef::Real(f) => foundation::js::json_number(f),
                ValueRef::Text(text) => Value::from(String::from_utf8_lossy(text).into_owned()),
                ValueRef::Blob(_) => Value::from("<blob>"),
            };
            record.insert(name.clone(), value);
        }
        out.push(Value::Object(record));
    }
    Value::Array(out)
}

/// The `Lavc<version>` comment libavcodec's JPEG encoder writes right after
/// SOI differs between ffmpeg builds while the pixels do not, so neither side
/// compares it.
fn without_encoder_comment(bytes: Vec<u8>) -> Vec<u8> {
    if bytes.len() < 10 || bytes[..4] != [0xff, 0xd8, 0xff, 0xfe] || &bytes[6..10] != b"Lavc" {
        return bytes;
    }
    let end = 4 + usize::from(u16::from_be_bytes([bytes[4], bytes[5]]));
    [&bytes[..2], &bytes[end.min(bytes.len())..]].concat()
}

fn files(root: &Path) -> Map<String, Value> {
    fn walk(root: &Path, dir: &Path, out: &mut Vec<(String, Value)>) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        let mut entries: Vec<_> = entries.flatten().collect();
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let path = entry.path();
            let kind = entry.file_type().unwrap();
            if kind.is_dir() {
                walk(root, &path, out);
            } else if kind.is_file() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if [
                    "pipeline.db",
                    "pipeline.db-wal",
                    "pipeline.db-shm",
                    "pipeline.db-journal",
                ]
                .contains(&name.as_str())
                {
                    continue;
                }
                let bytes = without_encoder_comment(std::fs::read(&path).unwrap());
                let relative = path.strip_prefix(root).unwrap().display().to_string();
                out.push((
                    relative,
                    json!({"bytes": bytes.len(), "sha256": format!("{:x}", Sha256::digest(&bytes))}),
                ));
            }
        }
    }
    let mut out = Vec::new();
    walk(root, root, &mut out);
    out.into_iter().collect()
}

struct Case<'a> {
    dir: PathBuf,
    vars: Vec<(String, String)>,
    clock: Rc<FixedClock>,
    http: HttpClient,
    cwd: PathBuf,
    _spec: &'a Value,
}

impl Case<'_> {
    fn db_path(&self) -> PathBuf {
        self.dir.join("data/pipeline.db")
    }

    fn surface(&self) -> ProcessSurface {
        ProcessSurface::new(
            &self.db_path(),
            self.vars.clone(),
            self.clock.clone(),
            self.http.clone(),
        )
    }

    fn env(&self) -> impl Fn(&str) -> Option<String> + '_ {
        |name: &str| {
            self.vars
                .iter()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value.clone())
        }
    }

    fn sqlite<T>(&self, work: impl FnOnce(&db::rusqlite::Connection) -> T) -> T {
        let surface = Box::new(self.surface());
        let result = {
            let db = ops::context::Surface::db(&*surface).unwrap();
            work(db::unsafe_db(db))
        };
        surface.finish();
        result
    }

    async fn step(&self, step: &Value) -> Option<Value> {
        if let Some(at) = step["clock"].as_str() {
            self.clock.0.set(instant(at));
            return None;
        }
        if let Some(target) = step["write"].as_str() {
            let target = self.dir.join(target);
            std::fs::create_dir_all(target.parent().unwrap()).unwrap();
            let bytes = match step["base64"].as_str() {
                Some(encoded) => base64::Engine::decode(&base64::engine::general_purpose::STANDARD, encoded).unwrap(),
                None => step["text"].as_str().unwrap_or_default().as_bytes().to_vec(),
            };
            std::fs::write(target, bytes).unwrap();
            return None;
        }
        if let Some(sql) = step["sql"].as_str() {
            self.sqlite(|sqlite| sqlite.execute_batch(sql).unwrap());
            return None;
        }
        if let Some(sql) = step["query"].as_str() {
            return Some(json!({"rows": self.sqlite(|sqlite| rows(sqlite, sql))}));
        }
        let env = self.env();
        if let Some(name) = step["op"].as_str() {
            let surface = Box::new(self.surface());
            let terminal = Captured {
                stdout: RefCell::new(Vec::new()),
                stdin: step["stdin"].as_str().map(str::to_owned),
            };
            let result = {
                let context = OperationContext {
                    db_path: self.db_path(),
                    actor_type: if step["actor"] == "ops-cli" {
                        "ops-cli"
                    } else {
                        "ops-mcp"
                    },
                    http: self.http.clone(),
                    clock: &*self.clock,
                    env: &env,
                    cwd: self.cwd.clone(),
                    terminal: (step["actor"] == "ops-cli").then_some(&terminal as &dyn Terminal),
                    surface: &*surface,
                };
                let args = if step["args"].is_null() {
                    json!({})
                } else {
                    step["args"].clone()
                };
                run_operation(name, &context, &args).await
            };
            surface.finish();
            return Some(match result {
                Ok(value) => json!({"result": value}),
                Err(OpError::Input(message)) => json!({"error": {"input": true, "message": message}}),
                Err(OpError::Failed(message)) => json!({"error": {"input": false, "message": message}}),
            });
        }
        if let Some(argv) = step["cli"].as_array() {
            let argv: Vec<String> = argv.iter().map(|arg| arg.as_str().unwrap().to_owned()).collect();
            let terminal = Captured {
                stdout: RefCell::new(Vec::new()),
                stdin: step["stdin"].as_str().map(str::to_owned),
            };
            let surface = |_: &Path| -> Box<dyn CliSurface> { Box::new(self.surface()) };
            let run = CliRun {
                env: &env,
                cwd: self.cwd.clone(),
                clock: &*self.clock,
                http: self.http.clone(),
                terminal: &terminal,
                surface: &surface,
            };
            let outcome = run_cli(&argv, &run).await;
            let stdout = String::from_utf8_lossy(&terminal.stdout.borrow()).into_owned();
            return Some(json!({"stdout": stdout, "stderr": outcome.stderr, "code": outcome.code}));
        }
        if !step["mcp"].is_null() || step.get("mcp").is_some() {
            let surface = Box::new(self.surface());
            let response = {
                let server = McpServer {
                    surface: &*surface,
                    clock: &*self.clock,
                    http: self.http.clone(),
                    env: &env,
                    cwd: self.cwd.clone(),
                };
                let actor = match step.get("actorId") {
                    None => Some(42),
                    Some(Value::Null) => None,
                    Some(id) => id.as_i64(),
                };
                server
                    .respond(&step["mcp"], step["client"].as_str().unwrap_or("client"), actor)
                    .await
            };
            surface.finish();
            return Some(json!({"response": response}));
        }
        panic!("unknown step {step}");
    }
}

fn compact(value: &Value) -> String {
    serde_json::to_string(value).unwrap()
}

fn first_difference(rust: &str, want: &str) -> String {
    let at = rust.chars().zip(want.chars()).take_while(|(a, b)| a == b).count();
    let window = |text: &str| text.chars().skip(at.saturating_sub(60)).take(220).collect::<String>();
    format!(
        "at char {at}\n      rust: {}\n      want: {}",
        window(rust),
        window(want)
    )
}

async fn run_spec(area: &str, spec: &Value, goldens: &[Value], scratch: &Path) -> Vec<String> {
    let mut failures = Vec::new();
    for (index, (case, golden)) in spec["cases"].as_array().unwrap().iter().zip(goldens).enumerate() {
        let dir = scratch.join(area).join(index.to_string());
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("data")).unwrap();
        let dir = dir.canonicalize().unwrap();
        let mut vars: Vec<(String, String)> = Vec::new();
        for source in [&spec["env"], &case["env"]] {
            for (key, value) in source.as_object().into_iter().flatten() {
                vars.retain(|(existing, _)| existing != key);
                vars.push((key.clone(), value.as_str().unwrap().to_owned()));
            }
        }
        vars.retain(|(key, _)| key != "DATA_DIR");
        vars.push(("DATA_DIR".into(), dir.join("data").display().to_string()));
        let transport = Rc::new(Canned {
            responses: RefCell::new(
                serde_json::from_str::<Value>(
                    &compact(&case["responses"]).replace("$CASE", &dir.display().to_string()),
                )
                .unwrap()
                .as_array()
                .cloned()
                .unwrap_or_default(),
            ),
            requests: RefCell::new(Vec::new()),
        });
        let case_run = Case {
            dir: dir.clone(),
            vars,
            clock: Rc::new(FixedClock(Cell::new(instant(spec["clock"].as_str().unwrap())))),
            http: HttpClient::new(transport.clone()),
            cwd: repo(),
            _spec: spec,
        };
        {
            let db = db::BackendDb::open(case_run.db_path()).unwrap();
            for sql in spec["setup"].as_array().into_iter().flatten() {
                db::unsafe_db(&db).execute_batch(sql.as_str().unwrap()).unwrap();
            }
            db.close().unwrap();
        }
        let name = case["name"].as_str().unwrap();
        let patterns: Vec<(regex::Regex, String)> = spec["normalize"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|pair| {
                (
                    regex::Regex::new(pair[0].as_str().unwrap()).unwrap(),
                    pair[1].as_str().unwrap().replace('$', "$$"),
                )
            })
            .collect();
        let normalize = |value: &Value| {
            let mut text = compact(value).replace(&dir.display().to_string(), "$CASE");
            for (pattern, replacement) in &patterns {
                text = pattern.replace_all(&text, replacement.as_str()).into_owned();
            }
            text
        };
        let mut problems = Vec::new();
        let mut outputs = Vec::new();
        // `$CASE` in a step (a path in SQL, an argument, a canned body) is the case directory.
        let steps: Value =
            serde_json::from_str(&compact(&case["steps"]).replace("$CASE", &dir.display().to_string())).unwrap();
        for step in steps.as_array().unwrap() {
            if let Some(output) = case_run.step(step).await {
                outputs.push(output);
            }
        }
        for (position, (rust, want)) in outputs.iter().zip(golden["outputs"].as_array().unwrap()).enumerate() {
            let (rust, want) = (normalize(rust), compact(want));
            if rust != want {
                problems.push(format!("    output {position} {}", first_difference(&rust, &want)));
            }
        }
        if outputs.len() != golden["outputs"].as_array().unwrap().len() {
            problems.push("    output count differs".into());
        }
        let ignored: Vec<String> = ["runtime_usage".to_owned()]
            .into_iter()
            .chain(
                spec["ignoredTables"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|table| table.as_str().unwrap().to_owned()),
            )
            .collect();
        let tables = Value::Object(case_run.sqlite(|sqlite| dump(sqlite, &ignored)));
        let checks = [
            (
                "requests",
                Value::Array(transport.requests.borrow().clone()),
                &golden["requests"],
            ),
            ("tables", tables, &golden["tables"]),
            ("files", Value::Object(files(&dir)), &golden["files"]),
        ];
        for (what, rust, want) in checks {
            let (rust, want) = (normalize(&rust), compact(want));
            if rust != want {
                problems.push(format!("    {what} {}", first_difference(&rust, &want)));
            }
        }
        if problems.is_empty() {
            println!("PASS {area} / {name}");
        } else {
            println!("FAIL {area} / {name}");
            failures.push(format!("{area} / {name}\n{}", problems.join("\n")));
        }
    }
    failures
}

#[test]
fn scenarios() {
    let only: Vec<String> = std::env::var("OPS_SCENARIOS")
        .map(|value| value.split(',').map(str::to_owned).collect())
        .unwrap_or_default();
    let specs = repo().join("crates/ops/tests/scenarios");
    let mut areas: Vec<String> = std::fs::read_dir(&specs)
        .unwrap()
        .flatten()
        .filter_map(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .strip_suffix(".json")
                .map(str::to_owned)
        })
        .filter(|area| only.is_empty() || only.contains(area))
        .collect();
    areas.sort();
    let scratch = repo().join(format!("_trash-rust/tmp/ops-scenarios-rs-{}", std::process::id()));
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let local = tokio::task::LocalSet::new();
    let mut failures = Vec::new();
    for area in &areas {
        let spec: Value =
            serde_json::from_str(&std::fs::read_to_string(specs.join(format!("{area}.json"))).unwrap()).unwrap();
        let golden_path = repo().join(format!("parity/ops/scenarios/{area}.json"));
        let goldens: Vec<Value> = serde_json::from_str(
            &std::fs::read_to_string(&golden_path)
                .unwrap_or_else(|_| panic!("{} is missing: every area has a recorded golden", golden_path.display())),
        )
        .unwrap();
        assert_eq!(
            spec["cases"].as_array().unwrap().len(),
            goldens.len(),
            "{area}: the goldens are stale; re-record them"
        );
        failures.extend(local.block_on(&runtime, run_spec(area, &spec, &goldens, &scratch)));
    }
    let _ = std::fs::remove_dir_all(&scratch);
    assert!(
        failures.is_empty(),
        "{} cases differ:\n{}",
        failures.len(),
        failures.join("\n")
    );
}
