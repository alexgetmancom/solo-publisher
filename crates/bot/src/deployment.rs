//! The deploy agent's promote and rollback requests:
//! what a deployment control may name, and the request with its retries. The
//! HTTP exchange itself is the [`DeployAgent`] the bot is built with, so a test
//! answers it the way the recorder's `fetch` stub did.

use std::sync::LazyLock;
use std::time::Duration;

use foundation::config::Config;
use regex::Regex;
use serde_json::{Value, json};

use crate::Fut;

// Telegram callback_data is limited to 64 bytes. "deploy_rollback:" plus a
// seven-character profile name leaves room for a normal 40-character Git SHA.
static RELEASE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^[a-f0-9]{7,40}$").unwrap());
static TARGET: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-z][a-z0-9_-]{0,6}$").unwrap());
const RETRY_ATTEMPTS: u32 = 3;
const RETRY_BACKOFF_MS: u64 = 5_000;
const RETRYABLE_STATUSES: [u16; 6] = [408, 425, 429, 502, 503, 504];

/// What answered a request: its status and body, whatever they are.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentResponse {
    pub status: u16,
    pub body: Vec<u8>,
}

/// The deploy agent's HTTP endpoint.
pub trait DeployAgent {
    /// POSTs the JSON `body` to `url` with the bearer `token`; `Err` when
    /// nothing answered (unreachable, timed out).
    fn post<'a>(&'a self, url: &'a str, token: &'a str, body: &'a str) -> Fut<'a, Result<AgentResponse, String>>;
}

/// The real agent over HTTP.
pub struct HttpDeployAgent {
    client: reqwest::Client,
}

impl HttpDeployAgent {
    /// The agent's own healthcheck loop alone runs up to 90s; leave enough
    /// margin for the image pull and container recreate around it so a slow
    /// deploy reports its real outcome instead of a false "unavailable".
    pub fn new() -> Result<Self, String> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(150))
            .build()
            .map_err(|error| error.to_string())?;
        Ok(Self { client })
    }
}

impl DeployAgent for HttpDeployAgent {
    fn post<'a>(&'a self, url: &'a str, token: &'a str, body: &'a str) -> Fut<'a, Result<AgentResponse, String>> {
        Box::pin(async move {
            let response = self
                .client
                .post(url)
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .body(body.to_owned())
                .send()
                .await
                .map_err(|error| error.without_url().to_string())?;
            let status = response.status().as_u16();
            let body = response
                .bytes()
                .await
                .map_err(|error| error.without_url().to_string())?;
            Ok(AgentResponse {
                status,
                body: body.to_vec(),
            })
        })
    }
}

/// `isDeploymentTarget`: checked at the button and at the tap.
pub fn is_deployment_target(value: &str) -> bool {
    TARGET.is_match(value)
}

