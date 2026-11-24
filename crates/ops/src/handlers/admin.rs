//! Health, host and channel administration: `maintenance.ts` (audit, backup,
//! restore, publication consistency), `backup-export.ts`, `disk-report.ts`,
//! `doctor.ts`, `foundation/deployment.ts` (`readDeploymentReleases`), the
//! date repair, the credential exports and channel commands of `registry.ts`,
//! `format-support.ts` (`recordFormatEvidence`), `threads-authorize.ts`,
//! `telegram-stories-login.ts`.

mod deployment;
mod disk;
pub(crate) use disk::orphaned_story_variants;
mod exports;
mod format_evidence;
mod maintenance;
mod rows;
mod threads;

use channels::api_keys::{ApiKeyTarget, store_api_key};
use channels::entropy::OsEntropy;
use content::Locale;
use domain::application::ports::ApplicationPorts;
use domain::observability::capabilities::capability_report;
use domain::observability::dates::repair_stored_dates;
use domain::studio::boundaries::{CapabilityStatus, ConnectPlatform};
use domain::studio::config::studio_config;
use domain::studio::services::channels::ChannelInput;
use foundation::config::{Config, SharedConfig};
use mtproto::{Credentials, SignInPrompts, sign_in};
use runtime::data_dirs::{check_data_directories_writable, required_data_directories};
use runtime::external::youtube::youtube_credentials;
use serde_json::{Map, Value, json};

use crate::context::{Fut, Input, OpError, OpResult, OperationContext, Terminal, to_value};
use exports::{ExportKind, export_status};

fn locale(input: &Input) -> Locale {
    if input.str("locale") == "en" {
        Locale::En
    } else {
        Locale::Ru
    }
}

fn present(value: Option<&str>) -> bool {
    value.is_some_and(|value| !value.is_empty())
}

fn channel_error(error: channels::error::Error) -> OpError {
    OpError::Failed(error.to_string())
}

/// `analytics-export`: the read credentials of every enabled social channel,
/// written to stdout for a private statistics collector. X stays with
/// publishing; the collector needs its own authorization.
pub fn analytics_export<'a>(context: &'a OperationContext<'a>, _input: &'a Input) -> Fut<'a, OpResult> {
    Box::pin(async move {
        if context.actor_type != "ops-cli" {
            return Err(OpError::failed(
                "Social credentials can only be exported by the local CLI",
            ));
        }
        let terminal = context.terminal()?;
        if terminal.stdout_is_tty() {
            return Err(OpError::failed(
                "Pipe social credentials into a private receiving process",
            ));
        }
        let config = context.config()?;
        let mut connections = Map::new();
        for channel in context.services(&config)?.channels.report(false)? {
            if !channel.enabled || ["site", "youtube", "x"].contains(&channel.platform.as_str()) {
                continue;
            }
            let platform = if channel.platform.starts_with("instagram") {
                "instagram"
            } else if channel.platform.starts_with("threads") {
                "threads"
            } else {
                channel.platform.as_str()
            };
            let english = channel.locale == "en";
            let access_token = if channel.provider == "zernio" {
                config.zernio_api_key.as_deref()
            } else {
                match platform {
                    "instagram" if english => config.instagram_en_access_token.as_deref(),
                    "instagram" => config.instagram_ru_access_token.as_deref(),
                    "threads" if english => config.threads_en_access_token.as_deref(),
                    "threads" => config.threads_ru_access_token.as_deref(),
                    "discord" => config.discord_bot_token.as_deref(),
                    "telegram" | "telegram_stories" => config.controller_bot_token.as_deref(),
                    _ => None,
                }
            };
            let Some(access_token) = access_token.filter(|token| !token.is_empty()) else {
                continue;
            };
            let telegram = platform == "telegram" || platform == "telegram_stories";
            let discord = platform == "discord";
            let mut connection = Map::new();
            connection.insert("access_token".into(), json!(access_token));
            connection.insert(
                "account_id".into(),
                json!(channel.provider_account_id.clone().unwrap_or_default()),
            );
            connection.insert(
                "channel_id".into(),
                json!(if telegram {
                    config.telegram_channel_username.clone()
                } else if discord {
                    config.discord_channel_id.clone().unwrap_or_default()
                } else {
                    String::new()
                }),
            );
            connection.insert(
                "guild_id".into(),
                json!(if discord {
                    config.discord_guild_id.clone().unwrap_or_default()
                } else {
                    String::new()
                }),
            );
            if channel.provider != "zernio" && platform == "instagram" {
                let host = if access_token.starts_with("IG") {
                    "graph.instagram.com"
                } else {
                    "graph.facebook.com"
                };
                connection.insert(
                    "api_base".into(),
                    json!(format!("https://{host}/{}", config.instagram_graph_api_version)),
                );
            }
            connections.insert(channel.id.clone(), Value::Object(connection));
        }
        terminal.write(json!({"connections": connections}).to_string().as_bytes())?;
        Ok(json!({"exported": true}))
    })
}

