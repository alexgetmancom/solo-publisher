//! The deploy agent: a small host service and the only component allowed to
//! invoke Docker. CI (`cargo xtask deploy-release`), the Studio bot's rollback
//! and promotion buttons (`bot::deployment`) and `ops deployments` call it; no
//! Studio mounts the Docker socket.
//!
//! - `GET /healthz`, unauthenticated: `{ok: true, deploying}`.
//! - Everything else needs `Authorization: Bearer <DEPLOY_AGENT_TOKEN>`,
//!   compared in constant time before the body is read.
//! - `GET /v1/releases`: every target's state.
//! - `POST /v1/deploy[/<target>]` `{image, release}`, `POST /v1/rollback/<target>`
//!   `{release}`, `POST /v1/promote/<target>` `{release}` (the release `alex`
//!   runs): `{ok, target, release, currentRevision}`, or `{ok: false, message}`
//!   with 400, 403, 404, 409 (one deployment at a time; a stale button), 502
//!   (failed, and rolled back when there was something to roll back to) or 500.
//!
//! A deployment pulls the image, checks its configuration, replaces the
//! container, waits for it to become healthy, and on failure re-activates the
//! previous image; each target keeps its current and previous release in its
//! own state file.

pub mod config;
mod host;
pub mod retry;

use std::convert::Infallible;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use http_body_util::{BodyExt as _, Full};
use hyper::body::{Bytes, Incoming};
use hyper::header::CONTENT_TYPE;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use subtle::ConstantTimeEq as _;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpListener;

pub use config::{ComposeTarget, Config, RemoteTarget, Target, TargetKind};
pub use host::{Fut, Host, OutboundRequest, OutboundResponse, Output, System};
use retry::{is_transient, with_retry};

const HEALTH_DEADLINE: Duration = Duration::from_secs(90);
const HEALTH_INTERVAL: Duration = Duration::from_secs(2);
const HEALTH_REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
const REMOTE_DEPLOY_TIMEOUT: Duration = Duration::from_secs(150);
const NOTIFY_TIMEOUT: Duration = Duration::from_secs(10);
const RETRYABLE_REMOTE_STATUSES: [u16; 6] = [408, 425, 429, 502, 503, 504];

/// Deploying by digest leaves every superseded image on the host under its own
/// digest reference. That reference carries no tag but is not dangling either,
/// so no default cleanup sees it: twenty-one media-processor images, a gigabyte
/// apiece, had accumulated before pruning existed. Keep the last few so a
/// rollback stays a local activation; rolling back past them costs a pull
/// rather than being impossible.
const KEPT_IMAGES: usize = 3;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Release {
    pub image: String,
    pub revision: String,
    #[serde(rename = "deployedAt")]
    pub deployed_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LastFailure {
    pub revision: String,
    pub message: String,
    pub at: String,
}

/// A target's state file. Missing or unreadable reads as empty.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeploymentState {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current: Option<Release>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous: Option<Release>,
    #[serde(rename = "lastFailure", default, skip_serializing_if = "Option::is_none")]
    pub last_failure: Option<LastFailure>,
}

/// A refusal or failure, as the response that reports it.
#[derive(Debug)]
struct HttpError {
    status: u16,
    message: String,
}

fn refuse(status: u16, message: impl Into<String>) -> HttpError {
    HttpError {
        status,
        message: message.into(),
    }
}

/// Anything not more specific is a 500, as an unhandled exception is.
impl From<String> for HttpError {
    fn from(message: String) -> Self {
        refuse(500, message)
    }
}

/// A remote agent's refusal keeps its status, which decides the retry.
struct RemoteFailure {
    status: Option<u16>,
    message: String,
}

pub struct Agent {
    config: Config,
    host: Arc<dyn Host>,
    deploying: AtomicBool,
}

/// Holds the one deployment slot until dropped.
struct DeploymentLock<'a>(&'a AtomicBool);

impl Drop for DeploymentLock<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

impl Agent {
    pub fn new(config: Config, host: Arc<dyn Host>) -> Arc<Self> {
        Arc::new(Self {
            config,
            host,
            deploying: AtomicBool::new(false),
        })
    }

    fn deploying(&self) -> bool {
        self.deploying.load(Ordering::SeqCst)
    }

