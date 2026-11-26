//! The golden Zernio: the recorder's `fetch` stub for
//! `GET https://zernio.com/api/v1/accounts` and `GET …/posts/<id>` (`setHttp`
//! in the recorder's settings and notices cases), behind the transport the
//! Studio's provider calls send through. The case's seed notes say what the
//! recorder did: "ZERNIO_API_KEY is set on the config" / "ZERNIO_API_KEY set
//! on the config" (`h.config.ZERNIO_API_KEY = "zernio-test-key"`) and "GET
//! <url> answers <503 | json>." Each request is recorded among the Telegram
//! calls as `method: "http"`, without its headers, as the recorder writes it.

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::LazyLock;

use foundation::config::{Config, SharedConfig};
use regex::Regex;
use runtime::http::{Fut, HttpRequest, HttpResponse, Transport, TransportFailure};
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

pub(crate) struct GoldenZernio {
    telegram: Rc<FakeTelegram>,
    answer: RefCell<Option<Answer>>,
    /// `GET posts/<id>` answers, by post id.
    posts: RefCell<Vec<(String, Value)>>,
}

impl GoldenZernio {
    pub(crate) fn new(telegram: Rc<FakeTelegram>) -> Self {
        Self {
            telegram,
            answer: RefCell::new(None),
            posts: RefCell::new(Vec::new()),
        }
    }

    /// Applies what the case's seed notes say the recorder set up.
    pub(crate) fn script(&self, seed: &Value, config: &SharedConfig) {
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
}

impl Transport for GoldenZernio {
    fn send(&self, request: HttpRequest) -> Fut<'_, Result<HttpResponse, TransportFailure>> {
        Box::pin(async move {
            let answer = if request.url == ACCOUNTS_URL {
                self.answer.borrow().clone()
            } else {
                let id = request
                    .url
                    .strip_prefix(POSTS_URL)
                    .unwrap_or_else(|| panic!("no HTTP stub for {}", request.url));
                self.posts
                    .borrow()
                    .iter()
                    .find(|(post, _)| post == id)
                    .map(|(_, body)| Answer::Json(body.clone()))
            };
            // The recorder's stub throws before recording when the case set no handler.
            let answer = answer.ok_or_else(|| TransportFailure {
                message: format!("Unexpected network request: {}", request.url),
                timed_out: false,
            })?;
            self.telegram
                .record_http(json!({"method": request.method.as_str(), "url": request.url}));
            let (status, body) = match answer {
                Answer::Status(status) => (status, String::new()),
                Answer::Json(body) => (200, body.to_string()),
            };
            Ok(HttpResponse::buffered(
                status,
                vec![("content-type".into(), "application/json".into())],
                body,
            ))
        })
    }
}
