//! DeepSeek chat completions, used for draft translation.

use std::time::Duration;

use foundation::config::Config;
use serde_json::{Map, Value, json};

use runtime::http::{ExternalError, HttpClient, HttpRequest};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    System,
    User,
    Assistant,
}

impl Role {
    fn as_str(self) -> &'static str {
        match self {
            Self::System => "system",
            Self::User => "user",
            Self::Assistant => "assistant",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeepSeekMessage {
    pub role: Role,
    pub content: String,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ChatOptions {
    pub temperature: f64,
    /// Over the whole exchange, the answer's body included.
    pub timeout: Duration,
    /// Ask for a JSON object (`response_format`).
    pub json: bool,
}

/// The first choice's text, trimmed; empty when there is none.
pub async fn deepseek_chat(
    client: &HttpClient,
    config: &Config,
    messages: &[DeepSeekMessage],
    options: ChatOptions,
) -> Result<String, ExternalError> {
    let Some(key) = config.deepseek_api_key.as_deref().filter(|key| !key.is_empty()) else {
        return Err(ExternalError::message("DEEPSEEK_API_KEY is not configured"));
    };
    let mut body = Map::new();
    body.insert("model".into(), "deepseek-chat".into());
    body.insert(
        "messages".into(),
        messages
            .iter()
            .map(|message| json!({"role": message.role.as_str(), "content": message.content}))
            .collect(),
    );
    body.insert("temperature".into(), options.temperature.into());
    if options.json {
        body.insert("response_format".into(), json!({"type": "json_object"}));
    }
    let request = HttpRequest::post("https://api.deepseek.com/v1/chat/completions")
        .header("Authorization", format!("Bearer {key}"))
        .header("Content-Type", "application/json")
        .text(Value::Object(body).to_string())
        .deadline(options.timeout);
    let result = client.request_json(request).await?;
    let content = result
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .unwrap_or_default();
    Ok(content.trim().to_owned())
}