/// `youtube-export`: one YouTube connection, written to stdout for another
/// private process.
pub fn youtube_export<'a>(context: &'a OperationContext<'a>, input: &'a Input) -> Fut<'a, OpResult> {
    Box::pin(async move {
        if context.actor_type != "ops-cli" {
            return Err(OpError::failed(
                "YouTube credentials can only be exported by the local CLI",
            ));
        }
        let terminal = context.terminal()?;
        if terminal.stdout_is_tty() {
            return Err(OpError::failed(
                "Pipe YouTube credentials into a private receiving process",
            ));
        }
        let config = context.config()?;
        let credentials = youtube_credentials(&config, locale(input));
        let (Some(client_id), Some(client_secret), Some(refresh_token)) = (
            credentials.client_id.filter(|value| !value.is_empty()),
            credentials.client_secret.filter(|value| !value.is_empty()),
            credentials.refresh_token.filter(|value| !value.is_empty()),
        ) else {
            return Err(OpError::failed("The selected YouTube connection is incomplete"));
        };
        let payload = json!({
            "client_id": client_id,
            "client_secret": client_secret,
            "refresh_token": refresh_token,
        });
        terminal.write(payload.to_string().as_bytes())?;
        Ok(json!({"exported": true}))
    })
}

/// `doctorChecks` (`operations/doctor.ts`) and the `doctor` entry around it.
pub fn doctor<'a>(context: &'a OperationContext<'a>, _input: &'a Input) -> Fut<'a, OpResult> {
    Box::pin(async move {
        let config = context.config()?;
        let directories = check_data_directories_writable(&required_data_directories(&config));
        let sqlite = context.sqlite()?;
        let media_export = export_status(sqlite, ExportKind::Media, context.now())?;
        let data_directories_writable = directories.iter().all(|check| check.writable);
        // The database leaves nightly over Telegram; media only ever existed on
        // the volume, so a puller that stopped has to show up here.
        let media_backed_up = media_export["ok"] == Value::Bool(true);
        let capabilities = capability_report(&config, sqlite)?;
        let ok = data_directories_writable
            && media_backed_up
            && capabilities
                .iter()
                .all(|capability| capability.status == CapabilityStatus::Ready);
        let studio = studio_config(ApplicationPorts::new(context.db()?, context.clock));
        let data_directories: Vec<Value> = directories
            .iter()
            .map(|check| {
                let mut entry = Map::new();
                entry.insert("name".into(), json!(check.name));
                entry.insert("path".into(), json!(check.path.display().to_string()));
                entry.insert("writable".into(), json!(check.writable));
                if let Some(error) = &check.error {
                    entry.insert("error".into(), json!(error));
                }
                Value::Object(entry)
            })
            .collect();
        Ok(json!({
            "ok": ok,
            "siteEnabled": studio.site_enabled()?,
            "video": to_value(studio.video()?)?,
            "publicBaseUrl": config.public_base_url,
            "checks": {
                "dataDirectoriesWritable": data_directories_writable,
                "mediaBackedUp": media_backed_up,
                "telegramBot": present(config.controller_bot_token.as_deref()),
                "commandCenterTokenConfigured": present(config.command_center_token.as_deref()),
                // Both halves: the token authorizes nothing without its actor.
                "studioTransportConfigured": present(config.mcp_studio_token.as_deref())
                    && config.mcp_studio_actor_id.is_some_and(|id| id != 0),
            },
            "dataDirectories": data_directories,
            "mediaExport": media_export,
            "capabilities": to_value(capabilities)?,
        }))
    })
}

pub fn deployments<'a>(context: &'a OperationContext<'a>, _input: &'a Input) -> Fut<'a, OpResult> {
    Box::pin(async move {
        let config = context.config()?;
        Ok(deployment::read_deployment_releases(&config, &context.http).await)
    })
}

