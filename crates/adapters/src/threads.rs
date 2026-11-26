//! A Threads post as a resumable state machine.
//! Every call makes at most one mutation and hands the next stage back to the
//! durable queue as a deferral, so a container is persisted after one API
//! call instead of being polled in place.

use content::Locale;
use content::message::{Entity, MediaItem};
use content::thread::{LocalizedThreadPart, chain_posts};
use domain::publishing::errors::PublishResult;
use domain::publishing::threads_text::{threads_body, threads_text_limit};
use foundation::js::{encode_uri_component, utf16_len};
use foundation::logger::{LogLevel, log};
use runtime::external::threads::threads_credentials;
use runtime::http::{HttpRequest, form_body};
use serde_json::{Map, Value, json};

use crate::error::{AdapterError, Result, ambiguous_mutation};
use crate::payload::{field, is_video, payload_media, payload_text, payload_thread};
use crate::ports::AdapterContext;

/// The adapter's own progress, and — separately — the ids that have reached
/// the audience: only the second may carry the resume prefix.
const PROGRESS_KEY: &str = "threadsProgress";
const RESUME_KEY: &str = "_threadsPublishedIds";
const POLL_DELAYS_MS: [u64; 5] = [250, 750, 1_500, 3_000, 5_000];
/// How long to wait before asking Meta to fetch the same staged file again.
const MEDIA_FETCH_RETRY_DELAYS_MS: [u64; 3] = [5_000, 20_000, 60_000];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Stage {
    CreateChild,
    WaitChild,
    CreatePrimary,
    WaitPrimary,
    CreateParent,
    Publish,
    CreateReply,
    WaitReply,
    Verify,
}

impl Stage {
    const ALL: [Self; 9] = [
        Self::CreateChild,
        Self::WaitChild,
        Self::CreatePrimary,
        Self::WaitPrimary,
        Self::CreateParent,
        Self::Publish,
        Self::CreateReply,
        Self::WaitReply,
        Self::Verify,
    ];

    fn as_str(self) -> &'static str {
        match self {
            Self::CreateChild => "create_child",
            Self::WaitChild => "wait_child",
            Self::CreatePrimary => "create_primary",
            Self::WaitPrimary => "wait_primary",
            Self::CreateParent => "create_parent",
            Self::Publish => "publish",
            Self::CreateReply => "create_reply",
            Self::WaitReply => "wait_reply",
            Self::Verify => "verify",
        }
    }
}

#[derive(Clone, Debug)]
struct State {
    stage: Stage,
    container_id: Option<String>,
    child_ids: Vec<String>,
    item_index: usize,
    published_ids: Vec<String>,
    part_index: usize,
    polls: usize,
    carousel_rebuilds: usize,
    media_fetch_retries: usize,
    started_at_ms: f64,
}

impl State {
    fn initial(media_count: usize, now_ms: i64) -> Self {
        Self {
            stage: if media_count > 1 {
                Stage::CreateChild
            } else {
                Stage::CreatePrimary
            },
            container_id: None,
            child_ids: Vec::new(),
            item_index: 0,
            published_ids: Vec::new(),
            part_index: 0,
            polls: 0,
            carousel_rebuilds: 0,
            media_fetch_retries: 0,
            started_at_ms: now_ms as f64,
        }
    }

    /// `threadsState`: the stored progress, or `None` when it is not one.
    fn parse(value: Option<&Value>, now_ms: i64) -> Option<Self> {
        let state = value?.as_object()?;
        let stage_name = state.get("stage").and_then(Value::as_str)?;
        let stage = Stage::ALL.into_iter().find(|stage| stage.as_str() == stage_name)?;
        let ids = |key: &str| -> Vec<String> {
            state
                .get(key)
                .and_then(Value::as_array)
                .map(|ids| ids.iter().filter_map(Value::as_str).map(str::to_owned).collect())
                .unwrap_or_default()
        };
        let integer = |key: &str| {
            state
                .get(key)
                .and_then(Value::as_f64)
                .filter(|value| foundation::js::is_safe_integer(*value) && *value >= 0.0)
                .map_or(0, |value| value as usize)
        };
        Some(Self {
            stage,
            container_id: state.get("containerId").and_then(Value::as_str).map(str::to_owned),
            child_ids: ids("childIds"),
            item_index: integer("itemIndex"),
            published_ids: ids("publishedIds"),
            part_index: integer("partIndex"),
            polls: integer("polls"),
            carousel_rebuilds: integer("carouselRebuilds"),
            media_fetch_retries: integer("mediaFetchRetries"),
            started_at_ms: state
                .get("startedAtMs")
                .and_then(Value::as_f64)
                .filter(|value| value.is_finite())
                .unwrap_or(now_ms as f64),
        })
    }

