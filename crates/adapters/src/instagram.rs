//! `delivery/social/instagram.ts` and `instagram-container.ts`: an Instagram
//! Story through Graph containers, one call per attempt, and the one list of
//! ways Meta says a container is dead.

use foundation::redact::redact_external_secrets;
use runtime::external::instagram::{InstagramCredentials, instagram_graph_host};
use runtime::http::HttpRequest;
use serde_json::{Map, Value, json};

use crate::error::{AdapterError, Result, ambiguous_mutation, http_publish_error, parse_json};
use crate::payload::{field, is_video, payload_media};
use crate::ports::AdapterContext;
use domain::publishing::errors::PublishResult;

const PROGRESS_KEY: &str = "instagramStoryProgress";
const RESUME_KEY: &str = "_instagramPublishedId";
const READY_POLLS: usize = 30;
const PUBLISH_ATTEMPTS: usize = 5;
const CONTAINER_ATTEMPTS: usize = 2;
const POLL_DELAYS_MS: [u64; 5] = [250, 750, 1_500, 3_000, 5_000];

// Meta reports a dead creation_id through several unrelated shapes: subcodes
// 2207027 and 2207006 and prose that differs per endpoint and API version.
// One list, so the Reels and Stories paths never drift apart.
const EXPIRED_CONTAINER_MARKERS: [&str; 7] = [
    "2207027",
    "2207006",
    "media id is not available",
    "invalid media id",
    "invalid container",
    "creation_id",
    "container expired",
];

/// `isExpiredInstagramContainer(error, httpStatus)`: whether the error says
/// the container is gone. A status restricts the match to a provider answer
/// with that status — media_publish reports this class only as a 400, and a
/// 500 with matching prose is a transient fault.
pub fn is_expired_container(error: &AdapterError, http_status: Option<u16>) -> bool {
    if matches!(error, AdapterError::ContainerInvalid(_)) {
        return true;
    }
    if let Some(status) = http_status {
        let AdapterError::Http(error) = error else {
            return false;
        };
        return error.status == status && matches_marker(error.body.as_deref().unwrap_or(&error.message));
    }
    matches_marker(error.message())
}

fn matches_marker(body: &str) -> bool {
    let value = body.to_lowercase();
    EXPIRED_CONTAINER_MARKERS.iter().any(|marker| value.contains(marker))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Stage {
    Create,
    Processing,
    Ready,
    PublishSent,
}

impl Stage {
    fn parse(name: &str) -> Option<Self> {
        Some(match name {
            "create" => Self::Create,
            "processing" => Self::Processing,
            "ready" => Self::Ready,
            "publish_sent" => Self::PublishSent,
            _ => return None,
        })
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Create => "create",
            Self::Processing => "processing",
            Self::Ready => "ready",
            Self::PublishSent => "publish_sent",
        }
    }
}

#[derive(Clone, Debug)]
struct State {
    stage: Stage,
    container_id: Option<String>,
    published_id: Option<String>,
    polls: usize,
    rebuilds: usize,
    publish_attempts: usize,
}

impl State {
    fn parse(value: Option<&Value>) -> Option<Self> {
        let state = value?.as_object()?;
        let stage = Stage::parse(state.get("stage").and_then(Value::as_str)?)?;
        let integer = |key: &str| {
            state
                .get(key)
                .and_then(Value::as_f64)
                .filter(|value| foundation::js::is_safe_integer(*value))
                .map_or(0, |value| value.max(0.0) as usize)
        };
        Some(Self {
            stage,
            container_id: state.get("containerId").and_then(Value::as_str).map(str::to_owned),
            published_id: state.get("publishedId").and_then(Value::as_str).map(str::to_owned),
            polls: integer("polls"),
            rebuilds: integer("rebuilds"),
            publish_attempts: integer("publishAttempts"),
        })
    }

    fn rebuild(rebuilds: usize) -> Self {
        Self {
            stage: Stage::Create,
            container_id: None,
            published_id: None,
            polls: 0,
            rebuilds,
            publish_attempts: 0,
        }
    }

    fn to_json(&self) -> Value {
        let mut state = Map::new();
        state.insert("stage".into(), self.stage.as_str().into());
        if let Some(container_id) = &self.container_id {
            state.insert("containerId".into(), container_id.clone().into());
        }
        if let Some(published_id) = &self.published_id {
            state.insert("publishedId".into(), published_id.clone().into());
        }
        state.insert("polls".into(), self.polls.into());
        state.insert("rebuilds".into(), self.rebuilds.into());
        state.insert("publishAttempts".into(), self.publish_attempts.into());
        Value::Object(state)
    }
}

fn deferred(state: &State, retry_after_ms: u64) -> PublishResult {
    let mut result = Map::new();
    result.insert("deferred".into(), true.into());
    result.insert("progressKey".into(), PROGRESS_KEY.into());
    result.insert("progressValue".into(), state.to_json());
    if let Some(published_id) = &state.published_id {
        result.insert("resumeKey".into(), RESUME_KEY.into());
        result.insert("resumeValue".into(), published_id.clone().into());
    }
    result.insert("retryAfterMs".into(), retry_after_ms.into());
    result.insert("state".into(), state.stage.as_str().into());
    result
}

