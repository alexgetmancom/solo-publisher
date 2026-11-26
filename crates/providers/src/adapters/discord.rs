//! A post to an announcement channel as one
//! message per text part, the media under the last one.

use std::path::Path;

use content::message::MediaItem;
use content::text::split_text;
use domain::json::stringify;
use domain::publishing::errors::PublishResult;
use domain::publishing::platform_profiles::platform_profile;
use foundation::js::encode_uri_component;
use foundation::logger::{LogLevel, log};
use runtime::http::{HttpRequest, Method, Response};
use serde_json::{Map, Value, json};

use crate::adapters::error::{AdapterError, Result, ambiguous_mutation, publish_json, refused};
use crate::adapters::multipart::Form;
use crate::adapters::payload::{exists, field, guess_content_type, media_extension, payload_media, payload_text};
use crate::adapters::ports::{AdapterContext, EditOutcome, EditRequest};

const API_BASE_URL: &str = "https://discord.com/api/v10";
/// Discord accepts at most ten attachments on one message.
const MAX_ATTACHMENTS: usize = 10;
const DEFAULT_TEXT_LIMIT: usize = 2000;

struct Credentials<'a> {
    token: &'a str,
    channel_id: &'a str,
    guild_id: Option<&'a str>,
}

fn credentials(ctx: &AdapterContext) -> Result<Credentials<'_>> {
    fn set(value: &Option<String>) -> Option<&str> {
        value.as_deref().filter(|value| !value.is_empty())
    }
    let token = set(&ctx.config.discord_bot_token);
    let channel_id = set(&ctx.config.discord_channel_id);
    let (Some(token), Some(channel_id)) = (token, channel_id) else {
        let missing: Vec<&str> = [
            token.is_none().then_some("DISCORD_BOT_TOKEN"),
            channel_id.is_none().then_some("DISCORD_CHANNEL_ID"),
        ]
        .into_iter()
        .flatten()
        .collect();
        return Err(AdapterError::Message(format!(
            "Discord is not configured: {}",
            missing.join(", ")
        )));
    };
    Ok(Credentials {
        token,
        channel_id,
        guild_id: ctx.config.discord_guild_id.as_deref(),
    })
}

fn text_limit() -> usize {
    platform_profile("discord")
        .and_then(|profile| profile.limits.text)
        .unwrap_or(DEFAULT_TEXT_LIMIT)
}

/// Where a split post's already-published message ids travel on its job.
const MESSAGES_RESUME_KEY: &str = "_discordMessageIds";

/// `publishToDiscord`. Every id is returned: a two-part post is two objects
/// to verify, edit or delete later.
///
/// Deliberately does not throw when a later part is refused after the first
/// is already in the channel, because the retry would post the first again:
/// the ids that went out are handed back as a partial publication (as X and
/// Threads do), and the retry sends only the rest.
pub async fn publish_to_discord(ctx: &AdapterContext, payload: &Map<String, Value>) -> Result<PublishResult> {
    let credentials = credentials(ctx)?;
    let parts = split_text(&payload_text(payload), text_limit());
    let media: Vec<MediaItem> = payload_media(payload)
        .into_iter()
        .filter(|item| field(item, "localPath").is_some_and(exists))
        .take(MAX_ATTACHMENTS)
        .collect();
    // The queue stores a resume under its key as the id list it settled with.
    let mut ids: Vec<String> = match payload.get(MESSAGES_RESUME_KEY) {
        Some(Value::Array(ids)) => ids
            .iter()
            .filter_map(Value::as_str)
            .filter(|id| !id.is_empty())
            .map(str::to_owned)
            .collect(),
        _ => Vec::new(),
    };

    let resumed = ids.len();
    for (index, part) in parts.iter().enumerate().skip(resumed) {
        let last = index == parts.len() - 1;
        let sent = async {
            let message = create_message(ctx, &credentials, part, if last { &media } else { &[] }).await?;
            match message.get("id").and_then(Value::as_str).filter(|id| !id.is_empty()) {
                Some(id) => Ok(id.to_owned()),
                None => Err(AdapterError::message_text("Discord message create returned no id")),
            }
        }
        .await;
        let id = match sent {
            Ok(id) => id,
            // A lost answer may be a message in the channel: verification,
            // never a resend. Nothing out yet: an ordinary failure.
            Err(error) if error.is_ambiguous() || ids.is_empty() => return Err(error),
            Err(error) => {
                let mut result = Map::new();
                result.insert("ok".into(), false.into());
                result.insert("partial".into(), true.into());
                result.insert("retryable".into(), true.into());
                result.insert("resumeKey".into(), MESSAGES_RESUME_KEY.into());
                result.insert("ids".into(), json!(ids));
                result.insert("error".into(), error.message().into());
                return Ok(result);
            }
        };
        crosspost(ctx, &credentials, &id).await;
        ids.push(id);
    }

    let first = ids.first().cloned();
    let mut result = Map::new();
    result.insert("ok".into(), first.is_some().into());
    result.insert("id".into(), first.clone().map_or(Value::Null, Value::from));
    result.insert("ids".into(), json!(ids));
    result.insert(
        "url".into(),
        first
            .and_then(|id| message_url(&credentials, &id))
            .map_or(Value::Null, Value::from),
    );
    Ok(result)
}

