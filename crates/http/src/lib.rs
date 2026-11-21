//! The Studio's HTTP edge (`apps/backend/src/api.ts`, `interfaces/http/*`,
//! `foundation/http-*.ts`, `ranged-file.ts`, `client-identity.ts`) on axum.
//!
//! The process is single-threaded and its state is `Rc` (the bot owns the
//! database), while axum's handlers and router must be `Send`. Routing,
//! extraction and the connection loop stay on axum/hyper; the body of every
//! route that touches Studio state runs on the process's `LocalSet` through
//! [`Local`], which hands it the [`HttpState`] and sends the response back.

mod auth;
mod client_identity;
mod discovery;
mod edge;
mod headers;
mod health;
mod local;
mod media_upload;
mod mime;
mod oauth;
mod ranged_file;
mod response;
mod server;
mod site;
mod studio;
mod uri;

use std::cell::Cell;
use std::rc::Rc;

use axum::Router;
use channels::entropy::{Entropy, OsEntropy};
use channels::oauth_routes::ChannelRegistrar;
use db::BackendDb;
use domain::application::ports::{ChannelConnectionRecord, Clock};
use domain::publishing::Publishing;
use domain::studio::Studio;
use domain::studio::services::channels::{ChannelInput, ChannelService};
use foundation::config::{Config, SharedConfig};
use runtime::http::HttpClient;

pub use auth::{command_allowed, mcp_studio_actor};
pub use client_identity::client_ip_hash;
pub use local::{Gone, Local};
pub use media_upload::{MediaUploadError, stream_upload_to_file};
pub use response::{HandlerError, HandlerResult};
pub use server::{IDLE_TIMEOUT, MAX_REQUEST_BODY_BYTES, serve};
pub use uri::Target;

/// What the routes reach through the process: in the Studio, the bot (which
/// owns the database, the clock, the live configuration and the host's
/// boundaries) and the HTTP client; tests supply their own. Registering a
/// channel is how an OAuth callback ends (`studio.channels.connect`).
pub trait Backend: ChannelRegistrar {
    fn db(&self) -> &BackendDb;
    fn clock(&self) -> &dyn Clock;
    /// The live configuration: stored credentials are re-applied onto it, and
    /// an OAuth callback swaps in the credentials it connected.
    fn config(&self) -> &SharedConfig;
    /// A Studio handle over `config`, for the routes that drive Studio services.
    fn studio<'a>(&'a self, config: &'a Config) -> Studio<'a>;
    /// What the OAuth callbacks exchange their codes through.
    fn http(&self) -> &HttpClient;
    /// Where OAuth nonces and PKCE verifiers come from.
    fn entropy(&self) -> &dyn Entropy;
}

/// The Studio process as the routes reach it.
pub struct BotBackend {
    pub bot: bot::Bot,
    pub http: HttpClient,
}

impl Backend for BotBackend {
    fn db(&self) -> &BackendDb {
        &self.bot.deps().db
    }

    fn clock(&self) -> &dyn Clock {
        &*self.bot.deps().clock
    }

    fn config(&self) -> &SharedConfig {
        &self.bot.deps().config
    }

    fn studio<'a>(&'a self, config: &'a Config) -> Studio<'a> {
        let deps = self.bot.deps();
        Studio::new(
            Publishing::new(db::unsafe_db(&deps.db), &*deps.clock, deps.host.publishing()),
            config,
            deps.host.studio(),
        )
    }

    fn http(&self) -> &HttpClient {
        &self.http
    }

    fn entropy(&self) -> &dyn Entropy {
        &OsEntropy
    }
}

impl ChannelRegistrar for BotBackend {
    fn connect(&self, input: &ChannelInput) -> domain::Result<ChannelConnectionRecord> {
        let config = self.config().load();
        ChannelService::new(self.studio(&config), &self.bot.deps().adapters).connect(input, None)
    }
}

/// Everything the routes share for the life of the process (the module-level
/// state of the TypeScript route files): the backend, the public site's read
/// model and caches, and the count of uploads in flight.
pub struct HttpState {
    pub backend: Rc<dyn Backend>,
    pub(crate) site: public_site::PublicSite,
    pub(crate) active_uploads: Cell<usize>,
}

impl HttpState {
    pub fn new(backend: Rc<dyn Backend>) -> Self {
        Self {
            backend,
            site: public_site::PublicSite::new(),
            active_uploads: Cell::new(0),
        }
    }
}

/// The route groups, each one call. A later slice adds its group here
/// (`.merge(mcp::routes())`); until then its paths are unknown routes like
/// any other.
fn routes() -> Router<Local> {
    Router::new()
        .merge(health::routes())
        .merge(oauth::routes())
        .merge(studio::routes())
        .merge(site::routes())
        .merge(discovery::routes())
}

/// The whole HTTP surface (`buildApp`). Starts the local executor, so it must
/// be called inside the process's `LocalSet`; requests are answered while
/// that `LocalSet` runs.
pub fn router(state: HttpState) -> Router {
    edge::wrap(routes(), Local::start(state))
}