fn poll_delay(attempt: usize) -> u64 {
    POLL_DELAYS_MS[attempt.min(POLL_DELAYS_MS.len() - 1)]
}

fn failed(error: String) -> PublishResult {
    let mut result = Map::new();
    result.insert("ok".into(), false.into());
    result.insert("error".into(), error.into());
    result
}

/// `publishInstagramStory(payload, config, credentials)`.
pub async fn publish_instagram_story(
    ctx: &AdapterContext,
    payload: &Map<String, Value>,
    credentials: InstagramCredentials<'_>,
) -> Result<PublishResult> {
    let graph = Graph::new(ctx, credentials)?;
    let user_id = credentials
        .user_id
        .filter(|id| !id.is_empty())
        .ok_or_else(|| AdapterError::message_text("missing Instagram user id"))?;

    let state = State::parse(payload.get(PROGRESS_KEY));
    // The staged public URL belongs to the attempt that built the container,
    // not to the ones that watch it: only the creating stage demands one.
    let media = payload_media(payload)
        .into_iter()
        .find(|item| field(item, "storyVpsUrl").is_some() || field(item, "vpsUrl").is_some());
    let public_url = media
        .as_ref()
        .and_then(|item| field(item, "storyVpsUrl").or_else(|| field(item, "vpsUrl")))
        .map(str::to_owned);
    let state = match state {
        Some(state) if state.stage != Stage::Create => state,
        state => {
            let (Some(media), Some(public_url)) = (&media, &public_url) else {
                let mut result = Map::new();
                result.insert("ok".into(), false.into());
                result.insert("skipped".into(), true.into());
                result.insert("reason".into(), "missing_public_media_url".into());
                return Ok(result);
            };
            let rebuilds = state.map_or(0, |state| state.rebuilds);
            let url_key = if is_video(media) { "video_url" } else { "image_url" };
            let creation = graph
                .post(
                    &format!("{user_id}/media"),
                    &[("media_type", "STORIES"), (url_key, public_url)],
                )
                .await?;
            let Some(id) = creation.get("id").and_then(Value::as_str).filter(|id| !id.is_empty()) else {
                return Ok(failed(domain::json::stringify(&creation)));
            };
            let next = State {
                stage: Stage::Processing,
                container_id: Some(id.to_owned()),
                published_id: None,
                polls: 0,
                rebuilds,
                publish_attempts: 0,
            };
            return Ok(deferred(&next, 250));
        }
    };

    match state.stage {
        Stage::Create => unreachable!("the creating stage returned above"),
        Stage::Processing => {
            let Some(container_id) = state.container_id.clone() else {
                return Err(AdapterError::message_text("instagram_story_state_missing_container"));
            };
            let status = graph.get(&container_id, "status_code,status").await?;
            let code = crate::js::present(status.get("status_code"))
                .or_else(|| crate::js::present(status.get("status")))
                .cloned();
            let code_text = code.as_ref().and_then(Value::as_str);
            if code_text == Some("FINISHED") {
                return Ok(deferred(
                    &State {
                        stage: Stage::Ready,
                        ..state
                    },
                    0,
                ));
            }
            if matches!(code_text, Some("ERROR" | "EXPIRED")) {
                if state.rebuilds + 1 < CONTAINER_ATTEMPTS {
                    return Ok(deferred(
                        &State::rebuild(state.rebuilds + 1),
                        poll_delay(state.rebuilds),
                    ));
                }
                let media_probe = match &public_url {
                    Some(url) => probe_public_media(ctx, url).await,
                    None => Value::Null,
                };
                let mut detail = Map::new();
                detail.insert("containerId".into(), container_id.into());
                if let Some(code) = code {
                    detail.insert("statusCode".into(), code);
                }
                detail.insert(
                    "providerStatus".into(),
                    crate::js::present(status.get("status")).cloned().unwrap_or(Value::Null),
                );
                detail.insert(
                    "providerError".into(),
                    crate::js::present(status.get("error")).cloned().unwrap_or(Value::Null),
                );
                detail.insert(
                    "mediaType".into(),
                    media
                        .as_ref()
                        .and_then(|item| item.get("type"))
                        .cloned()
                        .unwrap_or(Value::Null),
                );
                detail.insert("publicUrl".into(), public_url.map_or(Value::Null, Value::from));
                detail.insert("mediaProbe".into(), media_probe);
                return Err(AdapterError::ContainerInvalid(format!(
                    "Instagram container rejected media: {}",
                    domain::json::stringify(&Value::Object(detail))
                )));
            }
            let polls = state.polls + 1;
            if polls >= READY_POLLS {
                return Err(AdapterError::Message(format!(
                    "instagram_container_timeout:{container_id}"
                )));
            }
            Ok(deferred(&State { polls, ..state }, poll_delay(polls)))
        }
        Stage::Ready => {
            let Some(container_id) = state.container_id.clone() else {
                return Err(AdapterError::message_text("instagram_story_state_missing_container"));
            };
            let published = ambiguous_mutation(
                "instagram_stories",
                graph.post(&format!("{user_id}/media_publish"), &[("creation_id", &container_id)]),
            )
            .await;
            match published {
                Ok(published) => {
                    let Some(id) = published.get("id").and_then(Value::as_str).filter(|id| !id.is_empty()) else {
                        return Ok(failed(domain::json::stringify(&published)));
                    };
                    let next = State {
                        stage: Stage::PublishSent,
                        published_id: Some(id.to_owned()),
                        ..state
                    };
                    Ok(deferred(&next, 0))
                }
                Err(error) if !is_expired_container(&error, None) => Err(error),
                Err(error) => {
                    let publish_attempts = state.publish_attempts + 1;
                    if publish_attempts < PUBLISH_ATTEMPTS {
                        return Ok(deferred(
                            &State {
                                publish_attempts,
                                ..state
                            },
                            poll_delay(publish_attempts),
                        ));
                    }
                    if state.rebuilds + 1 < CONTAINER_ATTEMPTS {
                        return Ok(deferred(
                            &State::rebuild(state.rebuilds + 1),
                            poll_delay(state.rebuilds),
                        ));
                    }
                    Err(AdapterError::ContainerInvalid(error.message().to_owned()))
                }
            }
        }
        Stage::PublishSent => {
            let Some(published_id) = state.published_id.clone() else {
                return Err(AdapterError::message_text("instagram_story_state_missing_publication"));
            };
            let published = graph.get(&published_id, "id,permalink").await?;
            if published.get("id").and_then(Value::as_str) != Some(published_id.as_str()) {
                return Err(AdapterError::message_text(
                    "Instagram verification did not return the expected media",
                ));
            }
            let mut result = Map::new();
            result.insert("ok".into(), true.into());
            result.insert("id".into(), published_id.clone().into());
            result.insert(
                "url".into(),
                crate::js::present(published.get("permalink"))
                    .cloned()
                    .unwrap_or(Value::Null),
            );
            result.insert("raw".into(), published);
            result.insert(
                "verification".into(),
                json!({"status": "verified", "providerId": published_id}),
            );
            Ok(result)
        }
    }
}