    fn to_json(&self) -> Value {
        let mut state = Map::new();
        state.insert("stage".into(), self.stage.as_str().into());
        if let Some(container_id) = &self.container_id {
            state.insert("containerId".into(), container_id.clone().into());
        }
        state.insert("childIds".into(), json!(self.child_ids));
        state.insert("itemIndex".into(), self.item_index.into());
        state.insert("publishedIds".into(), json!(self.published_ids));
        state.insert("partIndex".into(), self.part_index.into());
        state.insert("polls".into(), self.polls.into());
        state.insert("carouselRebuilds".into(), self.carousel_rebuilds.into());
        state.insert("mediaFetchRetries".into(), self.media_fetch_retries.into());
        state.insert("startedAtMs".into(), foundation::js::json_number(self.started_at_ms));
        Value::Object(state)
    }

    fn with(&self, stage: Stage) -> Self {
        Self { stage, ..self.clone() }
    }

    /// The next stage watching a fresh container.
    fn watching(&self, stage: Stage, container_id: String, now_ms: i64) -> Self {
        Self {
            stage,
            container_id: Some(container_id),
            polls: 0,
            started_at_ms: now_ms as f64,
            ..self.clone()
        }
    }
}

fn deferred(state: &State, retry_after_ms: u64) -> PublishResult {
    let mut result = Map::new();
    result.insert("deferred".into(), true.into());
    result.insert("progressKey".into(), PROGRESS_KEY.into());
    result.insert("progressValue".into(), state.to_json());
    if !state.published_ids.is_empty() {
        result.insert("resumeKey".into(), RESUME_KEY.into());
        result.insert("resumeValue".into(), json!(state.published_ids));
    }
    result.insert("retryAfterMs".into(), retry_after_ms.into());
    result.insert("state".into(), state.stage.as_str().into());
    result
}

fn poll_delay(attempt: usize) -> u64 {
    POLL_DELAYS_MS[attempt.min(POLL_DELAYS_MS.len() - 1)]
}

fn locale_of(target: &str) -> Locale {
    if target == "threads_en" { Locale::En } else { Locale::Ru }
}

/// `{media_type, …, image_url | video_url}` for one staged item.
fn media_fields(item: &MediaItem, url: &str) -> (&'static str, String) {
    (if is_video(item) { "video_url" } else { "image_url" }, url.to_owned())
}

