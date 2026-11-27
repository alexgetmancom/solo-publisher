//! The channel post over the Bot API, with the Telegram edit and remove ports.

use std::path::Path;

use crate::external::telegram::{BotApi, BotParams};
use content::message::{Entity, MediaItem, entity_span};
use content::text::entities_to_html;
use content::thread::LocalizedThreadPart;
use domain::json::stringify;
use domain::publishing::errors::PublishResult;
use domain::publishing::media_policy::select_media_for_target;
use foundation::text::{utf16_len, utf16_prefix};
use serde_json::{Map, Value, json};

use crate::adapters::error::{Result, ambiguous_mutation};
use crate::adapters::multipart::Form;
use crate::adapters::payload::{basename, field, is_video, payload_media, payload_text, payload_thread};
use crate::adapters::ports::{AdapterContext, EditOutcome, EditRequest};

const CAPTION_LIMIT: usize = 1024;

/// `publishToTelegram`.
pub async fn publish_to_telegram(ctx: &AdapterContext, payload: &Map<String, Value>) -> Result<PublishResult> {
    let Some(token) = ctx
        .config
        .controller_bot_token
        .as_deref()
        .filter(|token| !token.is_empty())
    else {
        return Ok(skipped("missing Telegram bot token"));
    };
    // Named alongside the token it travels with: without this the chat id
    // would be a bare "@", and Telegram would answer with a generic
    // bad-request rather than the missing setting it is.
    let channel = ctx
        .config
        .telegram_channel_username
        .strip_prefix('@')
        .unwrap_or(&ctx.config.telegram_channel_username);
    if channel.is_empty() {
        return Ok(skipped("missing TELEGRAM_CHANNEL_USERNAME"));
    }
    let chat_id = format!("@{channel}");
    let text = payload_text(payload);
    let media = payload_media(payload);
    let entities = payload.get("entities").and_then(Value::as_array);
    let thread = payload_thread(payload);
    let telegram = Telegram {
        api: bot_api(ctx, token),
        chat_id,
    };
    if !thread.is_empty() {
        let first = LocalizedThreadPart {
            text,
            entities: entities.map_or_else(Vec::new, |entities| records(entities)),
            media,
        };
        let posts: Vec<LocalizedThreadPart> = std::iter::once(first).chain(thread).collect();
        return telegram.publish_rich_thread(&posts).await;
    }
    let caption = telegram_caption(&text, entities);

    if media.len() > 1 {
        let mut attachments = Vec::new();
        let values: Vec<Value> = media.iter().cloned().map(Value::Object).collect();
        let items: Vec<Value> = select_media_for_target("telegram", &values, |value| value)
            .iter()
            .filter_map(Value::as_object)
            .enumerate()
            .map(|(index, item)| {
                let mut entry = Map::new();
                entry.insert("type".into(), if is_video(item) { "video" } else { "photo" }.into());
                if let Some(source) = media_source(item, &format!("media-{index}"), &mut attachments) {
                    entry.insert("media".into(), source.into());
                }
                if index == 0 {
                    entry.insert("caption".into(), caption.text.clone().into());
                    entry.insert("caption_entities".into(), Value::Array(caption.entities.clone()));
                }
                Value::Object(entry)
            })
            .collect();
        let body = if attachments.is_empty() {
            Call::Json(json!({"chat_id": telegram.chat_id, "media": items}))
        } else {
            Call::Form(
                vec![
                    ("chat_id", telegram.chat_id.clone()),
                    ("media", stringify(&Value::Array(items))),
                ],
                attachments,
            )
        };
        let result = ambiguous_mutation("telegram", telegram.call("sendMediaGroup", body)).await?;
        return Ok(telegram.react(telegram.normalize(result)).await);
    }

    if let Some(item) = media.first() {
        let (method, key) = if is_video(item) {
            ("sendVideo", "video")
        } else {
            ("sendPhoto", "photo")
        };
        let mut attachments = Vec::new();
        let source = media_source(item, &format!("file-{key}"), &mut attachments);
        let body = if attachments.is_empty() {
            let mut fields = Map::new();
            fields.insert("chat_id".into(), telegram.chat_id.clone().into());
            if let Some(source) = source {
                fields.insert(key.into(), source.into());
            }
            fields.insert("caption".into(), caption.text.clone().into());
            fields.insert("caption_entities".into(), Value::Array(caption.entities.clone()));
            Call::Json(Value::Object(fields))
        } else {
            Call::Form(
                vec![
                    ("chat_id", telegram.chat_id.clone()),
                    (key, source.unwrap_or_default()),
                    ("caption", caption.text.clone()),
                    ("caption_entities", stringify(&Value::Array(caption.entities.clone()))),
                ],
                attachments,
            )
        };
        let result = ambiguous_mutation("telegram", telegram.call(method, body)).await?;
        return Ok(telegram.react(telegram.normalize(result)).await);
    }

    let mut fields = Map::new();
    fields.insert("chat_id".into(), telegram.chat_id.clone().into());
    fields.insert("text".into(), text.into());
    if let Some(entities) = entities {
        fields.insert("entities".into(), Value::Array(entities.clone()));
    }
    match link_preview(entities) {
        Some(url) => fields.insert(
            "link_preview_options".into(),
            json!({"url": url, "prefer_small_media": true, "show_above_text": false}),
        ),
        None => fields.insert("disable_web_page_preview".into(), false.into()),
    };
    let result = ambiguous_mutation(
        "telegram",
        telegram.call("sendMessage", Call::Json(Value::Object(fields))),
    )
    .await?;
    Ok(telegram.react(telegram.normalize(result)).await)
}

