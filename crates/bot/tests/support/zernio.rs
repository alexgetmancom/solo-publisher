//! The golden Zernio directory: the recorder's `fetch` stub for
//! `GET https://zernio.com/api/v1/accounts` (`setHttp` in
//! scripts/rust/bot-goldens/cases-settings.ts). The case's seed notes say what
//! the recorder did: "ZERNIO_API_KEY is set on the config" (`h.config.ZERNIO_API_KEY
//! = "zernio-test-key"`) and "GET <url> answers <503 | json>." Each request is
//! recorded among the Telegram calls as `method: "http"`, without its headers,
//! as the recorder writes it.

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::LazyLock;

use domain::studio::boundaries::ZernioAccount;
use foundation::config::{Config, SharedConfig};
use regex::Regex;
use serde_json::{Value, json};

use super::telegram::FakeTelegram;

const ACCOUNTS_URL: &str = "https://zernio.com/api/v1/accounts";
static ANSWER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"GET https://zernio\.com/api/v1/accounts answers (.*)\.$").unwrap());

#[derive(Clone)]
enum Answer {
    Status(u16),
    Json(Value),
}

pub struct GoldenZernio {
    telegram: Rc<FakeTelegram>,
    answer: RefCell<Option<Answer>>,
}

impl GoldenZernio {
    pub fn new(telegram: Rc<FakeTelegram>) -> Self {
        Self {
            telegram,
            answer: RefCell::new(None),
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
        if notes
            .iter()
            .any(|note| note.starts_with("ZERNIO_API_KEY is set on the config"))
        {
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
}