/// `publishToThreads(payload, config, fetchImpl, target)`.
pub async fn publish_to_threads(
    ctx: &AdapterContext,
    payload: &Map<String, Value>,
    target: &str,
) -> Result<PublishResult> {
    let credentials = threads_credentials(&ctx.config, locale_of(target));
    let Some(token) = credentials.access_token.filter(|token| !token.is_empty()) else {
        let mut result = Map::new();
        result.insert("skipped".into(), true.into());
        result.insert("reason".into(), format!("missing {}", credentials.env_name).into());
        return Ok(result);
    };
    let threads = Threads { ctx, token };
    // A post longer than the budget becomes the replies it would have been:
    // `chain_posts` decides that cut, and preflight counted these posts.
    let entities: Vec<Entity> = payload
        .get("entities")
        .and_then(Value::as_array)
        .map(|entities| {
            entities
                .iter()
                .filter_map(|entity| entity.as_object().cloned())
                .collect()
        })
        .unwrap_or_default();
    let limit = threads_text_limit(target);
    let mut written = vec![LocalizedThreadPart {
        text: payload_text(payload),
        entities,
        media: Vec::new(),
    }];
    written.extend(payload_thread(payload));
    let posts = chain_posts(&written, limit);
    // The replies, each with the media of the post it was written as.
    let thread = &posts[1..];
    let parts: Vec<String> = posts
        .iter()
        .map(|post| threads_body(target, &post.text, &post.entities).text)
        .collect();
    if let Some(overlong) = parts.iter().position(|part| utf16_len(part) > limit) {
        let part = if overlong > 0 {
            format!("part {}:", overlong + 1)
        } else {
            String::new()
        };
        let mut result = Map::new();
        result.insert("ok".into(), false.into());
        result.insert(
            "error".into(),
            format!("threads_text_too_long:{part}{}/{limit}", utf16_len(&parts[overlong])).into(),
        );
        return Ok(result);
    }
    let media_items: Vec<MediaItem> = payload_media(payload)
        .into_iter()
        .filter(|item| field(item, "vpsUrl").is_some())
        .collect();
    let now = ctx.now_ms();
    let state = State::parse(payload.get(PROGRESS_KEY), now).unwrap_or_else(|| State::initial(media_items.len(), now));

    match state.stage {
        Stage::CreateChild => {
            let Some(item) = media_items.get(state.item_index) else {
                return Err(AdapterError::message_text("threads_carousel_item_missing"));
            };
            let url = field(item, "vpsUrl").unwrap_or_default();
            let (key, value) = media_fields(item, url);
            let fields = [
                ("media_type", field(item, "type").unwrap_or_default().to_owned()),
                ("is_carousel_item", "true".to_owned()),
                (key, value),
            ];
            let created = async {
                let child = threads.post("me/threads", &fields).await?;
                let id =
                    response_id(&child).ok_or_else(|| AdapterError::message_text("threads_carousel_child_missing"))?;
                Ok(deferred(&state.watching(Stage::WaitChild, id, ctx.now_ms()), 250))
            }
            .await;
            threads.retry_media_fetch(&state, created, Some(url)).await
        }
        Stage::CreatePrimary => {
            let item = media_items.first();
            let mut fields = Vec::new();
            match item {
                Some(item) => {
                    let url = field(item, "vpsUrl").unwrap_or_default();
                    fields.push(("media_type", field(item, "type").unwrap_or_default().to_owned()));
                    fields.push(("text", parts[0].clone()));
                    fields.push(media_fields(item, url));
                }
                None => {
                    fields.push(("media_type", "TEXT".to_owned()));
                    fields.push(("text", parts[0].clone()));
                }
            }
            let created = async {
                let container = threads.post("me/threads", &fields).await?;
                let id =
                    response_id(&container).ok_or_else(|| AdapterError::message_text("threads_container_missing"))?;
                Ok(deferred(&state.watching(Stage::WaitPrimary, id, ctx.now_ms()), 250))
            }
            .await;
            threads
                .retry_media_fetch(&state, created, item.and_then(|item| field(item, "vpsUrl")))
                .await
        }
        Stage::CreateParent => {
            let fields = [
                ("media_type", "CAROUSEL".to_owned()),
                ("text", parts[0].clone()),
                ("children", state.child_ids.join(",")),
            ];
            let created = async {
                let parent = threads.post("me/threads", &fields).await?;
                let id = response_id(&parent)
                    .ok_or_else(|| AdapterError::message_text("threads_carousel_parent_missing"))?;
                Ok(deferred(&state.watching(Stage::WaitPrimary, id, ctx.now_ms()), 250))
            }
            .await;
            match created {
                Err(error) if state.carousel_rebuilds == 0 && is_invalid_carousel(&error) => {
                    let rebuilt = State {
                        stage: Stage::CreateChild,
                        container_id: None,
                        child_ids: Vec::new(),
                        item_index: 0,
                        carousel_rebuilds: 1,
                        ..state.clone()
                    };
                    Ok(deferred(&rebuilt, 250))
                }
                other => other,
            }
        }
        Stage::CreateReply => {
            let (Some(parent), Some(part)) = (state.published_ids.last(), parts.get(state.part_index)) else {
                return Err(AdapterError::message_text("threads_reply_state_invalid"));
            };
            // One media item per reply; preflight refuses a part carrying more.
            let item = state
                .part_index
                .checked_sub(1)
                .and_then(|index| thread.get(index))
                .and_then(|post| post.media.iter().find(|media| field(media, "vpsUrl").is_some()));
            let mut fields = Vec::new();
            match item {
                Some(item) => {
                    let url = field(item, "vpsUrl").unwrap_or_default();
                    fields.push(("media_type", field(item, "type").unwrap_or_default().to_owned()));
                    fields.push(("text", part.clone()));
                    fields.push(("reply_to_id", parent.clone()));
                    fields.push(media_fields(item, url));
                }
                None => {
                    fields.push(("media_type", "TEXT".to_owned()));
                    fields.push(("text", part.clone()));
                    fields.push(("reply_to_id", parent.clone()));
                }
            }
            let created = async {
                let reply = threads.post("me/threads", &fields).await?;
                let id =
                    response_id(&reply).ok_or_else(|| AdapterError::message_text("threads_reply_container_missing"))?;
                Ok(deferred(&state.watching(Stage::WaitReply, id, ctx.now_ms()), 250))
            }
            .await;
            threads
                .retry_media_fetch(&state, created, item.and_then(|item| field(item, "vpsUrl")))
                .await
        }
        Stage::WaitChild | Stage::WaitPrimary | Stage::WaitReply => {
            let Some(container_id) = state.container_id.clone() else {
                return Err(AdapterError::message_text("threads_state_missing_container"));
            };
            let status = threads.get(&container_id, "status,error_message").await?;
            let code = status.get("status").and_then(Value::as_str);
            if matches!(code, Some("ERROR" | "EXPIRED")) {
                let reason = match status.get("error_message") {
                    Some(message) if !message.is_null() => foundation::js::string_of(message),
                    _ => code.unwrap_or_default().to_owned(),
                };
                return Err(AdapterError::Message(format!(
                    "Threads container {container_id} failed: {reason}"
                )));
            }
            if code != Some("FINISHED") {
                let timeout_ms = ctx.config.threads_container_timeout_seconds as f64 * 1000.0;
                if ctx.now_ms() as f64 >= state.started_at_ms + timeout_ms {
                    return Err(AdapterError::Message(format!(
                        "Threads container {container_id} timed out"
                    )));
                }
                let polls = state.polls + 1;
                return Ok(deferred(&State { polls, ..state.clone() }, poll_delay(polls)));
            }
            if state.stage == Stage::WaitChild {
                let mut child_ids = state.child_ids.clone();
                child_ids.push(container_id);
                let item_index = state.item_index + 1;
                let next = State {
                    stage: if item_index < media_items.len() {
                        Stage::CreateChild
                    } else {
                        Stage::CreateParent
                    },
                    container_id: None,
                    child_ids,
                    item_index,
                    ..state.clone()
                };
                return Ok(deferred(&next, 0));
            }
            Ok(deferred(&state.with(Stage::Publish), 0))
        }
        Stage::Publish => {
            let Some(container_id) = state.container_id.clone() else {
                return Err(AdapterError::message_text("threads_state_missing_container"));
            };
            let published = ambiguous_mutation(
                "threads",
                threads.post("me/threads_publish", &[("creation_id", container_id)]),
            )
            .await?;
            let Some(id) = response_id(&published) else {
                return Err(AdapterError::message_text("threads_publish_missing"));
            };
            let mut published_ids = state.published_ids.clone();
            published_ids.push(id);
            let part_index = state.part_index + 1;
            let next = State {
                stage: if part_index < parts.len() {
                    Stage::CreateReply
                } else {
                    Stage::Verify
                },
                container_id: None,
                published_ids,
                part_index,
                ..state.clone()
            };
            Ok(deferred(&next, 0))
        }
        Stage::Verify => {
            let Some(root) = state.published_ids.first() else {
                return Err(AdapterError::message_text("threads_state_missing_publication"));
            };
            let verified = threads.get(root, "id,permalink").await?;
            if verified.get("id").and_then(Value::as_str) != Some(root.as_str()) {
                return Err(AdapterError::message_text(
                    "Threads verification returned a different post",
                ));
            }
            let mut result = Map::new();
            result.insert("ok".into(), true.into());
            result.insert("id".into(), root.clone().into());
            result.insert("ids".into(), json!(state.published_ids));
            result.insert("url".into(), permalink(&verified));
            result.insert("verification".into(), json!({"status": "verified", "providerId": root}));
            Ok(result)
        }
    }
}

