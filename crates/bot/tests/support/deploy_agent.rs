//! The golden deploy agent: the recorder's `fetch` stub for the deploy agent
//! (`agentAnswers` in scripts/rust/bot-goldens/cases-ops.ts). Each request is
//! recorded among the Telegram calls as `method: "http"` with its body, as the
//! recorder writes it, and answered with what the case's seed says the agent
//! answers ("The deploy agent answers <status> <json>.").

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::LazyLock;

use bot::Fut;
use bot::deployment::{AgentResponse, DeployAgent};
use regex::Regex;
use serde_json::{Value, json};

use super::telegram::FakeTelegram;

static ANSWER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^The deploy agent answers (\d+) (.*)\.$").unwrap());

pub struct GoldenDeployAgent {
    telegram: Rc<FakeTelegram>,
    answer: RefCell<Option<AgentResponse>>,
}

impl GoldenDeployAgent {
    pub fn new(telegram: Rc<FakeTelegram>) -> Self {
        Self {
            telegram,
            answer: RefCell::new(None),
        }
    }

    /// Takes the agent's answer from the case's seed notes, if it has one.
    pub fn script(&self, seed: &Value) {
        let answer = seed.as_array().into_iter().flatten().find_map(|note| {
            let captures = ANSWER.captures(note.as_str()?)?;
            Some(AgentResponse {
                status: captures[1].parse().ok()?,
                body: captures[2].as_bytes().to_vec(),
            })
        });
        *self.answer.borrow_mut() = answer;
    }
}

impl DeployAgent for GoldenDeployAgent {
    fn post<'a>(&'a self, url: &'a str, _: &'a str, body: &'a str) -> Fut<'a, Result<AgentResponse, String>> {
        let body = serde_json::from_str(body).unwrap_or_else(|_| Value::String(body.to_owned()));
        self.telegram
            .record_http(json!({"method": "POST", "url": url, "body": body}));
        // A case that never scripted the agent reached it anyway: the recorder's
        // stub would have thrown, which the client reads as no answer.
        let answer = self
            .answer
            .borrow()
            .clone()
            .ok_or_else(|| format!("no HTTP stub for {url}"));
        Box::pin(async move { answer })
    }
}
