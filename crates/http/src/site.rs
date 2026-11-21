//! What the public site reads from this Studio, and the files it links to
//! (`interfaces/http/public-site.ts`). The site is its own service with no
//! access to this Studio's database or disk: `GET /api/public/site` is
//! everything it renders (the `public_site` crate), and the proxy sends
//! `/media/*` and `/generated/responsive/media-*` here.
//!
//! A Studio with the site turned off still serves the staging media and the
//! video asset route: publishing platforms fetch from those either way.

use std::fs;
use std::path::Path;

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::Response;
use axum::routing::get;
use axum::{Extension, Router};
use content::site_media_naming::RESPONSIVE_WIDTHS;
use domain::application::ports::ApplicationPorts;
use domain::studio::config::studio_config;
use foundation::config::Config;
use public_site::paths::{join, resolve, versioned};
use public_site::{SiteRequest, public_video_asset};

use crate::HttpState;
use crate::headers::header;
use crate::local::Local;
use crate::mime::bun_file_type;
use crate::ranged_file::{file_body, ranged_file_response};
use crate::response::{HandlerError, HandlerResult, not_found, on_local, set, text};
use crate::uri::{Target, decode_uri_component, try_decode_uri_component};

const IMMUTABLE: &str = "public, max-age=31536000, immutable";

pub(crate) fn routes() -> Router<Local> {
    Router::new()
        .route("/api/public/site", get(site))
        .route("/media/video/asset/{id}", get(video_asset))
        .route("/media", get(media))
        .route("/media/{*path}", get(media))
        .route("/{file}", get(index_now))
        .route("/generated/responsive/{file}", get(responsive))
}

fn site_enabled(state: &HttpState) -> domain::Result<bool> {
    let backend = &*state.backend;
    studio_config(ApplicationPorts::new(backend.db(), backend.clock())).site_enabled()
}

/// The path segment after `prefix`, decoded as Hono decodes a parameter.
fn param(target: &Target, prefix: &str) -> String {
    try_decode_uri_component(target.path.strip_prefix(prefix).unwrap_or_default())
}

fn path_text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// `Bun.file(path)`: the size of a regular file there, `None` otherwise.
fn file_size(path: &str) -> Option<u64> {
    fs::metadata(path)
        .ok()
        .filter(fs::Metadata::is_file)
        .map(|meta| meta.len())
}

async fn site(State(local): State<Local>, headers: HeaderMap) -> Response {
    let if_none_match = header(&headers, "if-none-match");
    let prefer = header(&headers, "prefer");
    on_local(&local, move |state| async move {
        let backend = &*state.backend;
        let config = backend.config().load();
        let request = SiteRequest {
            if_none_match: if_none_match.as_deref(),
            prefer: prefer.as_deref(),
        };
        let answer = state
            .site
            .respond(backend.db(), &config, backend.clock(), request)
            .await?;
        let mut response = Response::new(answer.body.map_or_else(Body::empty, Body::from));
        *response.status_mut() = StatusCode::from_u16(answer.status)?;
        for (name, value) in &answer.headers {
            response.headers_mut().insert(*name, HeaderValue::from_str(value)?);
        }
        Ok(response)
    })
    .await
}

/// The video a platform importer fetches while it imports a Reel, addressed
/// by content hash: the asset id is a small integer and would expose every
/// unpublished upload. Always the whole file, and no `Accept-Ranges`: an
/// importer told ranges work that then gets a 200 for its `Range` does worse
/// than one never told.
async fn video_asset(State(local): State<Local>, Extension(target): Extension<Target>, method: Method) -> Response {
    on_local(&local, move |state| async move {
        let id = param(&target, "/media/video/asset/");
        if id.len() != 64 || !id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
            return Ok(not_found());
        }
        let Some(asset) = public_video_asset(state.backend.db(), &id)? else {
            return Ok(not_found());
        };
        let Some(size) = file_size(&asset.local_path).filter(|size| *size > 0) else {
            return Ok(not_found());
        };
        let body = if method == Method::HEAD {
            Body::empty()
        } else {
            file_body(Path::new(&asset.local_path), 0, size).await?
        };
        let mut response = Response::new(body);
        let content_type = asset.mime_type.filter(|mime| !mime.is_empty());
        response.headers_mut().insert(
            "content-type",
            HeaderValue::from_str(content_type.as_deref().unwrap_or("video/mp4"))?,
        );
        set(&mut response, "content-length", &size.to_string());
        set(&mut response, "cache-control", "public, max-age=300");
        set(&mut response, "x-robots-tag", "noindex, nofollow");
        Ok(response)
    })
    .await
}

