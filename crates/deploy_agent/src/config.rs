//! The agent's environment: who may call it, where it listens, and the targets
//! it drives (`DEPLOY_TARGETS_JSON`).

use std::collections::HashMap;
use std::path::PathBuf;

use serde_json::{Map, Value};

use crate::retry::RetryPolicy;

/// The Studio CI deploys directly; every other target is promoted from its
/// notification, so this one carries the rollback and promotion buttons.
pub const DEFAULT_TARGET: &str = "alex";

#[derive(Clone, Debug)]
pub struct Config {
    /// The second address to listen on; `127.0.0.1` is always bound.
    pub host: String,
    pub port: u16,
    pub token: String,
    /// What `POST /v1/deploy` accepts as an image.
    pub repository: String,
    /// Telegram notifications; `None` when the bot token or the chat is unset.
    pub notification: Option<Notification>,
    pub retry: RetryPolicy,
    /// In `DEPLOY_TARGETS_JSON` order, which is the order `/v1/releases` lists them in.
    pub targets: Vec<Target>,
}

#[derive(Clone, Debug)]
pub struct Notification {
    pub bot_token: String,
    pub chat_id: String,
    pub api_base_url: String,
}

#[derive(Clone, Debug)]
pub struct Target {
    pub name: String,
    pub state_file: PathBuf,
    /// First rollout has no trustworthy immutable image to roll back to.
    pub allow_initial_seed: bool,
    pub kind: TargetKind,
}

/// The two shapes share no deployment mechanics.
#[derive(Clone, Debug)]
pub enum TargetKind {
    /// Deployed here, by driving Compose on this host.
    Compose(ComposeTarget),
    /// Deployed by handing the release to an agent on another host.
    Remote(RemoteTarget),
}

#[derive(Clone, Debug)]
pub struct ComposeTarget {
    pub compose_file: String,
    pub image_env_file: PathBuf,
    pub health_url: String,
    pub container: String,
    pub service: String,
    pub image_env_key: String,
    /// `studio-entrypoint --check-config` in the new image before it replaces
    /// the running container. Off for an image that has no such binary (the
    /// media processor); on unless the target says `"configCheck": false`.
    pub config_check: bool,
}

#[derive(Clone, Debug)]
pub struct RemoteTarget {
    pub remote_url: String,
    pub remote_token: String,
    pub artifact_file: PathBuf,
    pub repository: String,
}

impl Target {
    pub fn kind_name(&self) -> &'static str {
        match self.kind {
            TargetKind::Compose(_) => "compose",
            TargetKind::Remote(_) => "remote",
        }
    }
}

impl Config {
    pub fn from_env(vars: impl IntoIterator<Item = (String, String)>) -> Result<Self, String> {
        let env: HashMap<String, String> = vars.into_iter().collect();
        let token = required(&env, "DEPLOY_AGENT_TOKEN")?;
        let port = env.get("DEPLOY_AGENT_PORT").map_or("9899", String::as_str);
        let port = port
            .trim()
            .parse()
            .map_err(|_| format!("DEPLOY_AGENT_PORT must be a port number, got {port:?}"))?;
        // `??` in the TypeScript: an empty DEPLOY_NOTIFICATION_BOT_TOKEN does
        // not fall back to the controller's token, it switches notifications off.
        let bot_token = env
            .get("DEPLOY_NOTIFICATION_BOT_TOKEN")
            .or_else(|| env.get("CONTROLLER_BOT_TOKEN"))
            .cloned()
            .unwrap_or_default();
        let chat_id = env.get("DEPLOY_NOTIFICATION_CHAT_ID").cloned().unwrap_or_default();
        let api_base_url = env
            .get("DEPLOY_NOTIFICATION_API_BASE_URL")
            .map_or("http://127.0.0.1:8081", String::as_str)
            .to_owned();
        let notification = if bot_token.is_empty() || chat_id.is_empty() {
            None
        } else {
            http_url("DEPLOY_NOTIFICATION_API_BASE_URL", &api_base_url)?;
            Some(Notification {
                bot_token,
                chat_id,
                api_base_url,
            })
        };
        Ok(Self {
            host: env
                .get("DEPLOY_AGENT_HOST")
                .map_or("172.17.0.1", String::as_str)
                .to_owned(),
            port,
            token,
            repository: env
                .get("DEPLOY_IMAGE_REPOSITORY")
                .map_or("ghcr.io/alexgetmancom/solo-publisher", String::as_str)
                .to_owned(),
            notification,
            retry: RetryPolicy {
                attempts: integer_env(&env, "DEPLOY_RETRY_ATTEMPTS", 3, 1),
                initial_delay_ms: integer_env(&env, "DEPLOY_RETRY_BACKOFF_MS", 5_000, 0),
                max_delay_ms: integer_env(&env, "DEPLOY_RETRY_MAX_BACKOFF_MS", 30_000, 0),
            },
            targets: targets(&required(&env, "DEPLOY_TARGETS_JSON")?)?,
        })
    }