fn skipped(reason: &str) -> PublishResult {
    let mut result = Map::new();
    result.insert("skipped".into(), true.into());
    result.insert("reason".into(), reason.into());
    result
}

fn records(values: &[Value]) -> Vec<Entity> {
    values.iter().filter_map(|value| value.as_object().cloned()).collect()
}

/// A local file sent under its attachment name.
struct Attachment {
    name: String,
    local_path: String,
}

enum Call {
    Json(Value),
    Form(Vec<(&'static str, String)>, Vec<Attachment>),
}

struct Telegram {
    api: BotApi,
    chat_id: String,
}

impl Telegram {
    async fn call(&self, method: &str, body: Call) -> Result<Value> {
        let params = match body {
            Call::Json(value) => BotParams::json(stringify(&value)),
            Call::Form(fields, attachments) => {
                let mut form = Form::new();
                for (name, value) in &fields {
                    form.text(name, value);
                }
                for attachment in &attachments {
                    form.file(
                        &attachment.name,
                        Path::new(&attachment.local_path),
                        basename(&attachment.local_path),
                        crate::adapters::payload::guess_content_type(&attachment.local_path),
                    );
                }
                let (boundary, body) = form.finish();
                BotParams::multipart(&boundary, body)
            }
        };
        Ok(self.api.request_json(method, params).await?)
    }

    /// A thread is one rich message (Bot API 10.1): each part's text as a
    /// paragraph followed by its own media, in the order the author wrote
    /// them. An ordinary post never comes here.
    async fn publish_rich_thread(&self, posts: &[LocalizedThreadPart]) -> Result<PublishResult> {
        let mut attachments = Vec::new();
        let mut media = Vec::new();
        let mut blocks = Vec::new();
        for post in posts {
            if !post.text.trim().is_empty() {
                blocks.push(format!("<p>{}</p>", rich_html(&post.text, &post.entities)));
            }
            for item in &post.media {
                let id = format!("m{}", media.len() + 1);
                let Some(source) = media_source(item, &format!("rich-{id}"), &mut attachments) else {
                    continue;
                };
                let video = is_video(item);
                media
                    .push(json!({"id": id, "media": {"type": if video { "video" } else { "photo" }, "media": source}}));
                blocks.push(if video {
                    format!("<video src=\"tg://video?id={id}\"></video>")
                } else {
                    format!("<img src=\"tg://photo?id={id}\"/>")
                });
            }
        }
        let mut rich = Map::new();
        rich.insert("html".into(), blocks.concat().into());
        if !media.is_empty() {
            rich.insert("media".into(), Value::Array(media));
        }
        let body = if attachments.is_empty() {
            Call::Json(json!({"chat_id": self.chat_id, "rich_message": rich}))
        } else {
            Call::Form(
                vec![
                    ("chat_id", self.chat_id.clone()),
                    ("rich_message", stringify(&Value::Object(rich))),
                ],
                attachments,
            )
        };
        let result = ambiguous_mutation("telegram", self.call("sendRichMessage", body)).await?;
        Ok(self.react(self.normalize(result)).await)
    }

    /// `normalizeTelegramResult`.
    fn normalize(&self, response: Value) -> PublishResult {
        let mut result = Map::new();
        if response["ok"] != true {
            result.insert("ok".into(), false.into());
            result.insert(
                "error".into(),
                response
                    .get("description")
                    .filter(|description| !description.is_null())
                    .cloned()
                    .unwrap_or_else(|| "telegram_api_failed".into()),
            );
            return result;
        }
        let records: Vec<&Value> = match response.get("result") {
            Some(Value::Array(items)) => items.iter().collect(),
            other => vec![other.unwrap_or(&Value::Null)],
        };
        let ids: Vec<Value> = records
            .into_iter()
            .filter_map(|record| record.get("message_id"))
            .filter(|id| id.is_string() || id.is_number())
            .cloned()
            .collect();
        let channel = self.chat_id.strip_prefix('@');
        let first = ids.first().cloned();
        let url = match (channel, first.as_ref().and_then(Value::as_i64)) {
            (Some(channel), Some(id)) if id != 0 => Value::from(format!("https://t.me/{channel}/{id}")),
            _ => Value::Null,
        };
        result.insert("ok".into(), true.into());
        result.insert("id".into(), first.unwrap_or(Value::Null));
        result.insert("ids".into(), Value::Array(ids));
        result.insert("url".into(), url);
        result.insert("raw".into(), response);
        result
    }

    /// The heart reaction. Its permission is optional, and failing it must not
    /// retry a post that is already published.
    async fn react(&self, result: PublishResult) -> PublishResult {
        let Some(id) = result.get("id").filter(|id| result["ok"] == true && !id.is_null()) else {
            return result;
        };
        let body = json!({
            "chat_id": self.chat_id,
            "message_id": id,
            "reaction": [{"type": "emoji", "emoji": "❤"}],
            "is_big": false,
        });
        let _ = self.call("setMessageReaction", Call::Json(body)).await;
        result
    }
}

fn bot_api(ctx: &AdapterContext, token: &str) -> BotApi {
    BotApi::new(ctx.client.clone(), &ctx.config.telegram_api_base_url, token)
}

/// `telegramMediaSource`: a file id or public URL is sent as it is; a local
/// file becomes an attachment.
fn media_source(item: &MediaItem, attachment_name: &str, attachments: &mut Vec<Attachment>) -> Option<String> {
    if let Some(source) = field(item, "fileId").or_else(|| field(item, "vpsUrl")) {
        return Some(source.to_owned());
    }
    let local_path = field(item, "localPath")?;
    attachments.push(Attachment {
        name: attachment_name.to_owned(),
        local_path: local_path.to_owned(),
    });
    Some(format!("attach://{attachment_name}"))
}

/// The site's entity renderer, in the tags rich HTML knows.
fn rich_html(text: &str, entities: &[Entity]) -> String {
    entities_to_html(text, entities)
        .replace(" rel=\"noopener noreferrer\"", "")
        .replace("<span class=\"spoiler\">", "<tg-spoiler>")
        .replace("</span>", "</tg-spoiler>")
}

/// The first `text_link` whose URL is http(s), for a small link preview.
fn link_preview(entities: Option<&Vec<Value>>) -> Option<&str> {
    entities?.iter().filter_map(Value::as_object).find_map(|entity| {
        let url = entity.get("url").and_then(Value::as_str)?;
        (entity.get("type").and_then(Value::as_str) == Some("text_link")
            && url::Url::parse(url).is_ok_and(|parsed| matches!(parsed.scheme(), "http" | "https")))
        .then_some(url)
    })
}

struct Caption {
    text: String,
    entities: Vec<Value>,
}

/// Keeps a malformed queued caption inside Telegram's hard limit, without
/// splitting a surrogate pair (offsets are UTF-16 units), and drops or clamps
/// the entities that would point past it.
fn telegram_caption(text: &str, entities: Option<&Vec<Value>>) -> Caption {
    let caption = utf16_prefix(text, CAPTION_LIMIT).to_owned();
    let length = utf16_len(&caption) as u64;
    let entities = entities
        .into_iter()
        .flatten()
        .filter_map(Value::as_object)
        .filter_map(|value| {
            let (offset, entity_length) = entity_span(value)?;
            if entity_length == 0 || offset >= length {
                return None;
            }
            let mut entity = value.clone();
            entity.insert("offset".into(), offset.into());
            entity.insert("length".into(), entity_length.min(length - offset).into());
            Some(Value::Object(entity))
        })
        .collect();
    Caption {
        text: caption,
        entities,
    }
}

/// The Telegram `edit` port: the caption of a media post, the text of any other.
pub async fn edit_telegram_message(ctx: &AdapterContext, edit: &EditRequest) -> Result<EditOutcome> {
    let Some(token) = ctx
        .config
        .controller_bot_token
        .as_deref()
        .filter(|token| !token.is_empty())
    else {
        return Ok(EditOutcome::skipped("missing CONTROLLER_BOT_TOKEN"));
    };
    let (method, key) = if edit.media_count > 0 {
        ("editMessageCaption", "caption")
    } else {
        ("editMessageText", "text")
    };
    let chat_id = edit
        .chat_id
        .clone()
        .filter(|chat_id| !chat_id.is_null())
        .unwrap_or_else(|| ctx.config.telegram_channel_username.clone().into());
    let mut body = Map::new();
    body.insert("chat_id".into(), chat_id);
    body.insert("message_id".into(), edit.external_id.parse::<i64>().ok().into());
    body.insert(key.into(), edit.text.clone().into());
    let response = bot_api(ctx, token)
        .request_json(method, BotParams::json(stringify(&Value::Object(body))))
        .await?;
    Ok(EditOutcome {
        ok: response.get("ok") != Some(&Value::Bool(false)),
        skipped: false,
        error: None,
        response: Some(response),
    })
}

/// The Telegram `remove` port: `deleteMessage` in the channel.
pub async fn delete_telegram_message(ctx: &AdapterContext, external_id: &str) -> Result<Value> {
    let Some(token) = ctx
        .config
        .controller_bot_token
        .as_deref()
        .filter(|token| !token.is_empty())
    else {
        return Err(crate::adapters::AdapterError::message_text(
            "missing CONTROLLER_BOT_TOKEN",
        ));
    };
    let body = json!({
        "chat_id": ctx.config.telegram_channel_username,
        "message_id": external_id.parse::<i64>().ok(),
    });
    Ok(bot_api(ctx, token)
        .request_json("deleteMessage", BotParams::json(stringify(&body)))
        .await?)
}