    /// One request. The work runs detached from the connection: a caller that
    /// hangs up (the bot gives up after 150 s) must not cancel a deployment
    /// between replacing a container and rolling it back.
    pub async fn handle(self: &Arc<Self>, request: Request<Incoming>) -> Response<Full<Bytes>> {
        let method = request.method().clone();
        let path = request.uri().path().to_owned();
        if method == Method::GET && path == "/healthz" {
            return respond(200, &json!({"ok": true, "deploying": self.deploying()}));
        }
        let received = request
            .headers()
            .get("authorization")
            .and_then(|value| value.to_str().ok())
            .map(strip_bearer)
            .unwrap_or_default();
        let expected = self.config.token.as_bytes();
        if received.len() != expected.len() || !bool::from(received.as_bytes().ct_eq(expected)) {
            return respond(403, &json!({"ok": false, "message": "forbidden"}));
        }
        let body = match request.into_body().collect().await {
            Ok(collected) => serde_json::from_slice(&collected.to_bytes()).unwrap_or(Value::Null),
            Err(_) => Value::Null,
        };
        let agent = Arc::clone(self);
        let routed = tokio::spawn(async move { agent.route(&method, &path, &body).await }).await;
        let (status, value) = match routed {
            Ok(Ok(answer)) => answer,
            Ok(Err(error)) => (error.status, json!({"ok": false, "message": error.message})),
            Err(error) => (500, json!({"ok": false, "message": error.to_string()})),
        };
        respond(status, &value)
    }

    async fn route(&self, method: &Method, path: &str, body: &Value) -> Result<(u16, Value), HttpError> {
        let segments: Vec<&str> = path.split('/').collect();
        let action = segments.get(2).copied();
        let requested = segments.get(3).copied();
        // What is running, and what a rollback would go back to, for every
        // target: otherwise only deploying answered that.
        if method == Method::GET && action == Some("releases") {
            let mut targets = Vec::new();
            for target in &self.config.targets {
                let mut entry = Map::new();
                entry.insert("target".into(), json!(target.name));
                entry.insert("kind".into(), json!(target.kind_name()));
                if let Value::Object(state) = serde_json::to_value(self.state(target).await).unwrap_or_default() {
                    entry.extend(state);
                }
                targets.push(Value::Object(entry));
            }
            return Ok((
                200,
                json!({"ok": true, "deploying": self.deploying(), "targets": targets}),
            ));
        }
        let target = self.target(requested)?;
        let release = body
            .get("release")
            .and_then(Value::as_str)
            .filter(|release| is_revision(release));
        let next = match (method, action) {
            (&Method::POST, Some("deploy")) => {
                let image = body
                    .get("image")
                    .and_then(Value::as_str)
                    .filter(|image| is_immutable_image(image, &self.config.repository));
                let (Some(image), Some(release)) = (image, release) else {
                    return Err(refuse(
                        400,
                        "image must be an immutable configured GHCR digest and release must be a Git SHA.",
                    ));
                };
                self.deploy(target, image, release).await?
            }
            (&Method::POST, Some("rollback")) => {
                let release = release.ok_or_else(|| refuse(400, "release must be a Git SHA."))?;
                self.rollback(target, release).await?
            }
            (&Method::POST, Some("promote")) => {
                let release = release.ok_or_else(|| refuse(400, "release must be a Git SHA."))?;
                let source = self.target(Some(self.config.default_target()))?;
                self.promote(source, target, release).await?
            }
            _ => return Ok((404, json!({"ok": false, "message": "not found"}))),
        };
        let revision = next.current.map(|current| current.revision);
        Ok((
            200,
            json!({"ok": true, "target": target.name, "release": revision, "currentRevision": revision}),
        ))
    }

    fn target(&self, name: Option<&str>) -> Result<&Target, HttpError> {
        let name = name.unwrap_or(self.config.default_target());
        self.config
            .target(name)
            .ok_or_else(|| refuse(404, format!("Unknown deployment target: {name}")))
    }

