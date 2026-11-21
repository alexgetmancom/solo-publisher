//! The golden DeepSeek: the recorder's `fetch` stub for
//! `POST https://api.deepseek.com/v1/chat/completions`, behind the transport
//! the translation loop's `HttpClient` sends through. The case's seed notes
//! say what it answers: "the translator answers '<text>'." (every request,
//! 200) or "POST <url> answers, in order: [{status, body}, …]." Each request
//! is recorded among the Telegram calls as `method: "http"`, without headers
//! or body, as the recorder writes it.

use std::cell::RefCell;
use std::collections::VecDeque;
use std::rc::Rc;
use std::sync::LazyLock;

use regex::Regex;
use runtime::http::{Fut, HttpRequest, HttpResponse, Transport, TransportFailure};
use serde_json::{Value, json};

use super::telegram::FakeTelegram;

const COMPLETIONS_URL: &str = "https://api.deepseek.com/v1/chat/completions";
static ALWAYS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"the translator answers '(.*)'\.$").unwrap());
static IN_ORDER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^POST https://api\.deepseek\.com/v1/chat/completions answers, in order: (.*)\.$").unwrap()
});

enum Script {
    None,
    Always(String),
    InOrder(VecDeque<(u16, Value)>),
}

pub struct GoldenDeepSeek {
    telegram: Rc<FakeTelegram>,
    script: RefCell<Script>,
}

impl GoldenDeepSeek {
    pub fn new(telegram: Rc<FakeTelegram>) -> Self {
        Self {
            telegram,
            script: RefCell::new(Script::None),
        }
    }

    /// Applies what the case's seed notes say the recorder answers.
    pub fn script(&self, seed: &Value) {
        let notes = seed.as_array().into_iter().flatten().filter_map(Value::as_str);
        let mut script = Script::None;
        for note in notes {
            if let Some(found) = ALWAYS.captures(note) {
                script = Script::Always(found[1].replace("\\n", "\n"));
            } else if let Some(found) = IN_ORDER.captures(note) {
                let answers: Vec<Value> = serde_json::from_str(&found[1]).expect("the note's answers are JSON");
                script = Script::InOrder(
                    answers
                        .into_iter()
                        .map(|answer| (answer["status"].as_u64().unwrap() as u16, answer["body"].clone()))
                        .collect(),
                );
            }
        }
        *self.script.borrow_mut() = script;
    }

    fn answer(&self) -> Result<(u16, Value), String> {
        match &mut *self.script.borrow_mut() {
            Script::None => Err("the case scripts no translator answer".into()),
            Script::Always(text) => Ok((200, json!({"choices": [{"message": {"content": text}}]}))),
            Script::InOrder(answers) => answers
                .pop_front()
                .ok_or_else(|| "DeepSeek asked more often than the case scripts".into()),
        }
    }
}

impl Transport for GoldenDeepSeek {
    fn send(&self, request: HttpRequest) -> Fut<'_, Result<HttpResponse, TransportFailure>> {
        Box::pin(async move {
            assert_eq!(request.url, COMPLETIONS_URL, "no HTTP stub for {}", request.url);
            self.telegram
                .record_http(json!({"method": request.method.as_str(), "url": request.url}));
            let (status, body) = self.answer().map_err(|message| TransportFailure {
                message,
                timed_out: false,
            })?;
            Ok(HttpResponse::buffered(
                status,
                vec![("content-type".into(), "application/json".into())],
                body.to_string(),
            ))
        })
    }
}
