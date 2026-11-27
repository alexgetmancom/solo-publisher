//! Publications through the Zernio posting aggregator.
//! Every create carries a request id fencing retries of one logical target,
//! so a repeat returns the post that already exists instead of a second one.

use crate::external::zernio::zernio_request;
use domain::json::stringify;
use domain::publishing::errors::PublishResult;
use domain::publishing::queue::ClaimedPublishJob;
use foundation::json::id_text;
use foundation::text::TrimText;
use runtime::http::Method;
use serde_json::{Map, Value, json};

use crate::adapters::error::{AdapterError, Result, ambiguous_error};
use crate::adapters::payload::{field, is_video, payload_media, payload_text};
use crate::adapters::ports::AdapterContext;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ZernioPlatform {
    Threads,
    Instagram,
}

impl ZernioPlatform {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Threads => "threads",
            Self::Instagram => "instagram",
        }
    }

    pub fn parse(name: &str) -> Option<Self> {
        match name {
            "threads" => Some(Self::Threads),
            "instagram" => Some(Self::Instagram),
            _ => None,
        }
    }
}

/// A provider publication: the provider's id, and the platform's once known.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ZernioPublication {
    pub provider_post_id: String,
    pub external_id: Option<String>,
    pub url: Option<String>,
}

impl ZernioPublication {
    pub fn to_json(&self) -> Map<String, Value> {
        let mut record = Map::new();
        record.insert("providerPostId".into(), self.provider_post_id.clone().into());
        record.insert("externalId".into(), self.external_id.clone().into());
        record.insert("url".into(), self.url.clone().into());
        record
    }
}

/// What the provider says became of a publication (`zernioPostOutcome`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ZernioOutcome {
    pub publication: ZernioPublication,
    pub failure: Option<String>,
}

struct PublicationInput<'a> {
    account_id: &'a str,
    platform: ZernioPlatform,
    content: &'a str,
    media_items: Vec<Value>,
    platform_specific_data: Option<Value>,
    request_id: &'a str,
}

const DUPLICATE_ERROR: &str =
    "This exact content is already scheduled, publishing, or was posted to this account within the last 24 hours.";

/// `post._id ?? post.id ?? post.post?._id ?? … ?? post.existingPost?.id`.
fn post_id(post: &Value) -> Option<String> {
    fn id(value: &Value) -> Option<&Value> {
        value
            .get("_id")
            .filter(|id| !id.is_null())
            .or_else(|| value.get("id").filter(|id| !id.is_null()))
    }
    id(post)
        .or_else(|| post.get("post").and_then(id))
        .or_else(|| post.get("existingPost").and_then(id))
        .and_then(id_text)
}

/// `zernioPublishResult(post, platform, expectedPostId)`.
fn publication_of(post: &Value, platform: ZernioPlatform, expected: Option<&str>) -> Result<ZernioPublication> {
    let resolved = post
        .get("post")
        .filter(|value| !value.is_null())
        .or_else(|| post.get("existingPost").filter(|value| !value.is_null()))
        .unwrap_or(post);
    let entries = |key: &str| -> Vec<&Value> {
        resolved
            .get(key)
            .and_then(Value::as_array)
            .map(|items| items.iter().collect())
            .unwrap_or_default()
    };
    let mut candidates = entries("platforms");
    candidates.extend(entries("platformAnalytics"));
    let entry = candidates
        .into_iter()
        .find(|item| item.get("platform").and_then(Value::as_str) == Some(platform.as_str()));
    let Some(id) = post_id(post) else {
        return Err(AdapterError::message_text("Zernio did not return a post ID"));
    };
    if expected.is_some_and(|expected| expected != id) {
        return Err(AdapterError::message_text(
            "Zernio returned a different post during reconciliation",
        ));
    }
    let text = |key: &str| {
        entry
            .and_then(|entry| entry.get(key))
            .and_then(Value::as_str)
            .map(str::to_owned)
    };
    Ok(ZernioPublication {
        provider_post_id: id,
        external_id: text("platformPostId"),
        url: text("platformPostUrl"),
    })
}