    fn lock(&self) -> Result<DeploymentLock<'_>, HttpError> {
        self.deploying
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map(|_| DeploymentLock(&self.deploying))
            .map_err(|_| refuse(409, "A deployment is already running."))
    }

    async fn deploy(&self, target: &Target, image: &str, release: &str) -> Result<DeploymentState, HttpError> {
        let _lock = self.lock()?;
        let previous_state = self.state(target).await;
        let mut previous_image = self.current_image(target).await?;
        // A failed first attempt may already have written the desired digest
        // into the env file. That is not a deployed rollback release.
        if target.allow_initial_seed && previous_state.current.is_none() {
            previous_image = self.running_container_image(target).await?;
        }
        if previous_image.is_none() && !target.allow_initial_seed {
            return Err(refuse(
                409,
                "Current release is not an immutable GHCR digest; seed the target's imageEnvFile before deploying.",
            ));
        }
        let displaced = previous_image.map(|image| {
            previous_state.current.clone().unwrap_or_else(|| Release {
                revision: last_chars(&image, 12).to_owned(),
                image,
                deployed_at: now(),
            })
        });
        // Redeploying the release that is already current must not record it
        // as its own predecessor: the rollback would re-activate the image it
        // is rolling back from and report success, while the release actually
        // worth returning to is gone from the state.
        let previous = if previous_state.current.as_ref().map(|current| current.revision.as_str()) == Some(release) {
            previous_state.previous.clone()
        } else {
            displaced
        };
        let attempt = async {
            self.activate(target, image, release, true).await?;
            let next = DeploymentState {
                current: Some(Release {
                    image: image.to_owned(),
                    revision: release.to_owned(),
                    deployed_at: now(),
                }),
                previous: previous.clone(),
                last_failure: None,
            };
            write_state(target, &next).await?;
            self.notify(
                &format!(
                    "Deploy {} {} successful and healthy.",
                    target.name,
                    first_chars(release, 12)
                ),
                target,
                Some(release),
                &self.promotion_candidates(target),
            )
            .await;
            Ok::<_, String>(next)
        };
        let message = match attempt.await {
            Ok(next) => return Ok(next),
            Err(message) => message,
        };
        let last_failure = Some(LastFailure {
            revision: release.to_owned(),
            message: message.clone(),
            at: now(),
        });
        let Some(previous) = previous else {
            write_state(
                target,
                &DeploymentState {
                    last_failure,
                    ..previous_state
                },
            )
            .await?;
            return Err(refuse(
                502,
                format!("Initial deploy failed and has no prior immutable image to roll back to: {message}"),
            ));
        };
        if let Err(rollback) = self.activate(target, &previous.image, &previous.revision, false).await {
            return Err(refuse(
                500,
                format!("Deploy failed ({message}); automatic rollback also failed: Error: {rollback}"),
            ));
        }
        let rolled_back = format!(
            "Deploy {} {} failed; automatic rollback to {} succeeded.\n\n{message}",
            target.name,
            first_chars(release, 12),
            first_chars(&previous.revision, 12)
        );
        write_state(
            target,
            &DeploymentState {
                current: Some(previous),
                last_failure,
                ..previous_state
            },
        )
        .await?;
        self.notify(first_chars(&rolled_back, 4_000), target, None, &[]).await;
        Err(refuse(502, format!("Deploy failed and was rolled back: {message}")))
    }

    async fn rollback(&self, target: &Target, release: &str) -> Result<DeploymentState, HttpError> {
        let _lock = self.lock()?;
        let before = self.state(target).await;
        let (Some(current), Some(previous)) = (before.current, before.previous) else {
            return Err(refuse(409, "No rollback release is available."));
        };
        if current.revision != release {
            return Err(refuse(409, "This rollback button belongs to an older release."));
        }
        self.activate(target, &previous.image, &previous.revision, false)
            .await
            .map_err(|error| refuse(502, format!("Rollback failed: {error}")))?;
        let next = DeploymentState {
            current: Some(Release {
                deployed_at: now(),
                ..previous
            }),
            previous: Some(current),
            last_failure: None,
        };
        write_state(target, &next).await?;
        let revision = next
            .current
            .as_ref()
            .map(|current| current.revision.clone())
            .unwrap_or_default();
        self.notify(
            &format!(
                "Manual rollback of {} to {} successful and healthy.",
                target.name,
                first_chars(&revision, 12)
            ),
            target,
            Some(&revision),
            &[],
        )
        .await;
        Ok(next)
    }

    /// Deploys to `destination` the exact release `source` is running. The
    /// check stands outside the deployment lock; the deployment takes the lock
    /// itself.
    async fn promote(
        &self,
        source: &Target,
        destination: &Target,
        release: &str,
    ) -> Result<DeploymentState, HttpError> {
        let source_state = self.state(source).await;
        let Some(current) = source_state.current.filter(|current| current.revision == release) else {
            return Err(refuse(409, "This button belongs to an older source release."));
        };
        let TargetKind::Remote(remote) = &destination.kind else {
            return self.deploy(destination, &current.image, release).await;
        };
        let artifact: Value = tokio::fs::read(&remote.artifact_file)
            .await
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        let image = artifact
            .get("image")
            .and_then(Value::as_str)
            .filter(|image| is_immutable_image(image, &remote.repository));
        match image {
            Some(image) if artifact.get("release").and_then(Value::as_str) == Some(release) => {
                self.deploy(destination, image, release).await
            }
            _ => Err(refuse(
                409,
                format!("No immutable remote artifact is registered for {release}."),
            )),
        }
    }

    /// Only the default target is ever deployed by CI; every other target is
    /// deployed by promoting the exact image it just proved healthy.
    fn promotion_candidates(&self, target: &Target) -> Vec<String> {
        if target.name != self.config.default_target() {
            return Vec::new();
        }
        self.config
            .targets
            .iter()
            .filter(|other| other.name != target.name)
            .map(|other| other.name.clone())
            .collect()
    }

    async fn state(&self, target: &Target) -> DeploymentState {
        match tokio::fs::read(&target.state_file).await {
            Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
            Err(_) => DeploymentState::default(),
        }
    }

    async fn current_image(&self, target: &Target) -> Result<Option<String>, String> {
        let compose = match &target.kind {
            TargetKind::Remote(_) => return Ok(self.state(target).await.current.map(|current| current.image)),
            TargetKind::Compose(compose) => compose,
        };
        let env = tokio::fs::read_to_string(&compose.image_env_file)
            .await
            .unwrap_or_default();
        let declared = env_value(&env, &compose.image_env_key);
        if let Some(declared) = declared.filter(|declared| is_immutable_image(declared, &self.config.repository)) {
            return Ok(Some(declared.to_owned()));
        }
        self.running_container_image(target).await
    }

    async fn running_container_image(&self, target: &Target) -> Result<Option<String>, String> {
        let TargetKind::Compose(compose) = &target.kind else {
            return Ok(None);
        };
        let digest = self
            .docker_allowing_failure(&[
                "image",
                "inspect",
                "--format",
                "{{index .RepoDigests 0}}",
                &compose.container,
            ])
            .await?;
        Ok(Some(digest).filter(|digest| is_immutable_image(digest, &self.config.repository)))
    }

    async fn activate(&self, target: &Target, image: &str, release: &str, validate_config: bool) -> Result<(), String> {
        let compose = match &target.kind {
            TargetKind::Remote(remote) => return self.activate_remote(target, remote, image, release).await,
            TargetKind::Compose(compose) => compose,
        };
        write_image(compose, image).await?;
        self.retrying(&format!("image pull {}", target.name), || {
            self.docker(compose_args(compose, &["pull", &compose.service]))
        })
        .await?;
        if validate_config && compose.config_check {
            self.docker(compose_args(
                compose,
                &[
                    "run",
                    "--rm",
                    "--no-deps",
                    "--entrypoint",
                    "/app/bin/studio-entrypoint",
                    &compose.service,
                    "--check-config",
                ],
            ))
            .await?;
        }
        // The service has a stable container name. Removing it explicitly
        // makes a compose-project rename the same operation as every later
        // replacement; otherwise Docker refuses to create the new owner before
        // Compose can act.
        self.docker_allowing_failure(&["rm", "-f", &compose.container]).await?;
        self.docker(compose_args(
            compose,
            &["up", "-d", "--no-deps", "--force-recreate", &compose.service],
        ))
        .await?;
        self.wait_for_healthy(compose).await?;
        self.prune_images(compose, image).await
    }

    async fn activate_remote(
        &self,
        target: &Target,
        remote: &RemoteTarget,
        image: &str,
        release: &str,
    ) -> Result<(), String> {
        let url = format!(
            "{}/v1/deploy",
            remote.remote_url.strip_suffix('/').unwrap_or(&remote.remote_url)
        );
        let body = json!({"image": image, "release": release}).to_string();
        let send = || async {
            let response = self
                .host
                .http(OutboundRequest {
                    method: Method::POST,
                    url: url.clone(),
                    headers: vec![
                        ("authorization", format!("Bearer {}", remote.remote_token)),
                        ("content-type", "application/json".into()),
                    ],
                    body: Some(body.clone()),
                    timeout: REMOTE_DEPLOY_TIMEOUT,
                })
                .await
                .map_err(|message| RemoteFailure { status: None, message })?;
            if (200..300).contains(&response.status) {
                return Ok(());
            }
            let text = String::from_utf8_lossy(&response.body);
            Err(RemoteFailure {
                status: Some(response.status),
                message: format!(
                    "remote deploy failed ({}): {}",
                    response.status,
                    first_chars(&text, 400)
                ),
            })
        };
        with_retry(
            self.config.retry,
            send,
            |failure: &RemoteFailure| match failure.status {
                Some(status) => RETRYABLE_REMOTE_STATUSES.contains(&status),
                None => is_transient(&failure.message),
            },
            |failure, failed_attempt, delay_ms| {
                self.log_retry(
                    &format!("remote deploy {}", target.name),
                    &failure.message,
                    failed_attempt,
                    delay_ms,
                )
            },
        )
        .await
        .map_err(|failure| failure.message)
    }

    async fn retrying<Run, Running>(&self, operation: &str, run: Run) -> Result<String, String>
    where
        Run: FnMut() -> Running,
        Running: std::future::Future<Output = Result<String, String>>,
    {
        with_retry(
            self.config.retry,
            run,
            |message: &String| is_transient(message),
            |message, failed_attempt, delay_ms| self.log_retry(operation, message, failed_attempt, delay_ms),
        )
        .await
    }

    fn log_retry(&self, operation: &str, error: &str, failed_attempt: u32, delay_ms: u64) {
        let error = format!("Error: {error}");
        eprintln!(
            "{}",
            json!({
                "level": "warn",
                "message": "deployment operation failed; retrying",
                "operation": operation,
                "failedAttempt": failed_attempt,
                "nextAttempt": failed_attempt + 1,
                "maxAttempts": self.config.retry.attempts,
                "delayMs": delay_ms,
                "error": first_chars(&error, 400),
            })
        );
    }

    async fn wait_for_healthy(&self, compose: &ComposeTarget) -> Result<(), String> {
        let deadline = tokio::time::Instant::now() + HEALTH_DEADLINE;
        let mut last = "container did not become ready".to_owned();
        while tokio::time::Instant::now() < deadline {
            let health = self
                .docker_allowing_failure(&[
                    "inspect",
                    "--format",
                    "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}",
                    &compose.container,
                ])
                .await?;
            if matches!(health.as_str(), "unhealthy" | "exited" | "dead") {
                return Err(format!(
                    "container state is {health}\n{}",
                    self.container_diagnostics(compose).await
                ));
            }
            let probe = self
                .host
                .http(OutboundRequest {
                    method: Method::GET,
                    url: compose.health_url.clone(),
                    headers: Vec::new(),
                    body: None,
                    timeout: HEALTH_REQUEST_TIMEOUT,
                })
                .await;
            match probe {
                Ok(response) if (200..300).contains(&response.status) => return Ok(()),
                Ok(response) => last = format!("readyz returned {}", response.status),
                Err(error) => last = error,
            }
            tokio::time::sleep(HEALTH_INTERVAL).await;
        }
        Err(format!(
            "health check timeout: {last}\n{}",
            self.container_diagnostics(compose).await
        ))
    }

    async fn container_diagnostics(&self, compose: &ComposeTarget) -> String {
        let (health, logs) = tokio::join!(
            self.diagnostic(owned(&[
                "inspect",
                "--format",
                "{{json .State.Health}}",
                &compose.container
            ])),
            self.diagnostic(owned(&["logs", "--tail", "40", &compose.container])),
        );
        let health = if health.is_empty() { "unavailable" } else { &health };
        let logs = if logs.is_empty() { "unavailable" } else { &logs };
        first_chars(&format!("health: {health}\nlogs:\n{logs}"), 6_000).to_owned()
    }

    /// Both streams, whatever the exit status.
    async fn diagnostic(&self, args: Vec<String>) -> String {
        match self.host.docker(args).await {
            Ok(output) => [output.stdout.trim(), output.stderr.trim()]
                .into_iter()
                .filter(|part| !part.is_empty())
                .collect::<Vec<_>>()
                .join("\n"),
            Err(_) => String::new(),
        }
    }

    async fn prune_images(&self, compose: &ComposeTarget, image: &str) -> Result<(), String> {
        let Some((repository, _)) = image.split_once('@').filter(|(repository, _)| !repository.is_empty()) else {
            return Ok(());
        };
        let listed = self
            .docker_allowing_failure(&[
                "images",
                "--no-trunc",
                "--format",
                "{{.CreatedAt}}\t{{.ID}}",
                repository,
            ])
            .await?;
        // Newest first, by the CreatedAt text as Docker prints it.
        let mut lines: Vec<&str> = listed
            .split('\n')
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .collect();
        lines.sort_unstable();
        lines.reverse();
        let mut identifiers: Vec<&str> = Vec::new();
        for identifier in lines.iter().filter_map(|line| line.split('\t').nth(1)) {
            if !identifier.is_empty() && !identifiers.contains(&identifier) {
                identifiers.push(identifier);
            }
        }
        let running = self
            .docker_allowing_failure(&["image", "inspect", "--format", "{{.Id}}", &compose.container])
            .await?;
        for identifier in identifiers.into_iter().skip(KEPT_IMAGES) {
            // The image this deployment just activated is newest and so never
            // here, but a rollback activates an older one: check rather than
            // trust the ordering. An image a container still holds cannot be
            // removed, and Docker refusing is not a deployment failure.
            if identifier != running {
                self.docker_allowing_failure(&["image", "rm", identifier]).await?;
            }
        }
        Ok(())
    }

    async fn notify(&self, text: &str, target: &Target, release: Option<&str>, promote_to: &[String]) {
        let Some(notification) = &self.config.notification else {
            return;
        };
        // The bot asks for confirmation before acting, so these are the "_ask"
        // callbacks rather than the ones that execute directly.
        let mut buttons = Vec::new();
        if let Some(release) = release {
            buttons.push(json!([{
                "text": format!("Откатить {}", target.name),
                "callback_data": format!("deploy_rb_ask:{}:{release}", target.name),
            }]));
            for promote in promote_to {
                buttons.push(json!([{
                    "text": format!("Раскатить {promote}"),
                    "callback_data": format!("deploy_pr_ask:{promote}:{release}"),
                }]));
            }
        }
        let mut message = json!({"chat_id": notification.chat_id, "text": text});
        if !buttons.is_empty() {
            message["reply_markup"] = json!({"inline_keyboard": buttons});
        }
        let base = notification
            .api_base_url
            .strip_suffix('/')
            .unwrap_or(&notification.api_base_url);
        let sent = self
            .host
            .http(OutboundRequest {
                method: Method::POST,
                url: format!("{base}/bot{}/sendMessage", notification.bot_token),
                headers: vec![("content-type", "application/json".into())],
                body: Some(message.to_string()),
                timeout: NOTIFY_TIMEOUT,
            })
            .await;
        if let Err(error) = sent {
            eprintln!(
                "{}",
                json!({"level": "error", "message": "deploy notify failed", "error": format!("Error: {error}")})
            );
        }
    }

    /// `docker`, failing with its stderr (or its status) when it exits non-zero.
    async fn docker(&self, args: Vec<String>) -> Result<String, String> {
        let output = self
            .host
            .docker(args.clone())
            .await
            .map_err(|error| error.to_string())?;
        if output.code != 0 {
            let stderr = output.stderr.trim();
            return Err(if stderr.is_empty() {
                format!("docker {} exited with {}", args.join(" "), output.code)
            } else {
                stderr.to_owned()
            });
        }
        Ok(output.stdout.trim().to_owned())
    }

    /// `docker`'s trimmed stdout whatever its exit status; only failing to start it fails.
    async fn docker_allowing_failure(&self, args: &[&str]) -> Result<String, String> {
        let output = self.host.docker(owned(args)).await.map_err(|error| error.to_string())?;
        Ok(output.stdout.trim().to_owned())
    }
}