/// The permalink on threads.com, where threads.net now redirects.
fn permalink(post: &Value) -> Value {
    post.get("permalink")
        .and_then(Value::as_str)
        .map_or(Value::Null, |link| {
            link.replacen("threads.net", "threads.com", 1).into()
        })
}

fn response_id(response: &Value) -> Option<String> {
    response
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_owned)
}

fn is_invalid_carousel(error: &AdapterError) -> bool {
    let message = error.message().to_lowercase();
    message.contains("4279004") || (message.contains("carousel") && message.contains("invalid"))
}

struct Threads<'a> {
    ctx: &'a AdapterContext,
    token: &'a str,
}

impl Threads<'_> {
    async fn post(&self, endpoint: &str, fields: &[(&str, String)]) -> Result<Value> {
        let mut body: Vec<(&str, Option<&str>)> =
            fields.iter().map(|(key, value)| (*key, Some(value.as_str()))).collect();
        body.push(("access_token", Some(self.token)));
        let request = HttpRequest::post(endpoint_url(endpoint))
            .header("Content-Type", "application/x-www-form-urlencoded")
            .text(form_body(&body));
        Ok(self.ctx.client.request_json(request).await?)
    }

    async fn get(&self, endpoint: &str, fields: &str) -> Result<Value> {
        let mut url = url::Url::parse(&endpoint_url(endpoint))
            .map_err(|error| AdapterError::Message(format!("Invalid URL: {error}")))?;
        url.query_pairs_mut()
            .append_pair("fields", fields)
            .append_pair("access_token", self.token);
        Ok(self
            .ctx
            .client
            .request_json(HttpRequest::get(String::from(url)))
            .await?)
    }

    /// Meta answers a public, reachable, well-formed staged URL with subcode
    /// 2207052 ("could not fetch the media file") often enough to lose
    /// publications, and marks it not transient although the same URL works
    /// moments later. Nothing has reached the audience and no container
    /// exists, so asking again costs nothing. Each attempt logs what this
    /// host served for the URL at that moment.
    async fn retry_media_fetch(
        &self,
        state: &State,
        created: Result<PublishResult>,
        media_url: Option<&str>,
    ) -> Result<PublishResult> {
        let error = match created {
            Ok(result) => return Ok(result),
            Err(error) if error.message().contains("2207052") => error,
            Err(error) => return Err(error),
        };
        let retry_in = MEDIA_FETCH_RETRY_DELAYS_MS.get(state.media_fetch_retries).copied();
        log(
            LogLevel::Warn,
            "Threads could not fetch the staged media",
            Some(json!({
                "stage": state.stage.as_str(),
                "url": media_url,
                "attempt": state.media_fetch_retries + 1,
                "retryInMs": retry_in,
                "served": self.describe_staged_media(media_url).await,
            })),
        );
        let Some(retry_in) = retry_in else {
            return Err(error);
        };
        Ok(deferred(
            &State {
                media_fetch_retries: state.media_fetch_retries + 1,
                ..state.clone()
            },
            retry_in,
        ))
    }

    /// What this host answers for the URL Meta says it could not fetch.
    async fn describe_staged_media(&self, media_url: Option<&str>) -> Value {
        let Some(media_url) = media_url else {
            return json!({"reason": "no staged url"});
        };
        let response = match self.ctx.client.exchange(HttpRequest::get(media_url)).await {
            Ok(response) => response,
            Err(failure) => return json!({"error": failure.message}),
        };
        let status = response.status;
        let content_type = response.headers.get("content-type");
        match response.bytes().await {
            Ok(bytes) => json!({"status": status, "contentType": content_type, "bytes": bytes.len()}),
            Err(error) => json!({"error": error.to_string()}),
        }
    }
}

