//! The Telegram objects the bot reads. Every struct keeps what it does not name
//! in `extra`, so nothing an update carried is lost on the way to a handler.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct User {
    pub id: i64,
    #[serde(default)]
    pub is_bot: bool,
    #[serde(default)]
    pub first_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct Chat {
    pub id: i64,
    #[serde(rename = "type", default)]
    pub kind: String,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct MessageEntity {
    #[serde(rename = "type")]
    pub kind: String,
    /// In UTF-16 code units, as Telegram counts.
    pub offset: i64,
    pub length: i64,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// A photo size, video, animation or document: the fields the bot reads of any
/// of them.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct MediaFile {
    pub file_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_unique_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_size: Option<i64>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct Message {
    pub message_id: i64,
    #[serde(default)]
    pub date: i64,
    pub chat: Chat,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<User>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub caption: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entities: Option<Vec<MessageEntity>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub caption_entities: Option<Vec<MessageEntity>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub photo: Option<Vec<MediaFile>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub video: Option<MediaFile>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub animation: Option<MediaFile>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub document: Option<MediaFile>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub media_group_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_topic_message: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_thread_id: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply_markup: Option<Value>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Message {
    /// `direct_messages_topic.topic_id`, which `ctx.reply` copies onto its answer.
    pub fn direct_messages_topic_id(&self) -> Option<&Value> {
        self.extra
            .get("direct_messages_topic")
            .and_then(|topic| topic.get("topic_id"))
    }
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct CallbackQuery {
    pub id: String,
    pub from: User,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<Message>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,
    #[serde(default)]
    pub chat_instance: String,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct Update {
    pub update_id: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<Message>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub edited_message: Option<Message>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel_post: Option<Message>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub edited_channel_post: Option<Message>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub callback_query: Option<CallbackQuery>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// Update kinds whose payload carries a `chat` or a `from` of its own.
const OTHER_KINDS: [&str; 12] = [
    "business_message",
    "edited_business_message",
    "message_reaction",
    "message_reaction_count",
    "my_chat_member",
    "chat_member",
    "chat_join_request",
    "inline_query",
    "chosen_inline_result",
    "shipping_query",
    "pre_checkout_query",
    "poll_answer",
];

impl Update {
    /// grammY's `ctx.msg`: the message this update is about, the tapped one
    /// for a callback.
    pub fn msg(&self) -> Option<&Message> {
        self.text_message()
            .or_else(|| self.callback_query.as_ref().and_then(|query| query.message.as_ref()))
    }

    /// The message filter queries (`:text`, `:entities:bot_command`) look at:
    /// new or edited messages and channel posts, never a tapped message.
    pub fn text_message(&self) -> Option<&Message> {
        self.message
            .as_ref()
            .or(self.edited_message.as_ref())
            .or(self.channel_post.as_ref())
            .or(self.edited_channel_post.as_ref())
    }

    /// `ctx.chat?.id`.
    pub fn chat_id(&self) -> Option<i64> {
        if let Some(message) = self.msg() {
            return Some(message.chat.id);
        }
        OTHER_KINDS
            .iter()
            .find_map(|kind| self.extra.get(*kind)?.get("chat")?.get("id")?.as_i64())
    }

    /// `ctx.from?.id`.
    pub fn from_id(&self) -> Option<i64> {
        if let Some(query) = &self.callback_query {
            return Some(query.from.id);
        }
        if let Some(message) = self.msg() {
            return message.from.as_ref().map(|from| from.id);
        }
        OTHER_KINDS.iter().find_map(|kind| {
            let payload = self.extra.get(*kind)?;
            payload.get("from").or_else(|| payload.get("user"))?.get("id")?.as_i64()
        })
    }

    /// The first key other than `update_id`, as the timing log names the type.
    pub fn kind(&self) -> &str {
        if self.message.is_some() {
            "message"
        } else if self.edited_message.is_some() {
            "edited_message"
        } else if self.channel_post.is_some() {
            "channel_post"
        } else if self.edited_channel_post.is_some() {
            "edited_channel_post"
        } else if self.callback_query.is_some() {
            "callback_query"
        } else {
            self.extra.keys().next().map_or("unknown", String::as_str)
        }
    }

    /// `ctx.callbackQuery?.data`.
    pub fn callback_data(&self) -> Option<&str> {
        self.callback_query.as_ref()?.data.as_deref()
    }

    /// `ctx.callbackQuery?.message?.message_id`.
    pub fn callback_message_id(&self) -> Option<i64> {
        self.callback_query
            .as_ref()?
            .message
            .as_ref()
            .map(|message| message.message_id)
    }
}

/// `getFile`'s answer.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct File {
    pub file_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_unique_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_size: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_chat_and_sender_like_grammy() {
        let update: Update = serde_json::from_value(json!({
            "update_id": 1,
            "callback_query": {
                "id": "q", "from": {"id": 7, "is_bot": false, "first_name": "A"}, "chat_instance": "c", "data": "noop",
                "message": {"message_id": 3, "date": 0, "chat": {"id": -5, "type": "supergroup"}, "text": "x"}
            }
        }))
        .unwrap();
        assert_eq!(
            (update.chat_id(), update.from_id(), update.kind()),
            (Some(-5), Some(7), "callback_query")
        );
        assert_eq!(update.callback_message_id(), Some(3));
        assert!(update.text_message().is_none());
        let member: Update = serde_json::from_value(json!({
            "update_id": 2, "my_chat_member": {"chat": {"id": 9, "type": "private"}, "from": {"id": 9}}
        }))
        .unwrap();
        assert_eq!(
            (member.chat_id(), member.from_id(), member.kind()),
            (Some(9), Some(9), "my_chat_member")
        );
    }
}