fn compose_args(compose: &ComposeTarget, args: &[&str]) -> Vec<String> {
    let image_env_file = compose.image_env_file.to_string_lossy();
    let mut all = owned(&["compose", "--env-file", &image_env_file, "-f", &compose.compose_file]);
    all.extend(owned(args));
    all
}

fn owned(args: &[&str]) -> Vec<String> {
    args.iter().map(|arg| (*arg).to_owned()).collect()
}

/// `^KEY=(.+)$` in the env file, trimmed: the first such line with a value.
fn env_value<'a>(env: &'a str, key: &str) -> Option<&'a str> {
    env.split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .filter_map(|line| line.strip_prefix(key)?.strip_prefix('='))
        .find(|value| !value.is_empty())
        .map(str::trim)
}

/// Puts the image first in the target's env file, keeping every other line,
/// written beside it and renamed into place.
async fn write_image(compose: &ComposeTarget, image: &str) -> Result<(), String> {
    let existing = tokio::fs::read_to_string(&compose.image_env_file)
        .await
        .unwrap_or_default();
    let prefix = format!("{}=", compose.image_env_key);
    let mut lines = vec![format!("{prefix}{image}")];
    lines.extend(
        existing
            .split('\n')
            .map(|line| line.strip_suffix('\r').unwrap_or(line))
            .filter(|line| !line.is_empty() && !line.starts_with(&prefix))
            .map(str::to_owned),
    );
    lines.push(String::new());
    replace_file(&compose.image_env_file, lines.join("\n").as_bytes()).await
}