fn endpoint_url(endpoint: &str) -> String {
    format!("https://graph.threads.net/v1.0/{endpoint}")
}

/// `verifyThreadsPost`: the post and its permalink, asked of Threads itself.
pub async fn verify_threads_post(ctx: &AdapterContext, id: &str, target: &str) -> Result<(String, Value)> {
    let credentials = threads_credentials(&ctx.config, locale_of(target));
    let Some(token) = credentials.access_token.filter(|token| !token.is_empty()) else {
        return Err(AdapterError::Message(format!("missing {}", credentials.env_name)));
    };
    let post = Threads { ctx, token }.get(id, "id,permalink").await?;
    if post.get("id").and_then(Value::as_str) != Some(id) {
        return Err(AdapterError::message_text(
            "Threads verification returned a different post",
        ));
    }
    Ok((id.to_owned(), permalink(&post)))
}

/// The Threads `remove` port.
pub async fn delete_threads_post(ctx: &AdapterContext, id: &str, target: &str) -> Result<Value> {
    let credentials = threads_credentials(&ctx.config, locale_of(target));
    let Some(token) = credentials.access_token.filter(|token| !token.is_empty()) else {
        return Err(AdapterError::Message(format!("missing {}", credentials.env_name)));
    };
    let request = HttpRequest::new(
        runtime::http::Method::Delete,
        format!(
            "https://graph.threads.net/v1.0/{}?access_token={}",
            encode_uri_component(id),
            encode_uri_component(token)
        ),
    );
    Ok(ctx.client.request_json(request).await?)
}