/// `isDeploymentRevision`.
pub fn is_deployment_revision(value: &str) -> bool {
    RELEASE.is_match(value)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DeploymentAction {
    Rollback,
    /// Deploys to the target the exact release already proven healthy on alex.
    Promote,
}

impl DeploymentAction {
    fn path(self) -> &'static str {
        match self {
            Self::Rollback => "rollback",
            Self::Promote => "promote",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DeploymentOutcome {
    Done { release: String, current_revision: String },
    Failed { message: String },
}

fn failed(message: impl Into<String>) -> DeploymentOutcome {
    DeploymentOutcome::Failed {
        message: message.into(),
    }
}

/// `requestDeploymentAgent`: up to three attempts, a retryable status or no
/// answer at all backing off 5 s, then 10 s.
pub async fn request_deployment(
    agent: &dyn DeployAgent,
    config: &Config,
    action: DeploymentAction,
    target: &str,
    revision: &str,
) -> DeploymentOutcome {
    let (Some(url), Some(token)) = (config.deploy_agent_url.as_deref(), config.deploy_agent_token.as_deref()) else {
        return failed("Deployment agent is not configured.");
    };
    if !is_deployment_target(target) || !is_deployment_revision(revision) {
        return failed("Invalid deployment request.");
    }
    let base = url.strip_suffix('/').unwrap_or(url);
    let endpoint = format!("{base}/v1/{}/{target}", action.path());
    let body = json!({"release": revision}).to_string();
    for attempt in 1..=RETRY_ATTEMPTS {
        match agent.post(&endpoint, token, &body).await {
            Ok(response) => {
                let answer: Value = serde_json::from_slice(&response.body).unwrap_or(Value::Null);
                let ok = (200..300).contains(&response.status);
                if ok
                    && answer["ok"] == Value::Bool(true)
                    && let (Some(release), Some(current)) =
                        (answer["release"].as_str(), answer["currentRevision"].as_str())
                {
                    return DeploymentOutcome::Done {
                        release: release.to_owned(),
                        current_revision: current.to_owned(),
                    };
                }
                let message = match answer["message"].as_str() {
                    Some(message) => message.to_owned(),
                    None => format!("Request failed ({}).", response.status),
                };
                if attempt == RETRY_ATTEMPTS || !RETRYABLE_STATUSES.contains(&response.status) {
                    return failed(message);
                }
            }
            Err(_) if attempt == RETRY_ATTEMPTS => return failed("Deployment agent is unavailable."),
            Err(_) => {}
        }
        tokio::time::sleep(Duration::from_millis(RETRY_BACKOFF_MS * 2u64.pow(attempt - 1))).await;
    }
    failed("Deployment agent is unavailable.")
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::collections::VecDeque;

    use super::*;

    struct Scripted {
        answers: RefCell<VecDeque<Result<AgentResponse, String>>>,
        requests: RefCell<Vec<(String, String, String)>>,
    }

    impl Scripted {
        fn new(answers: Vec<Result<(u16, &str), &str>>) -> Self {
            Self {
                answers: RefCell::new(
                    answers
                        .into_iter()
                        .map(|answer| {
                            answer
                                .map(|(status, body)| AgentResponse {
                                    status,
                                    body: body.as_bytes().to_vec(),
                                })
                                .map_err(str::to_owned)
                        })
                        .collect(),
                ),
                requests: RefCell::default(),
            }
        }
    }

    impl DeployAgent for Scripted {
        fn post<'a>(&'a self, url: &'a str, token: &'a str, body: &'a str) -> Fut<'a, Result<AgentResponse, String>> {
            self.requests
                .borrow_mut()
                .push((url.to_owned(), token.to_owned(), body.to_owned()));
            let answer = self.answers.borrow_mut().pop_front().expect("a scripted answer");
            Box::pin(async move { answer })
        }
    }

    const RELEASE_SHA: &str = "0123456789abcdef0123456789abcdef01234567";

    fn config(url: Option<&str>) -> Config {
        let mut vars = vec![
            ("NODE_ENV".to_owned(), "test".to_owned()),
            ("DATA_DIR".to_owned(), std::env::temp_dir().display().to_string()),
        ];
        if let Some(url) = url {
            vars.push(("DEPLOY_AGENT_URL".into(), url.into()));
            vars.push(("DEPLOY_AGENT_TOKEN".into(), "deploy-agent-test-token".into()));
        }
        foundation::config::load_config(vars).unwrap()
    }

    async fn run(agent: &Scripted, config: &Config, action: DeploymentAction, target: &str) -> DeploymentOutcome {
        request_deployment(agent, config, action, target, RELEASE_SHA).await
    }

    #[test]
    fn controls_name_a_short_target_and_a_git_sha() {
        assert!(is_deployment_target("maru"));
        assert!(!is_deployment_target("Production"));
        assert!(!is_deployment_target("toolongname"));
        assert!(is_deployment_revision(RELEASE_SHA));
        assert!(is_deployment_revision("ABCDEF1"));
        assert!(!is_deployment_revision("0123"));
        assert!(!is_deployment_revision("not-a-revision"));
    }

    #[tokio::test(start_paused = true)]
    async fn a_done_answer_names_the_running_revision() {
        let agent = Scripted::new(vec![Ok((200, r#"{"ok":true,"release":"r","currentRevision":"c"}"#))]);
        let outcome = run(
            &agent,
            &config(Some("http://agent.invalid/")),
            DeploymentAction::Promote,
            "maru",
        )
        .await;
        assert_eq!(
            outcome,
            DeploymentOutcome::Done {
                release: "r".into(),
                current_revision: "c".into()
            }
        );
        assert_eq!(
            agent.requests.borrow()[0],
            (
                "http://agent.invalid/v1/promote/maru".to_owned(),
                "deploy-agent-test-token".to_owned(),
                format!(r#"{{"release":"{RELEASE_SHA}"}}"#)
            )
        );
    }

    #[tokio::test(start_paused = true)]
    async fn retryable_statuses_and_silence_are_retried_three_times_at_most() {
        let agent = Scripted::new(vec![
            Ok((503, "nope")),
            Err("refused"),
            Ok((502, r#"{"message":"bad gateway"}"#)),
        ]);
        let started = tokio::time::Instant::now();
        let outcome = run(
            &agent,
            &config(Some("http://agent.invalid")),
            DeploymentAction::Rollback,
            "alex",
        )
        .await;
        assert_eq!(outcome, failed("bad gateway"));
        assert_eq!(agent.requests.borrow().len(), 3);
        assert_eq!(started.elapsed(), Duration::from_secs(15));

        let agent = Scripted::new(vec![Err("refused"), Err("refused"), Err("refused")]);
        let outcome = run(
            &agent,
            &config(Some("http://agent.invalid")),
            DeploymentAction::Rollback,
            "alex",
        )
        .await;
        assert_eq!(outcome, failed("Deployment agent is unavailable."));
    }

    #[tokio::test(start_paused = true)]
    async fn a_refusal_is_final_and_reads_its_message_or_status() {
        let agent = Scripted::new(vec![Ok((409, r#"{"ok":false,"message":"No previous release."}"#))]);
        let outcome = run(
            &agent,
            &config(Some("http://agent.invalid")),
            DeploymentAction::Rollback,
            "alex",
        )
        .await;
        assert_eq!(outcome, failed("No previous release."));
        let agent = Scripted::new(vec![Ok((200, r#"{"ok":true}"#))]);
        let outcome = run(
            &agent,
            &config(Some("http://agent.invalid")),
            DeploymentAction::Rollback,
            "alex",
        )
        .await;
        assert_eq!(outcome, failed("Request failed (200)."));
    }

    #[tokio::test(start_paused = true)]
    async fn nothing_is_sent_unconfigured_or_for_an_invalid_target() {
        let agent = Scripted::new(Vec::new());
        assert_eq!(
            run(&agent, &config(None), DeploymentAction::Promote, "maru").await,
            failed("Deployment agent is not configured.")
        );
        assert_eq!(
            run(
                &agent,
                &config(Some("http://agent.invalid")),
                DeploymentAction::Promote,
                "Prod"
            )
            .await,
            failed("Invalid deployment request.")
        );
        assert!(agent.requests.borrow().is_empty());
    }
}