async fn write_state(target: &Target, state: &DeploymentState) -> Result<(), String> {
    if let Some(directory) = target.state_file.parent() {
        tokio::fs::create_dir_all(directory)
            .await
            .map_err(|error| format!("{}: {error}", directory.display()))?;
    }
    let text = serde_json::to_string_pretty(state).map_err(|error| error.to_string())?;
    replace_file(&target.state_file, format!("{text}\n").as_bytes()).await
}

async fn replace_file(path: &Path, contents: &[u8]) -> Result<(), String> {
    let mut temporary = path.as_os_str().to_owned();
    temporary.push(".next");
    tokio::fs::write(&temporary, contents)
        .await
        .map_err(|error| format!("{}: {error}", Path::new(&temporary).display()))?;
    tokio::fs::rename(&temporary, path)
        .await
        .map_err(|error| format!("{}: {error}", path.display()))
}

fn strip_bearer(value: &str) -> String {
    let stripped = value
        .get(..6)
        .filter(|scheme| scheme.eq_ignore_ascii_case("bearer"))
        .and_then(|_| value[6..].strip_prefix(char::is_whitespace))
        .map(|rest| rest.trim_start_matches(char::is_whitespace));
    stripped.unwrap_or(value).to_owned()
}

/// `<repository>@sha256:<64 hex>`.
pub fn is_immutable_image(value: &str, repository: &str) -> bool {
    value
        .strip_prefix(repository)
        .and_then(|rest| rest.strip_prefix("@sha256:"))
        .is_some_and(|digest| digest.len() == 64 && digest.bytes().all(|byte| byte.is_ascii_hexdigit()))
}