    /// The target of a request that names none: `alex`, which CI deploys on the
    /// Studio host, or the only target of an agent that drives one. The Studio
    /// host's agent calls the media processor host's agent that way, without a name.
    pub fn default_target(&self) -> &str {
        match self.targets.as_slice() {
            [only] => &only.name,
            _ => DEFAULT_TARGET,
        }
    }

    pub fn target(&self, name: &str) -> Option<&Target> {
        self.targets.iter().find(|target| target.name == name)
    }
}

fn required(env: &HashMap<String, String>, name: &str) -> Result<String, String> {
    match env.get(name).map(|value| value.trim()) {
        Some(value) if !value.is_empty() => Ok(value.to_owned()),
        _ => Err(format!("{name} is required")),
    }
}

/// `Number(value)` when it is an integer of at least `minimum`, else `fallback`.
fn integer_env<T: TryFrom<u64> + Copy>(env: &HashMap<String, String>, name: &str, fallback: T, minimum: u64) -> T {
    let Some(value) = env.get(name).map(|value| value.trim()) else {
        return fallback;
    };
    // `Number("")` is 0.
    let number = if value.is_empty() {
        Ok(0.0)
    } else {
        value.parse::<f64>()
    };
    match number {
        Ok(number) if number.fract() == 0.0 && number >= minimum as f64 && number <= u32::MAX as f64 => {
            T::try_from(number as u64).unwrap_or(fallback)
        }
        _ => fallback,
    }
}

fn targets(json: &str) -> Result<Vec<Target>, String> {
    let parsed: Value = serde_json::from_str(json).map_err(|error| format!("DEPLOY_TARGETS_JSON: {error}"))?;
    let Value::Object(parsed) = parsed else {
        return Err("DEPLOY_TARGETS_JSON must be an object of targets".into());
    };
    let mut targets = Vec::new();
    for (name, value) in parsed {
        if !is_target_name(&name) {
            return Err(format!("Invalid deployment target name: {name}"));
        }
        let Value::Object(value) = value else {
            return Err(format!("Invalid deployment target: {name}"));
        };
        let require = |key: &str| text(&value, key).ok_or_else(|| format!("Deployment target {name} is missing {key}"));
        let state_file = PathBuf::from(require("stateFile")?);
        let allow_initial_seed = value.get("allowInitialSeed") == Some(&Value::Bool(true));
        let kind = if value.get("remoteUrl").is_some_and(|url| !url.is_null()) {
            let remote_url = require("remoteUrl")?;
            http_url(&format!("Deployment target {name}'s remoteUrl"), &remote_url)?;
            TargetKind::Remote(RemoteTarget {
                remote_url,
                remote_token: require("remoteToken")?,
                artifact_file: PathBuf::from(require("artifactFile")?),
                repository: require("repository")?,
            })
        } else {
            let compose_file = require("composeFile")?;
            let image_env_file = PathBuf::from(require("imageEnvFile")?);
            let health_url = require("healthUrl")?;
            http_url(&format!("Deployment target {name}'s healthUrl"), &health_url)?;
            let config_check = match value.get("configCheck") {
                None => true,
                Some(Value::Bool(check)) => *check,
                Some(_) => return Err(format!("Deployment target {name}'s configCheck must be true or false")),
            };
            TargetKind::Compose(ComposeTarget {
                compose_file,
                image_env_file,
                health_url,
                container: require("container")?,
                service: text(&value, "service").unwrap_or_else(|| "backend".into()),
                image_env_key: text(&value, "imageEnvKey").unwrap_or_else(|| "BACKEND_IMAGE".into()),
                config_check,
            })
        };
        targets.push(Target {
            name,
            state_file,
            allow_initial_seed,
            kind,
        });
    }
    if targets.is_empty() {
        return Err("DEPLOY_TARGETS_JSON must configure at least one target.".into());
    }
    Ok(targets)
}

/// A non-blank string, as written.
fn text(value: &Map<String, Value>, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|found| !found.trim().is_empty())
        .map(str::to_owned)
}

/// `^[a-z][a-z0-9_-]{0,6}$`: a Telegram callback carries it next to a 40-character SHA.
pub fn is_target_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|first| first.is_ascii_lowercase())
        && name.len() <= 7
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
}

/// Every address the agent calls is on this host or behind a tunnel to it, so
/// it speaks plain HTTP only; an `https://` URL is refused at start rather than
/// failing on the first deployment.
fn http_url(what: &str, url: &str) -> Result<(), String> {
    match url.parse::<hyper::Uri>() {
        Ok(uri) if uri.scheme_str() == Some("http") && uri.host().is_some() => Ok(()),
        _ => Err(format!("{what} must be an http:// URL, got {url:?}")),
    }
}
