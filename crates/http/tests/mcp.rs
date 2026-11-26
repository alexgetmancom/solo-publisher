//! The MCP transport (`GET`/`POST /api/mcp`) through the router with
//! `oneshot`, against what the Hono app answered (`parity/ops/http.json`,
//! recorded before the cutover): status, every header, and the body —
//! for the SSE stream its first event, with the connection id as `$UUID`.

use std::cell::Cell;
use std::path::{Path, PathBuf};
use std::rc::Rc;

use axum::body::Body;
use axum::http::Request;
use db::BackendDb;
use domain::application::ports::{ChannelConnectionRecord, Clock, FixedClock};
use domain::observability::usage::UsageRecorder;
use domain::publishing::Publishing;
use domain::studio::Studio;
use domain::studio::services::channels::{ChannelInput, ChannelService};
use foundation::config::{Config, SharedConfig, load_config};
use http_body_util::BodyExt as _;
use http_edge::{Backend, HttpState, router};
use ops::host::OpsHost;
use providers::channels::entropy::{Entropy, OsEntropy};
use providers::channels::oauth_routes::ChannelRegistrar;
use runtime::http::{HttpClient, ReqwestTransport};
use serde_json::{Map, Value};
use tower::ServiceExt as _;

struct TestBackend {
    db: BackendDb,
    clock: Rc<FixedClock>,
    config: SharedConfig,
    host: OpsHost,
    usage: UsageRecorder<Rc<dyn Clock>>,
    http: HttpClient,
}

impl Backend for TestBackend {
    fn db(&self) -> &BackendDb {
        &self.db
    }
    fn clock(&self) -> &dyn Clock {
        &*self.clock
    }
    fn config(&self) -> &SharedConfig {
        &self.config
    }
    fn studio<'a>(&'a self, config: &'a Config) -> Studio<'a> {
        Studio::new(
            Publishing::new(db::unsafe_db(&self.db), &*self.clock, self.host.publishing(&self.usage)),
            config,
            self.host.studio(),
        )
    }
    fn http(&self) -> &HttpClient {
        &self.http
    }
    fn entropy(&self) -> &dyn Entropy {
        &OsEntropy
    }
}

impl ChannelRegistrar for TestBackend {
    fn connect(&self, input: &ChannelInput) -> domain::Result<ChannelConnectionRecord> {
        let config = self.config.load();
        ChannelService::new(self.studio(&config), &self.host.adapters).connect(input, None)
    }
}

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

#[test]
fn mcp_transport_matches_typescript() {
    let goldens: Vec<Value> =
        serde_json::from_str(&std::fs::read_to_string(repo().join("parity/ops/http.json")).unwrap()).unwrap();
    let dir = repo().join(format!("_trash-rust/tmp/http-mcp-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let env = [
        ("DATA_DIR", dir.display().to_string()),
        ("PUBLIC_BASE_URL", "https://studio.example.com/".into()),
        ("MCP_STUDIO_TOKEN", "studio-token-for-tests-0001".into()),
        ("MCP_STUDIO_ACTOR_ID", "7".into()),
    ];
    let config = SharedConfig::new(load_config(env.iter().map(|(k, v)| (*k, v.as_str()))).unwrap());
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let local = tokio::task::LocalSet::new();
    let mut failures = Vec::new();
    local.block_on(&runtime, async {
        let clock = Rc::new(FixedClock(Cell::new(
            foundation::time::parse_iso_instant("2026-11-01T10:00:00Z").unwrap(),
        )));
        let http = HttpClient::new(Rc::new(ReqwestTransport::new().unwrap()));
        let backend = TestBackend {
            db: BackendDb::open(dir.join("pipeline.db")).unwrap(),
            host: OpsHost::new(config.clone(), clock.clone(), http.clone()),
            http,
            usage: UsageRecorder::new(clock.clone() as Rc<dyn Clock>),
            clock,
            config,
        };
        let app = router(HttpState::new(Rc::new(backend)));
        for golden in &goldens {
            let request = &golden["request"];
            let mut builder = Request::builder()
                .method(request["method"].as_str().unwrap_or("GET"))
                .uri(request["target"].as_str().unwrap());
            for header in request["headers"].as_array().into_iter().flatten() {
                builder = builder.header(header[0].as_str().unwrap(), header[1].as_str().unwrap());
            }
            let body = request["body"]
                .as_str()
                .map_or_else(Body::empty, |text| Body::from(text.to_owned()));
            let response = app.clone().oneshot(builder.body(body).unwrap()).await.unwrap();
            let status = response.status().as_u16();
            let mut headers: Vec<(String, String)> = response
                .headers()
                .iter()
                .filter(|(name, _)| *name != "content-length")
                .map(|(name, value)| (name.to_string(), value.to_str().unwrap().to_owned()))
                .collect();
            headers.sort();
            let headers: Map<String, Value> = headers.into_iter().map(|(k, v)| (k, Value::from(v))).collect();
            let streaming = response
                .headers()
                .get("content-type")
                .is_some_and(|v| v == "text/event-stream");
            let mut body = response.into_body();
            let text = if streaming {
                let frame = body.frame().await.unwrap().unwrap().into_data().unwrap();
                let text = String::from_utf8(frame.to_vec()).unwrap();
                match text.find("connection_id=") {
                    Some(at) => {
                        let id = at + "connection_id=".len();
                        format!("{}$UUID{}", &text[..id], &text[(id + 36).min(text.len())..])
                    }
                    None => text,
                }
            } else {
                String::from_utf8(body.collect().await.unwrap().to_bytes().to_vec()).unwrap()
            };
            let want_body = golden["body"].as_str().unwrap_or_default();
            if status != golden["status"].as_u64().unwrap() as u16
                || Value::Object(headers.clone()) != golden["headers"]
                || text != want_body
            {
                failures.push(format!(
                    "{} {}: {status} {headers:?} {text:?}\n  want {} {} {want_body:?}",
                    request["method"].as_str().unwrap_or("GET"),
                    request["target"],
                    golden["status"],
                    golden["headers"]
                ));
            }
        }
    });
    let _ = std::fs::remove_dir_all(&dir);
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
