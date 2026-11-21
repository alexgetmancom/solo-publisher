//! `POST /api/studio/media` (`interfaces/http/studio.ts`): a raw-body upload
//! (not multipart) into Studio's media through the Studio media service.
//! The MCP transport of the same file arrives with the ops slice.

use std::path::Path;

use axum::Router;
use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::request::Parts;
use axum::response::Response;
use axum::routing::post;
use content::assets::STUDIO_MEDIA_MAX_BYTES;
use domain::studio::services::media::{ImportedMediaFile, MediaService, MediaSource};
use http_body::Body as _;
use serde_json::json;

use crate::HttpState;
use crate::auth::mcp_studio_actor;
use crate::headers::header;
use crate::local::Local;
use crate::media_upload::{MediaUploadError, stream_upload_to_file};
use crate::response::{json_response, on_local, set, text};

/// Uploads streamed at once; one more is refused with a retry hint.
const MAX_ACTIVE_MEDIA_UPLOADS: usize = 2;

pub(crate) fn routes() -> Router<Local> {
    Router::new().route("/api/studio/media", post(media_upload))
}

async fn media_upload(State(local): State<Local>, request: Request) -> Response {
    let (parts, body) = request.into_parts();
    on_local(
        &local,
        move |state| async move { Ok(upload(&state, &parts, body).await) },
    )
    .await
}

/// Counts an upload in flight until it is dropped, also when the client goes
/// away mid-body and the work is dropped with it.
struct ActiveUpload<'a>(&'a HttpState);

impl Drop for ActiveUpload<'_> {
    fn drop(&mut self) {
        self.0.active_uploads.set(self.0.active_uploads.get() - 1);
    }
}

async fn upload(state: &HttpState, parts: &Parts, body: Body) -> Response {
    let config = state.backend.config().load();
    let Some(actor_id) = mcp_studio_actor(&parts.headers, &config) else {
        return text("forbidden\n", 403);
    };
    if state.active_uploads.get() >= MAX_ACTIVE_MEDIA_UPLOADS {
        let mut response = json_response(
            &json!({"error": "Too many media uploads are active; retry shortly."}),
            429,
        );
        set(&mut response, "retry-after", "30");
        return response;
    }
    state.active_uploads.set(state.active_uploads.get() + 1);
    let _active = ActiveUpload(state);
    match import(state, &config, actor_id, parts, body).await {
        Ok(response) => response,
        Err(error) => {
            let too_large = matches!(error, MediaUploadError::TooLarge { .. });
            json_response(
                &json!({"error": if too_large { "Media upload is too large" } else { "Media upload failed" }}),
                if too_large { 413 } else { 400 },
            )
        }
    }
}

async fn import(
    state: &HttpState,
    config: &foundation::config::Config,
    actor_id: i64,
    parts: &Parts,
    body: Body,
) -> Result<Response, MediaUploadError> {
    let content_type = header(&parts.headers, "content-type")
        .unwrap_or_else(|| "application/octet-stream".into())
        .split(';')
        .next()
        .map(|value| foundation::js::trim(value).to_lowercase())
        .unwrap_or_default();
    if content_type == "multipart/form-data" {
        return Ok(json_response(
            &json!({"error": "Upload the raw file body with X-Filename and Content-Type headers."}),
            415,
        ));
    }
    // A request without a body (no length, or zero, and not chunked) is
    // Bun's `request.body === null`.
    if body.is_end_stream() {
        return Ok(json_response(&json!({"error": "Media request has no body"}), 400));
    }
    let incoming = config.studio_media_dir.join(".incoming");
    let temporary = incoming.join(domain::repositories::random_uuid());
    tokio::fs::create_dir_all(&incoming)
        .await
        .map_err(|error| MediaUploadError::Failed(error.to_string()))?;
    let imported = import_temporary(state, config, actor_id, parts, &content_type, body, &temporary).await;
    let _ = tokio::fs::remove_file(&temporary).await;
    let asset = imported?;
    Ok(json_response(
        &json!({
            "asset_id": asset.id,
            "kind": asset.asset.kind,
            "filename": asset.asset.filename,
            "byte_size": asset.asset.byte_size,
        }),
        200,
    ))
}

async fn import_temporary(
    state: &HttpState,
    config: &foundation::config::Config,
    actor_id: i64,
    parts: &Parts,
    content_type: &str,
    body: Body,
    temporary: &Path,
) -> Result<domain::application::ports::StudioMediaAssetRecord, MediaUploadError> {
    let content_length = header(&parts.headers, "content-length").map_or(0.0, |value| foundation::js::number(&value));
    if content_length.is_finite() && content_length > STUDIO_MEDIA_MAX_BYTES as f64 {
        return Err(MediaUploadError::TooLarge {
            max_bytes: STUDIO_MEDIA_MAX_BYTES,
        });
    }
    let byte_size = stream_upload_to_file(body, temporary, STUDIO_MEDIA_MAX_BYTES).await?;
    let filename = header(&parts.headers, "x-filename")
        .or_else(|| header(&parts.headers, "x-file-name"))
        .unwrap_or_else(|| "upload".into());
    MediaService::new(state.backend.studio(config))
        .import_file(
            actor_id,
            &ImportedMediaFile {
                filename: &filename,
                content_type,
                local_path: temporary,
                byte_size: Some(byte_size),
                source: MediaSource::HttpUpload,
            },
        )
        .map_err(|error| MediaUploadError::Failed(error.to_string()))
}