/// `/media/staging/*` from the remote media path (even with the site off),
/// anything else from the site's media directory, ranges honoured.
async fn media(State(local): State<Local>, Extension(target): Extension<Target>, request: Request) -> Response {
    let head = request.method() == Method::HEAD;
    let range = header(request.headers(), "range");
    on_local(&local, move |state| async move {
        let config = state.backend.config().load();
        serve_media(&state, &config, &target, range.as_deref(), head).await
    })
    .await
}

async fn serve_media(
    state: &HttpState,
    config: &Config,
    target: &Target,
    range: Option<&str>,
    head: bool,
) -> HandlerResult {
    let encoded = target.path.get("/media/".len()..).unwrap_or_default();
    let requested = decode_uri_component(encoded).ok_or_else(|| HandlerError("URI error".into()))?;
    let staged = requested == "staging" || requested.starts_with("staging/");
    if !staged && !site_enabled(state)? {
        return Ok(not_found());
    }
    let root = if staged {
        resolve(&path_text(&config.remote_media_path), "")
    } else {
        resolve(&join(&path_text(&config.site_public_dir), "media"), "")
    };
    let relative = if staged {
        requested["staging".len()..].trim_start_matches('/')
    } else {
        requested.as_str()
    };
    let file = resolve(&root, relative);
    if file != root && !file.starts_with(&format!("{root}/")) {
        return Ok(text("forbidden\n", 403));
    }
    let Some(size) = file_size(&file) else {
        return Ok(not_found());
    };
    // Replacements change the version key. Historical links without one
    // refresh daily rather than pinning a mutable name in the browser.
    let cache = if !staged && versioned(&target.url)? {
        IMMUTABLE
    } else {
        "public, max-age=86400, stale-while-revalidate=604800"
    };
    let headers = [("cache-control", cache), ("content-type", bun_file_type(&file))];
    Ok(ranged_file_response(Path::new(&file), size, range, &headers, head).await?)
}

/// `indexNowKey`: the key IndexNow fetches back from `/<key>.txt`, stored in
/// `$DATA_DIR/indexnow.key`.
fn index_now_key(config: &Config) -> Option<String> {
    let value = fs::read_to_string(Path::new(&config.data_dir).join("indexnow.key")).ok()?;
    let value = foundation::js::trim(&value);
    let valid = (8..=128).contains(&value.len()) && value.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-');
    valid.then(|| value.to_owned())
}

/// IndexNow fetches the key from the root of the host it pinged for. Only a
/// path that is 32 lowercase hex digits and `.txt` is this route's; the proxy
/// sends every other `.txt` to the site.
async fn index_now(State(local): State<Local>, Extension(target): Extension<Target>) -> Response {
    let file = param(&target, "/");
    let shaped = file
        .strip_suffix(".txt")
        .is_some_and(|name| name.len() == 32 && name.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')));
    if !shaped {
        return not_found();
    }
    on_local(&local, move |state| async move {
        Ok(match index_now_key(&state.backend.config().load()) {
            Some(key) if file == format!("{key}.txt") => text(format!("{key}\n"), 200),
            _ => not_found(),
        })
    })
    .await
}

/// `<name>-<width>.webp` when `width` is one of the responsive widths.
fn responsive_name(file: &str) -> bool {
    let Some((name, width)) = file.strip_suffix(".webp").and_then(|stem| stem.rsplit_once('-')) else {
        return false;
    };
    !name.is_empty()
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
        && (3..=4).contains(&width.len())
        && width.bytes().all(|b| b.is_ascii_digit())
        && RESPONSIVE_WIDTHS.iter().any(|known| known.to_string() == width)
}

/// Responsive variants are generated by the publication worker before the
/// post reaches the feed; a request only reads the cached file, never runs
/// ffmpeg.
async fn responsive(State(local): State<Local>, Extension(target): Extension<Target>, method: Method) -> Response {
    on_local(&local, move |state| async move {
        if !site_enabled(&state)? {
            return Ok(not_found());
        }
        let file = param(&target, "/generated/responsive/");
        if !responsive_name(&file) {
            return Ok(not_found());
        }
        let config = state.backend.config().load();
        let cached = join(
            &path_text(&config.site_public_dir),
            &format!("generated/responsive/{file}"),
        );
        let Some(size) = file_size(&cached) else {
            return Ok(not_found());
        };
        let body = if method == Method::HEAD {
            Body::empty()
        } else {
            file_body(Path::new(&cached), 0, size).await?
        };
        let mut response = Response::new(body);
        set(&mut response, "content-type", "image/webp");
        let cache = if versioned(&target.url)? {
            IMMUTABLE
        } else {
            "public, max-age=604800, stale-while-revalidate=86400"
        };
        set(&mut response, "cache-control", cache);
        Ok(response)
    })
    .await
}
