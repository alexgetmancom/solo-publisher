//! The golden Zernio: the recorder's `fetch` stub for
//! `GET https://zernio.com/api/v1/accounts` and `GET …/posts/<id>` (`setHttp`
//! in scripts/rust/bot-goldens/cases-settings.ts and cases-notices.ts). The
//! case's seed notes say what the recorder did: "ZERNIO_API_KEY is set on the
//! config" / "ZERNIO_API_KEY set on the config" (`h.config.ZERNIO_API_KEY =
//! "zernio-test-key"`) and "GET <url> answers <503 | json>." Each request is
//! recorded among the Telegram calls as `method: "http"`, without its headers,
//! as the recorder writes it.

use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::sync::LazyLock;

use domain::publishing::boundaries::ProviderOutcome;
use domain::studio::boundaries::ZernioAccount;
use foundation::config::{Config, SharedConfig};
use regex::Regex;
use serde_json::{Value, json};

use super::telegram::FakeTelegram;

const ACCOUNTS_URL: &str = "https://zernio.com/api/v1/accounts";
static ANSWER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"GET https://zernio\.com/api/v1/accounts answers (.*)\.$").unwrap());
const POSTS_URL: &str = "https://zernio.com/api/v1/posts/";
static POST_ANSWER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"GET https://zernio\.com/api/v1/posts/(\S+) answers (.*)\.$").unwrap());

#[derive(Clone)]
enum Answer {
    Status(u16),
    Json(Value),
}

pub struct GoldenZernio {
    telegram: Rc<FakeTelegram>,
    answer: RefCell<Option<Answer>>,
    /// `GET posts/<id>` answers, by post id.
    posts: RefCell<Vec<(String, Value)>>,
    key_set: Cell<bool>,
}

impl GoldenZernio {
    pub fn new(telegram: Rc<FakeTelegram>) -> Self {
        Self {
            telegram,
            answer: RefCell::new(None),
            posts: RefCell::new(Vec::new()),
            key_set: Cell::new(false),
        }
    }

    /// Applies what the case's seed notes say the recorder set up.
    pub fn script(&self, seed: &Value, config: &SharedConfig) {
        let notes: Vec<&str> = seed
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .collect();
        let key_set = notes.iter().any(|note| {
            note.starts_with("ZERNIO_API_KEY is set on the config")
                || note.starts_with("ZERNIO_API_KEY set on the config")
        });
        self.key_set.set(key_set);
        *self.posts.borrow_mut() = notes
            .iter()
            .filter_map(|note| {
                let found = POST_ANSWER.captures(note)?;
                Some((
                    found[1].to_owned(),
                    serde_json::from_str(&found[2]).expect("the note's answer is JSON"),
                ))
            })
            .collect();
        if key_set {
            config.update(|current| Config {
                zernio_api_key: Some("zernio-test-key".into()),
                ..current.clone()
            });
        }
        let answer = notes.iter().find_map(|note| {
            let body = &ANSWER.captures(note)?[1];
            Some(match body.parse::<u16>() {
                Ok(status) => Answer::Status(status),
                Err(_) => Answer::Json(serde_json::from_str(body).expect("the note's answer is JSON")),
            })
        });
        *self.answer.borrow_mut() = answer;
    }

    /// `listZernioAccounts`: no key, no request; anything but a 2xx JSON
    /// answer is an error.
    pub fn accounts(&self, config: &Config) -> domain::Result<Vec<ZernioAccount>> {
        if config.zernio_api_key.as_deref().is_none_or(str::is_empty) {
            return Err(domain::Error::message("ZERNIO_API_KEY is missing"));
        }
        // The recorder's stub throws before recording when the case set no handler.
        let answer = self
            .answer
            .borrow()
            .clone()
            .ok_or_else(|| domain::Error::message(format!("Unexpected network request: {ACCOUNTS_URL}")))?;
        self.telegram.record_http(json!({"method": "GET", "url": ACCOUNTS_URL}));
        match answer {
            Answer::Status(status) => Err(domain::Error::message(format!("HTTP {status}"))),
            Answer::Json(body) => {
                let accounts = match body {
                    Value::Array(_) => body,
                    mut object => object["accounts"].take(),
                };
                Ok(serde_json::from_value::<Option<Vec<ZernioAccount>>>(accounts)
                    .expect("Zernio accounts")
                    .unwrap_or_default())
            }
        }
    }
    /// `zernioPostOutcome(config, providerPostId, platform)`: what the
    /// provider says became of one publication.
    pub fn post_outcome(&self, provider_post_id: &str, platform: &str) -> domain::Result<ProviderOutcome> {
        if !self.key_set.get() {
            return Err(domain::Error::message("ZERNIO_API_KEY is missing"));
        }
        let url = format!("{POSTS_URL}{provider_post_id}");
        let response = self
            .posts
            .borrow()
            .iter()
            .find(|(id, _)| id == provider_post_id)
            .map(|(_, body)| body.clone())
            .ok_or_else(|| domain::Error::message(format!("Unexpected network request: {url}")))?;
        self.telegram.record_http(json!({"method": "GET", "url": url}));
        let post = if response["post"].is_object() {
            &response["post"]
        } else {
            &response
        };
        let find = |list: &Value| {
            list.as_array()
                .into_iter()
                .flatten()
                .find(|item| item["platform"] == platform)
                .cloned()
        };
        let platform_result = find(&post["platforms"]);
        let platform_analytics = find(&post["platformAnalytics"]);
        let failed = post["status"] == "failed"
            || platform_result.as_ref().is_some_and(|item| item["status"] == "failed")
            || platform_analytics
                .as_ref()
                .is_some_and(|item| item["status"] == "failed");
        // `zernioPublishResult(post, platform, providerPostId)`.
        let resolved = [&post["post"], &post["existingPost"]]
            .into_iter()
            .find(|candidate| candidate.is_object())
            .unwrap_or(post);
        let landed = resolved["platforms"]
            .as_array()
            .into_iter()
            .flatten()
            .chain(resolved["platformAnalytics"].as_array().into_iter().flatten())
            .find(|item| item["platform"] == platform);
        let id = [
            &post["_id"],
            &post["id"],
            &post["post"]["_id"],
            &post["post"]["id"],
            &post["existingPost"]["_id"],
            &post["existingPost"]["id"],
        ]
        .into_iter()
        .find_map(Value::as_str)
        .ok_or_else(|| domain::Error::message("Zernio did not return a post ID"))?;
        if id != provider_post_id {
            return Err(domain::Error::message(
                "Zernio returned a different post during reconciliation",
            ));
        }
        let text = |value: Option<&Value>, key: &str| value.and_then(|item| item[key].as_str()).map(str::to_owned);
        Ok(ProviderOutcome {
            provider_post_id: Some(id.to_owned()),
            external_id: text(landed, "platformPostId"),
            url: text(landed, "platformPostUrl"),
            failure: failed.then(|| {
                text(platform_result.as_ref(), "error")
                    .or_else(|| text(platform_analytics.as_ref(), "errorMessage"))
                    .unwrap_or_else(|| "the provider reported this publication as failed".to_owned())
            }),
        })
    }
}
