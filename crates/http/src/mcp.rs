//! The MCP transport (`GET`/`POST /api/mcp`):
//! JSON-RPC over POST, answered by `ops::mcp`, and a keep-alive SSE stream
//! whose only events are the `endpoint` and a `ping` every 30 seconds. Both
//! answer only the Studio bearer token (`mcp_studio_actor`).

use std::cell::OnceCell;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::{Request, State};
use axum::http::HeaderMap;
use axum::response::Response;
use axum::routing::get;
use bot::DynAdapters;
use db::BackendDb;
use domain::application::ports::{Clock as _, SystemClock};
use domain::publishing::boundaries::UsageMeter;
use domain::studio::Studio;
use foundation::config::Config;
use http_body::Frame;
use http_body_util::BodyExt as _;
use ops::context::{OpError, Surface};
use ops::host::OpsAdapters;
use ops::mcp::McpServer;
use runtime::http::HttpClient;
use serde_json::{Value, json};

use crate::auth::mcp_studio_actor;
use crate::client_identity::client_ip_hash;
use crate::local::Local;
use crate::response::{json_response, on_local, set, text, with_type};
use crate::{Backend, HttpState};

/// The SSE keep-alive interval.
const PING_INTERVAL: Duration = Duration::from_secs(30);

pub(crate) fn routes() -> Router<Local> {
    Router::new().route("/api/mcp", get(stream).post(call))
}

/// An unauthenticated stream would let any client pin a connection and a
/// timer for free, so the stream answers to the same authority as POST.
async fn stream(State(local): State<Local>, headers: HeaderMap) -> Response {
    on_local(&local, move |state| async move {
        let config = state.backend.config().load();
        if mcp_studio_actor(&headers, &config).is_none() {
            let mut denied = text("unauthorized\n", 401);
            let origin = config
                .public_base_url
                .strip_suffix('/')
                .unwrap_or(&config.public_base_url);
            set(
                &mut denied,
                "www-authenticate",
                &format!("Bearer resource_metadata=\"{origin}/.well-known/oauth-protected-resource\""),
            );
            return Ok(denied);
        }
        let endpoint = format!("/api/mcp?connection_id={}", domain::repositories::random_uuid());
        let mut response = with_type(
            Body::new(Events {
                first: Some(event("endpoint", &endpoint)),
                ping: tokio::time::interval_at((Instant::now() + PING_INTERVAL).into(), PING_INTERVAL),
            }),
            200,
            "text/event-stream",
        );
        set(&mut response, "cache-control", "no-cache");
        set(&mut response, "connection", "keep-alive");
        Ok(response)
    })
    .await
}

fn event(name: &str, data: &str) -> Bytes {
    Bytes::from(format!("event: {name}\ndata: {data}\n\n"))
}

/// The endpoint event, then a ping per interval until the client goes away.
struct Events {
    first: Option<Bytes>,
    ping: tokio::time::Interval,
}

impl http_body::Body for Events {
    type Data = Bytes;
    type Error = std::convert::Infallible;

    fn poll_frame(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Result<Frame<Bytes>, Self::Error>>> {
        if let Some(first) = self.first.take() {
            return Poll::Ready(Some(Ok(Frame::data(first))));
        }
        match self.ping.poll_tick(cx) {
            Poll::Ready(_) => {
                let now = foundation::time::to_iso_string(SystemClock.now());
                Poll::Ready(Some(Ok(Frame::data(event("ping", &now)))))
            }
            Poll::Pending => Poll::Pending,
        }
    }
}

async fn call(State(local): State<Local>, request: Request) -> Response {
    let (parts, body) = request.into_parts();
    let bytes = body.collect().await.map(|collected| collected.to_bytes());
    on_local(&local, move |state| async move {
        // `request.json()`: a body that is not JSON, or is `null`, is refused.
        let body: Option<Value> = bytes
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .filter(|body: &Value| !body.is_null());
        let Some(body) = body else {
            return Ok(json_response(
                &json!({"jsonrpc": "2.0", "id": null, "error": {"code": -32700, "message": "Invalid JSON"}}),
                200,
            ));
        };
        let config = state.backend.config().load();
        let actor = mcp_studio_actor(&parts.headers, &config);
        let client = client_ip_hash(&parts.headers, &config);
        let surface = BackendSurface::new(&state, config);
        let env = |name: &str| std::env::var(name).ok();
        let server = McpServer {
            surface: &surface,
            clock: state.backend.clock(),
            http: surface.http.clone(),
            env: &env,
            cwd: std::env::current_dir().unwrap_or_default(),
        };
        let started = Instant::now();
        let answer = server.respond(&body, &client, actor).await;
        // The request is counted whatever it answered.
        surface.usage().record(
            db::unsafe_db(state.backend.db()),
            "studio.mcp.request",
            true,
            started.elapsed().as_millis() as u64,
        );
        Ok(match answer {
            // A notification is answered by accepting it and nothing else.
            None => {
                let mut accepted = Response::new(Body::empty());
                *accepted.status_mut() = axum::http::StatusCode::ACCEPTED;
                accepted
            }
            Some(answer) => json_response(&answer, 200),
        })
    })
    .await
}

/// The server's database, configuration and boundaries, as an operation's surface.
struct BackendSurface<'a> {
    backend: &'a dyn Backend,
    config: Arc<Config>,
    http: HttpClient,
    adapters: OnceCell<DynAdapters>,
}

impl<'a> BackendSurface<'a> {
    fn new(state: &'a HttpState, config: Arc<Config>) -> Self {
        Self {
            backend: &*state.backend,
            config,
            http: state.backend.http().clone(),
            adapters: OnceCell::new(),
        }
    }
}

impl Surface for BackendSurface<'_> {
    fn db(&self) -> Result<&BackendDb, OpError> {
        Ok(self.backend.db())
    }

    fn config(&self) -> Result<Arc<Config>, OpError> {
        Ok(Arc::clone(&self.config))
    }

    fn studio<'s>(&'s self, config: &'s Config) -> Result<Studio<'s>, OpError> {
        Ok(self.backend.studio(config))
    }

    fn adapters(&self) -> Result<&DynAdapters, OpError> {
        Ok(self
            .adapters
            .get_or_init(|| OpsAdapters::boxed(self.http.clone(), self.backend.config().clone())))
    }

    fn usage(&self) -> &dyn UsageMeter {
        self.backend.studio(&self.config).publishing.boundaries.usage
    }
}