/// A Git SHA, abbreviated or not.
pub fn is_revision(value: &str) -> bool {
    (7..=40).contains(&value.len()) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn first_chars(text: &str, count: usize) -> &str {
    text.char_indices().nth(count).map_or(text, |(end, _)| &text[..end])
}

fn last_chars(text: &str, count: usize) -> &str {
    let total = text.chars().count();
    text.char_indices()
        .nth(total.saturating_sub(count))
        .map_or(text, |(start, _)| &text[start..])
}

/// `new Date().toISOString()`.
fn now() -> String {
    format!("{:.3}", jiff::Timestamp::now())
}

fn respond(status: u16, value: &Value) -> Response<Full<Bytes>> {
    let mut response = Response::new(Full::new(Bytes::from(value.to_string())));
    *response.status_mut() = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    response.headers_mut().insert(
        CONTENT_TYPE,
        hyper::header::HeaderValue::from_static("application/json"),
    );
    response
}

/// Accepts connections until the listener fails.
pub async fn serve(listener: TcpListener, agent: Arc<Agent>) {
    loop {
        match listener.accept().await {
            Ok((stream, _)) => {
                tokio::spawn(serve_connection(stream, Arc::clone(&agent)));
            }
            Err(error) => {
                eprintln!(
                    "{}",
                    json!({"level": "error", "message": "accept failed", "error": error.to_string()})
                );
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
    }
}

/// One HTTP/1.1 connection; tests drive it over an in-memory stream.
pub async fn serve_connection<S>(stream: S, agent: Arc<Agent>)
where
    S: AsyncRead + AsyncWrite + Send + Unpin + 'static,
{
    let service = service_fn(move |request| {
        let agent = Arc::clone(&agent);
        async move { Ok::<_, Infallible>(agent.handle(request).await) }
    });
    let _ = http1::Builder::new()
        .serve_connection(TokioIo::new(stream), service)
        .await;
}
