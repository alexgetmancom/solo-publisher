//! Connecting an account from the browser:
//! the routes of `channels::oauth_routes`, each answered on the Studio thread
//! with the query as Hono reads it and the command-token verdict. The
//! `/oauth/*` headers are the edge's (`edge.rs`).

use axum::Extension;
use axum::Router;
use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{HeaderName, HeaderValue, StatusCode};
use axum::response::Response;
use axum::routing::{MethodRouter, get};
use channels::meta::meta_platform_name;
use channels::oauth_routes::{
    OauthContext, OauthResponse, Query, meta_callback, meta_start, x_callback, x_start, youtube_callback, youtube_start,
};
use domain::studio::boundaries::MetaOauthPlatform;

use crate::auth::command_allowed;
use crate::local::Local;
use crate::response::{HandlerResult, on_local};
use crate::uri::Target;

#[derive(Clone, Copy)]
enum Route {
    MetaStart(MetaOauthPlatform),
    MetaCallback(MetaOauthPlatform),
    XStart,
    XCallback,
    YoutubeStart,
    YoutubeCallback,
}

pub(crate) fn routes() -> Router<Local> {
    let mut router = Router::new()
        .route("/oauth/x/start", mount(Route::XStart))
        .route("/oauth/x", mount(Route::XCallback))
        .route("/oauth/youtube/start", mount(Route::YoutubeStart))
        .route("/oauth/youtube", mount(Route::YoutubeCallback));
    for platform in [MetaOauthPlatform::Threads, MetaOauthPlatform::Instagram] {
        let name = meta_platform_name(platform);
        router = router
            .route(&format!("/oauth/{name}/start"), mount(Route::MetaStart(platform)))
            .route(&format!("/oauth/{name}"), mount(Route::MetaCallback(platform)));
    }
    router
}

fn mount(route: Route) -> MethodRouter<Local> {
    get(
        move |State(local): State<Local>, Extension(target): Extension<Target>, request: Request| async move {
            let (parts, _) = request.into_parts();
            on_local(&local, move |state| async move {
                let backend = &*state.backend;
                let pairs = target.hono_query();
                let query = Query(&pairs);
                let allowed = || {
                    command_allowed(
                        &parts.method,
                        &parts.uri,
                        &parts.headers,
                        &backend.config().load(),
                        None,
                    )
                };
                let context = OauthContext {
                    config: backend.config(),
                    sqlite: db::unsafe_db(backend.db()),
                    http: backend.http(),
                    clock: backend.clock(),
                    entropy: backend.entropy(),
                    channels: backend,
                };
                let answer = match route {
                    Route::MetaStart(platform) => meta_start(context, platform, query, allowed()),
                    Route::MetaCallback(platform) => meta_callback(context, platform, query).await,
                    Route::XStart => x_start(context, allowed()),
                    Route::XCallback => x_callback(context, query).await,
                    Route::YoutubeStart => youtube_start(context, query, allowed()),
                    Route::YoutubeCallback => youtube_callback(context, query).await,
                };
                respond(answer)
            })
            .await
        },
    )
}

fn respond(answer: OauthResponse) -> HandlerResult {
    let mut response = Response::new(answer.body.map_or_else(Body::empty, Body::from));
    *response.status_mut() = StatusCode::from_u16(answer.status)?;
    for (name, value) in answer.headers {
        response
            .headers_mut()
            .insert(HeaderName::from_static(name), HeaderValue::from_str(&value)?);
    }
    Ok(response)
}