pub fn dates_repair<'a>(context: &'a OperationContext<'a>, input: &'a Input) -> Fut<'a, OpResult> {
    Box::pin(async move { to_value(repair_stored_dates(context.sqlite()?, input.bool("apply"))?) })
}

pub fn audit<'a>(context: &'a OperationContext<'a>, _input: &'a Input) -> Fut<'a, OpResult> {
    Box::pin(async move {
        let config = context.config()?;
        let studio = context.studio(&config)?;
        maintenance::audit_operations(context.sqlite()?, &studio.publishing, context.now())
    })
}

pub fn publication_repair<'a>(context: &'a OperationContext<'a>, input: &'a Input) -> Fut<'a, OpResult> {
    Box::pin(async move {
        let config = context.config()?;
        let studio = context.studio(&config)?;
        let sqlite = context.sqlite()?;
        let publication = input.opt_str("ref");
        let before = maintenance::publication_consistency_report(sqlite, &studio.publishing, publication)?;
        let repaired = if input.bool("apply") {
            maintenance::repair_publication_consistency(sqlite, &studio.publishing, publication, context.now())?
        } else {
            Value::Null
        };
        let after = if repaired.is_null() {
            Value::Null
        } else {
            maintenance::publication_consistency_report(sqlite, &studio.publishing, publication)?
        };
        let mut out = Map::new();
        if let Some(publication) = publication.filter(|value| !value.is_empty()) {
            out.insert("ref".into(), json!(publication));
        }
        out.insert("before".into(), before);
        out.insert("repaired".into(), repaired);
        out.insert("after".into(), after);
        Ok(Value::Object(out))
    })
}

pub fn disk<'a>(context: &'a OperationContext<'a>, _input: &'a Input) -> Fut<'a, OpResult> {
    Box::pin(async move {
        let config = context.config()?;
        disk::disk_report(context.sqlite()?, &config)
    })
}

pub fn backup<'a>(context: &'a OperationContext<'a>, input: &'a Input) -> Fut<'a, OpResult> {
    Box::pin(async move {
        let path =
            maintenance::backup_database(context.db()?, &context.db_path, input.opt_str("output"), context.now())?;
        Ok(json!({"ok": true, "path": path}))
    })
}

pub fn backup_stream<'a>(context: &'a OperationContext<'a>, input: &'a Input) -> Fut<'a, OpResult> {
    Box::pin(async move {
        let terminal = context.terminal()?;
        if input.str("what") == "db" {
            exports::stream_database(&context.db_path, context.sqlite()?, terminal, context.now())
        } else {
            let config = context.config()?;
            exports::stream_media_archive(&config, context.sqlite()?, terminal, context.now()).await
        }
    })
}

/// The database is not opened before the file is replaced.
pub fn restore<'a>(context: &'a OperationContext<'a>, input: &'a Input) -> Fut<'a, OpResult> {
    Box::pin(async move {
        maintenance::restore_database(input.str("source"), &context.db_path, input.bool("force"))?;
        Ok(json!({"ok": true, "restored": context.db_path.display().to_string()}))
    })
}

pub fn format_record<'a>(context: &'a OperationContext<'a>, input: &'a Input) -> Fut<'a, OpResult> {
    Box::pin(async move {
        let status = format_evidence::record_format_evidence(
            context.sqlite()?,
            input.str("test"),
            input.int("post_id"),
            input.opt_str("notes"),
            context.now(),
        )?;
        Ok(json!({"ok": true, "status": status}))
    })
}

/// The target is the whole identity of a text or story route; a video account
/// needs its platform and language.
pub fn channel_connect<'a>(context: &'a OperationContext<'a>, input: &'a Input) -> Fut<'a, OpResult> {
    Box::pin(async move {
        let config = context.config()?;
        let services = context.services(&config)?;
        let provider = input.str("provider");
        let account_id = input.opt_str("account_id");
        let label = input.opt_str("label");
        if let Some(target) = input.opt_str("target").filter(|target| !target.is_empty()) {
            let channel = services.channels.connect_target(
                target,
                Some(provider),
                account_id,
                label,
                Some(context.actor_type),
            )?;
            return Ok(json!({"id": channel.connection.id}));
        }
        let (Some(platform), Some(_)) = (
            input.opt_str("platform").filter(|value| !value.is_empty()),
            input.opt_str("locale").filter(|value| !value.is_empty()),
        ) else {
            return Err(OpError::failed(
                "channel-connect needs --target, or --platform with --locale",
            ));
        };
        let channel = services.channels.connect(
            &ChannelInput {
                platform: platform.to_owned(),
                locale: locale(input),
                provider: provider.to_owned(),
                provider_account_id: account_id.filter(|value| !value.is_empty()).map(str::to_owned),
                target_id: None,
                label: label.filter(|value| !value.is_empty()).map(str::to_owned),
                source: None,
            },
            Some(context.actor_type),
        )?;
        Ok(json!({"id": channel.connection.id}))
    })
}