/// `verifyInstagramPublication`: the media and its permalink.
pub async fn verify_instagram_publication(
    ctx: &AdapterContext,
    id: &str,
    credentials: InstagramCredentials<'_>,
) -> Result<(String, Value)> {
    let media = Graph::new(ctx, credentials)?.get(id, "id,permalink").await?;
    if media.get("id").and_then(Value::as_str) != Some(id) {
        return Err(AdapterError::message_text(
            "Instagram verification did not return the expected media",
        ));
    }
    Ok((
        id.to_owned(),
        crate::js::present(media.get("permalink"))
            .cloned()
            .unwrap_or(Value::Null),
    ))
}

/// What the staged URL answered when Meta rejected the media, for the error.
async fn probe_public_media(ctx: &AdapterContext, public_url: &str) -> Value {
    let request = HttpRequest::new(runtime::http::Method::Head, public_url);
    match ctx.client.fetch(request).await {
        Ok(response) => json!({
            "status": response.status,
            "contentType": response.headers.get("content-type"),
            "contentLength": response.headers.get("content-length"),
        }),
        Err(error) => json!({
            "status": "unreachable",
            "contentType": null,
            "contentLength": null,
            "error": redact_external_secrets(&error.to_string()),
        }),
    }
}

struct Graph<'a> {
    ctx: &'a AdapterContext,
    token: &'a str,
}

impl<'a> Graph<'a> {
    fn new(ctx: &'a AdapterContext, credentials: InstagramCredentials<'a>) -> Result<Self> {
        let token = credentials
            .access_token
            .filter(|token| !token.is_empty())
            .ok_or_else(|| AdapterError::message_text("missing Instagram access token"))?;
        Ok(Self { ctx, token })
    }

    fn url(&self, path: &str) -> String {
        format!(
            "https://{}/{}/{}",
            instagram_graph_host(self.token),
            self.ctx.config.instagram_graph_api_version,
            path.trim_start_matches('/')
        )
    }

    async fn post(&self, path: &str, fields: &[(&str, &str)]) -> Result<Value> {
        let mut body: Vec<(&str, Option<&str>)> = fields.iter().map(|(key, value)| (*key, Some(*value))).collect();
        body.push(("access_token", Some(self.token)));
        let request = HttpRequest::post(self.url(path))
            .header("Content-Type", "application/x-www-form-urlencoded")
            .text(runtime::http::form_body(&body));
        self.send(request).await
    }

    async fn get(&self, path: &str, fields: &str) -> Result<Value> {
        let query = runtime::http::form_body(&[("fields", Some(fields)), ("access_token", Some(self.token))]);
        self.send(HttpRequest::get(self.url(&format!("{path}?{query}")))).await
    }

    async fn send(&self, request: HttpRequest) -> Result<Value> {
        let response = self.ctx.client.fetch(request).await?;
        let status = response.status;
        let ok = response.ok();
        let headers = response.headers.clone();
        let body = response.text().await?;
        if !ok {
            return Err(http_publish_error(status, &headers, &body, "Instagram API"));
        }
        parse_json(&body)
    }
}