async fn publish_publication(ctx: &AdapterContext, input: PublicationInput<'_>) -> Result<ZernioPublication> {
    let mut platform = Map::new();
    platform.insert("platform".into(), input.platform.as_str().into());
    platform.insert("accountId".into(), input.account_id.into());
    if let Some(data) = &input.platform_specific_data {
        platform.insert("platformSpecificData".into(), data.clone());
    }
    let body = stringify(&json!({
        "content": input.content,
        "mediaItems": input.media_items,
        "platforms": [platform],
        "publishNow": true,
    }));
    for attempt in 0..2 {
        let created = async {
            let request = zernio_request(&ctx.config, Method::Post, "posts")?
                .header("Content-Type", "application/json")
                .header("x-request-id", input.request_id)
                .text(body.clone());
            let post = ctx.client.request_json(request).await?;
            publication_of(&post, input.platform, None)
        }
        .await;
        let error = match created {
            Ok(publication) => return Ok(publication),
            Err(error) => error,
        };
        if let Some(reconciled) = reconcile(ctx, input.account_id, input.platform, &error).await {
            return Ok(reconciled);
        }
        if !error.is_transport_failure() {
            return Err(error);
        }
        if attempt == 1 {
            return Err(ambiguous_error("zernio", error.message()));
        }
        // The request id makes one replay safe: Zernio answers `existingPost`
        // for the same logical publication instead of creating another.
    }
    unreachable!("the second attempt always returns")
}

/// A provider publisher for a target routed through Zernio (`zernioPublisher`).
/// Its media is the public URL preparation already staged; nothing uploads.
pub async fn publish_through_zernio(
    ctx: &AdapterContext,
    job: &ClaimedPublishJob,
    target: &str,
    platform: ZernioPlatform,
    account_id: Option<&str>,
    story: bool,
) -> Result<PublishResult> {
    let skipped = |reason: String| {
        let mut result = Map::new();
        result.insert("skipped".into(), true.into());
        result.insert("reason".into(), reason.into());
        result
    };
    if ctx.config.zernio_api_key.as_deref().is_none_or(str::is_empty) {
        return Ok(skipped("missing ZERNIO_API_KEY".into()));
    }
    let Some(account_id) = account_id.filter(|id| !id.is_empty()) else {
        return Ok(skipped(format!("{target} has no Zernio account id")));
    };
    let media: Vec<Value> = payload_media(&job.payload)
        .iter()
        .filter_map(|item| {
            let url = field(item, "vpsUrl")?;
            Some(json!({"url": url, "type": if is_video(item) { "video" } else { "image" }}))
        })
        .collect();
    // A Story is one visual and nothing else can stand in for it.
    if story && media.is_empty() {
        let mut result = Map::new();
        result.insert("ok".into(), false.into());
        result.insert("error".into(), "story_media_missing".into());
        return Ok(result);
    }
    let content = payload_text(&job.payload);
    let request_id = format!("publish-target:{}", job.job_id);
    let published = publish_publication(
        ctx,
        PublicationInput {
            account_id,
            platform,
            content: content.trim_text(),
            media_items: if story {
                media.into_iter().take(1).collect()
            } else {
                media
            },
            platform_specific_data: story.then(|| json!({"contentType": "story"})),
            request_id: &request_id,
        },
    )
    .await?;
    let mut result = Map::new();
    result.insert("ok".into(), true.into());
    result.insert(
        "id".into(),
        published
            .external_id
            .clone()
            .unwrap_or_else(|| published.provider_post_id.clone())
            .into(),
    );
    result.insert("url".into(), published.url.into());
    result.insert("providerPostId".into(), published.provider_post_id.into());
    Ok(result)
}

/// `publishZernioInstagramReel`: published at the durable job's time, fenced
/// by the request id.
pub async fn publish_zernio_instagram_reel(
    ctx: &AdapterContext,
    account_id: &str,
    public_url: &str,
    caption: &str,
    request_id: &str,
) -> Result<ZernioPublication> {
    publish_publication(
        ctx,
        PublicationInput {
            account_id,
            platform: ZernioPlatform::Instagram,
            content: caption.trim_text(),
            media_items: vec![json!({"type": "video", "url": public_url})],
            platform_specific_data: Some(json!({"contentType": "reels", "shareToFeed": true})),
            request_id,
        },
    )
    .await
}