/// `verifyDiscordMessage`: the message, read back from its own channel.
pub async fn verify_discord_message(ctx: &AdapterContext, id: &str) -> Result<(String, Value)> {
    let credentials = credentials(ctx)?;
    let response = discord_fetch(ctx, &credentials, Method::Get, &message_path(&credentials, id), None).await?;
    let message = publish_json(response, "Discord message verify").await?;
    if message.get("id").and_then(Value::as_str) != Some(id) {
        return Err(AdapterError::message_text(
            "Discord verification did not return the expected message",
        ));
    }
    Ok((
        id.to_owned(),
        message_url(&credentials, id).map_or(Value::Null, Value::from),
    ))
}

/// The Discord `remove` port.
pub async fn delete_discord_message(ctx: &AdapterContext, id: &str) -> Result<Value> {
    let credentials = credentials(ctx)?;
    let response = discord_fetch(ctx, &credentials, Method::Delete, &message_path(&credentials, id), None).await?;
    if !response.ok() {
        return Err(refused(response, "Discord message delete").await);
    }
    Ok(Value::Null)
}

/// The Discord `edit` port: a split post or a text over the limit is not
/// edited, because the edit would no longer be the post.
pub async fn edit_discord(ctx: &AdapterContext, edit: &EditRequest) -> Result<EditOutcome> {
    if edit.external_id_count > 1 {
        return Ok(EditOutcome::skipped("discord_post_is_split"));
    }
    if foundation::js::utf16_len(&edit.text) > text_limit() {
        return Ok(EditOutcome::skipped("edit_exceeds_discord_limit"));
    }
    let credentials = credentials(ctx)?;
    let body = stringify(&json!({"content": edit.text}));
    let response = discord_fetch(
        ctx,
        &credentials,
        Method::Patch,
        &message_path(&credentials, &edit.external_id),
        Some(body),
    )
    .await?;
    Ok(EditOutcome {
        ok: true,
        skipped: false,
        error: None,
        response: Some(publish_json(response, "Discord message edit").await?),
    })
}

fn message_path(credentials: &Credentials, id: &str) -> String {
    format!(
        "/channels/{}/messages/{}",
        credentials.channel_id,
        encode_uri_component(id)
    )
}

async fn create_message(
    ctx: &AdapterContext,
    credentials: &Credentials<'_>,
    content: &str,
    media: &[MediaItem],
) -> Result<Value> {
    let url = format!("{API_BASE_URL}/channels/{}/messages", credentials.channel_id);
    let request = HttpRequest::post(url);
    let request = if media.is_empty() {
        request
            .header("Content-Type", "application/json")
            .text(stringify(&json!({"content": content})))
    } else {
        attachment_form(content, media).attach(request)
    };
    let request = request.header("Authorization", format!("Bot {}", credentials.token));
    let response = ambiguous_mutation("discord", async { Ok(ctx.client.fetch(request).await?) }).await?;
    publish_json(response, "Discord message create").await
}

/// The channel is an announcement channel, so a message reaches following
/// servers only once it is published. That second call's failure is
/// deliberately not the publication's: the message is already in the
/// channel, and failing here would retry the job and post it twice.
async fn crosspost(ctx: &AdapterContext, credentials: &Credentials<'_>, id: &str) {
    let path = format!("{}/crosspost", message_path(credentials, id));
    let outcome = match discord_fetch(ctx, credentials, Method::Post, &path, None).await {
        Ok(response) if response.ok() => return,
        Ok(response) => refused(response, "Discord crosspost").await,
        Err(error) => error,
    };
    log(
        LogLevel::Warn,
        "Discord crosspost failed",
        Some(json!({"messageId": id, "channelId": credentials.channel_id, "error": format!("Error: {outcome}")})),
    );
}

fn attachment_form(content: &str, media: &[MediaItem]) -> Form {
    let mut form = Form::new();
    let attachments: Vec<Value> = media
        .iter()
        .enumerate()
        .map(|(index, item)| json!({"id": index, "filename": format!("media-{index}{}", media_extension(item))}))
        .collect();
    form.text(
        "payload_json",
        &stringify(&json!({"content": content, "attachments": attachments})),
    );
    for (index, item) in media.iter().enumerate() {
        let local_path = field(item, "localPath").unwrap_or_default();
        form.file(
            &format!("files[{index}]"),
            Path::new(local_path),
            &format!("media-{index}{}", media_extension(item)),
            guess_content_type(local_path),
        );
    }
    form
}

fn message_url(credentials: &Credentials, id: &str) -> Option<String> {
    let guild = credentials.guild_id.filter(|guild| !guild.is_empty())?;
    Some(format!(
        "https://discord.com/channels/{guild}/{}/{id}",
        credentials.channel_id
    ))
}

async fn discord_fetch(
    ctx: &AdapterContext,
    credentials: &Credentials<'_>,
    method: Method,
    path: &str,
    json_body: Option<String>,
) -> Result<Response> {
    let mut request = HttpRequest::new(method, format!("{API_BASE_URL}{path}"));
    if let Some(body) = json_body {
        request = request.header("Content-Type", "application/json").text(body);
    }
    let request = request.header("Authorization", format!("Bot {}", credentials.token));
    Ok(ctx.client.fetch(request).await?)
}