pub fn connect_link<'a>(context: &'a OperationContext<'a>, input: &'a Input) -> Fut<'a, OpResult> {
    Box::pin(async move {
        let config = context.config()?;
        let platform: ConnectPlatform = serde_json::from_value(json!(input.str("platform")))?;
        let start = channels::connect::start_connect(&config, platform, locale(input), context.now(), &OsEntropy)
            .map_err(channel_error)?;
        to_value(start)
    })
}

pub fn channel_disable<'a>(context: &'a OperationContext<'a>, input: &'a Input) -> Fut<'a, OpResult> {
    Box::pin(async move {
        let config = context.config()?;
        let channel = context.services(&config)?.channels.disable(input.str("channel"))?;
        Ok(json!({"id": channel.connection.id, "disabled": true}))
    })
}

/// The key arrives on standard input, so it never appears in a command line.
pub fn credential_set<'a>(context: &'a OperationContext<'a>, input: &'a Input) -> Fut<'a, OpResult> {
    Box::pin(async move {
        let target = ApiKeyTarget::parse(input.str("target"))
            .ok_or_else(|| OpError::failed(format!("unknown API key target: {}", input.str("target"))))?;
        let config = SharedConfig::new(Config::clone(&*context.config()?));
        let value = context.terminal()?.read_stdin()?;
        let stored = store_api_key(&config, context.sqlite()?, &context.http, target, &value, context.now())
            .await
            .map_err(channel_error)?;
        Ok(json!({"target": stored.target.as_str(), "account": stored.account}))
    })
}

/// Signs the Stories account in over MTProto, asking at this terminal; the
/// session lands at `TELEGRAM_CHANNEL_STORIES_SESSION`. The configuration is
/// checked before anything touches the network.
pub fn telegram_stories_login<'a>(context: &'a OperationContext<'a>, _input: &'a Input) -> Fut<'a, OpResult> {
    Box::pin(async move {
        let config = context.config()?;
        if config.telegram_channel_stories_api_id.is_none_or(|id| id == 0)
            || !present(config.telegram_channel_stories_api_hash.as_deref())
        {
            return Err(OpError::failed(
                "Set TELEGRAM_CHANNEL_STORIES_API_ID and TELEGRAM_CHANNEL_STORIES_API_HASH first. Create them at https://my.telegram.org under API development tools.",
            ));
        }
        if !present(config.telegram_channel_stories_session.as_deref()) {
            return Err(OpError::failed(
                "Set TELEGRAM_CHANNEL_STORIES_SESSION to a writable path, for example /data/telegram_channel_stories.",
            ));
        }
        let credentials = Credentials::from_config(&config)
            .map_err(OpError::failed)?
            .ok_or_else(|| OpError::failed("the Stories credentials are incomplete"))?;
        let signed_in = sign_in(&credentials, &TerminalPrompts(context.terminal()?))
            .await
            .map_err(OpError::failed)?;
        Ok(json!({"signedIn": true, "user": signed_in.user, "session": credentials.session}))
    })
}

/// The sign-in's questions, at the operator's terminal.
struct TerminalPrompts<'a>(&'a dyn Terminal);

impl SignInPrompts for TerminalPrompts<'_> {
    fn ask(&self, question: &str) -> String {
        self.0.ask(question)
    }

    fn tell(&self, line: &str) {
        let _ = self.0.print_line(line);
    }
}

pub fn threads_authorize<'a>(context: &'a OperationContext<'a>, input: &'a Input) -> Fut<'a, OpResult> {
    Box::pin(async move {
        let config = context.config()?;
        threads::authorize_threads(&config, locale(input), context.terminal()?, &context.http).await
    })
}

pub fn format_connect_link(result: &Value) -> String {
    format!(
        "{}\n\nOpen within {} minutes.",
        result["url"].as_str().unwrap_or_default(),
        result["expiresInMinutes"]
    )
}

pub fn format_credential_set(result: &Value) -> String {
    format!(
        "{} key stored ({})",
        result["target"].as_str().unwrap_or_default(),
        result["account"].as_str().unwrap_or_default()
    )
}