/// `zernioPostOutcome`: the platform link when the publication landed, and
/// the platform's own refusal when it did not. The provider accepts before
/// the platform has taken it, so "created" is not "published".
pub async fn zernio_post_outcome(
    ctx: &AdapterContext,
    provider_post_id: &str,
    platform: ZernioPlatform,
) -> Result<ZernioOutcome> {
    let path = format!("posts/{}", foundation::url::encode_uri_component(provider_post_id));
    let response = ctx
        .client
        .request_json(zernio_request(&ctx.config, Method::Get, &path)?)
        .await?;
    let post = response.get("post").filter(|post| !post.is_null()).unwrap_or(&response);
    let find = |key: &str| {
        post.get(key).and_then(Value::as_array).and_then(|items| {
            items
                .iter()
                .find(|item| item.get("platform").and_then(Value::as_str) == Some(platform.as_str()))
        })
    };
    let platform_result = find("platforms");
    let platform_analytics = find("platformAnalytics");
    fn status(entry: Option<&Value>) -> Option<&str> {
        entry.and_then(|entry| entry.get("status")).and_then(Value::as_str)
    }
    let failed = post.get("status").and_then(Value::as_str) == Some("failed")
        || status(platform_result) == Some("failed")
        || status(platform_analytics) == Some("failed");
    let detail = |entry: Option<&Value>, key: &str| {
        entry.and_then(|entry| entry.get(key)).and_then(|detail| match detail {
            Value::Null => None,
            Value::String(text) => Some(text.clone()),
            other => Some(other.to_string()),
        })
    };
    Ok(ZernioOutcome {
        publication: publication_of(post, platform, Some(provider_post_id))?,
        failure: failed.then(|| {
            detail(platform_result, "error")
                .or_else(|| detail(platform_analytics, "errorMessage"))
                .unwrap_or_else(|| "the provider reported this publication as failed".into())
        }),
    })
}

/// `verifyZernioPost`.
pub async fn verify_zernio_post(
    ctx: &AdapterContext,
    provider_post_id: &str,
    platform: ZernioPlatform,
) -> Result<ZernioPublication> {
    let path = format!("posts/{}", foundation::url::encode_uri_component(provider_post_id));
    let post = ctx
        .client
        .request_json(zernio_request(&ctx.config, Method::Get, &path)?)
        .await?;
    publication_of(&post, platform, Some(provider_post_id))
}

/// An exact-account duplicate conflict is authoritative evidence of the post
/// that already exists; the lookup only enriches it with the platform id.
async fn reconcile(
    ctx: &AdapterContext,
    account_id: &str,
    platform: ZernioPlatform,
    error: &AdapterError,
) -> Option<ZernioPublication> {
    let existing = matching_duplicate_post_id(error, account_id, platform)?;
    Some(
        verify_zernio_post(ctx, &existing, platform)
            .await
            .unwrap_or(ZernioPublication {
                provider_post_id: existing,
                external_id: None,
                url: None,
            }),
    )
}

fn matching_duplicate_post_id(error: &AdapterError, account_id: &str, platform: ZernioPlatform) -> Option<String> {
    let AdapterError::Http(error) = error else { return None };
    if error.status != 409 {
        return None;
    }
    let response: Value = serde_json::from_str(error.body.as_deref().filter(|body| !body.is_empty())?).ok()?;
    let details = response.get("details");
    let text = |key: &str| details.and_then(|details| details.get(key)).and_then(Value::as_str);
    if response.get("error").and_then(Value::as_str) != Some(DUPLICATE_ERROR)
        || text("accountId") != Some(account_id)
        || text("platform") != Some(platform.as_str())
    {
        return None;
    }
    text("existingPostId").filter(|id| !id.is_empty()).map(str::to_owned)
}
