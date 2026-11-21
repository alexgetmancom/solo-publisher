//! What `buildApp` and Hono's dispatch do around every route: the target as
//! Hono reads it (`strict: false`), HEAD answered by the GET route without a
//! body, the operator surfaces kept out of indexes and shared caches, and
//! `404 "not found\n"` for any path or method no route takes.

use axum::Router;
use axum::body::Body;
use axum::extract::Request;
use axum::http::{Method, header};
use axum::middleware::{self, Next};
use axum::response::Response;

use crate::local::Local;
use crate::response::{not_found, set};
use crate::uri::Target;

pub(crate) fn wrap(routes: Router<Local>, local: Local) -> Router {
    let routes = routes
        .fallback(unknown)
        .method_not_allowed_fallback(unknown)
        .with_state(local);
    // The middleware must see the request before routing does, so it wraps
    // the routes as a service rather than as a route layer.
    Router::new().fallback_service(routes).layer(middleware::from_fn(edge))
}

async fn unknown() -> Response {
    not_found()
}

/// `/oauth/*`, `/stats` and `/stats/*` (Hono's `/x/*` also matches `/x`).
fn unindexed(path: &str) -> bool {
    ["/oauth", "/stats"].iter().any(|prefix| {
        path.strip_prefix(prefix)
            .is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
    })
}

async fn edge(mut request: Request, next: Next) -> Response {
    let target = Target::of(request.uri());
    let head = request.method() == Method::HEAD;
    let unindexed = unindexed(&target.path);
    *request.uri_mut() = target.routing_uri();
    request.extensions_mut().insert(target);
    let mut response = next.run(request).await;
    // Operator surfaces authenticate, but a crawler that indexes the login
    // screen turns a private page into a search result, and a shared cache
    // that kept one would serve one operator's screen to the next caller.
    if unindexed {
        set(&mut response, "x-robots-tag", "noindex, nofollow");
        set(&mut response, "cache-control", "no-store");
    }
    if head {
        *response.body_mut() = Body::empty();
    }
    // A method no route takes is an unknown route in Hono, without the
    // `Allow` axum adds; no route here sets one of its own.
    response.headers_mut().remove(header::ALLOW);
    response
}
