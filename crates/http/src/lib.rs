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
mod mcp;
mod media_upload;
mod mime;
mod ranged_file;
mod response;
mod server;
mod site;
mod studio;
mod uri;

use std::cell::Cell;
use std::rc::Rc;
use std::sync::Arc;

use axum::Router;
use db::BackendDb;
use domain::application::ports::Clock;
use domain::publishing::Publishing;
use domain::studio::Studio;
use foundation::config::Config;

pub use auth::{command_allowed, mcp_studio_actor};
pub use client_identity::client_ip_hash;
pub use local::{Gone, Local};
pub use media_upload::{MediaUploadError, stream_upload_to_file};
pub use response::{HandlerError, HandlerResult};
pub use server::{IDLE_TIMEOUT, MAX_REQUEST_BODY_BYTES, serve};
pub use uri::Target;

/// What the routes reach through the process. In the Studio that is the bot,
/// which owns the database, the clock, the live configuration and the host's
/// boundaries; tests supply their own.
pub trait Backend {
    fn db(&self) -> &BackendDb;
    fn clock(&self) -> &dyn Clock;
    /// The live configuration (stored credentials are re-applied onto it).
    fn config(&self) -> Arc<Config>;
    /// A Studio handle over `config`, for the routes that drive Studio services.
    fn studio<'a>(&'a self, config: &'a Config) -> Studio<'a>;
}

impl Backend for bot::Bot {
    fn db(&self) -> &BackendDb {
        &self.deps().db
    }

    fn clock(&self) -> &dyn Clock {
        &*self.deps().clock
    }

    fn config(&self) -> Arc<Config> {
        self.deps().config.load()
    }

    fn studio<'a>(&'a self, config: &'a Config) -> Studio<'a> {
        let deps = self.deps();
        Studio::new(
            Publishing::new(db::unsafe_db(&deps.db), &*deps.clock, deps.host.publishing()),
            config,
            deps.host.studio(),
        )
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
/// (`.merge(oauth::routes())`, `.merge(mcp::routes())`); until then its paths
/// are unknown routes like any other.
fn routes() -> Router<Local> {
    Router::new()
        .merge(health::routes())
        .merge(studio::routes())
        .merge(site::routes())
        .merge(discovery::routes())
        .merge(mcp::routes())
}

/// The whole HTTP surface (`buildApp`). Starts the local executor, so it must
/// be called inside the process's `LocalSet`; requests are answered while
/// that `LocalSet` runs.
pub fn router(state: HttpState) -> Router {
    edge::wrap(routes(), Local::start(state))
}
