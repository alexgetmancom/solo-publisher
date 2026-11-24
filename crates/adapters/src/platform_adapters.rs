//! `delivery/platform-adapters.ts`: one adapter per durable target, routed
//! natively or through the provider, with the validation, verification and
//! edit/remove ports each target has.

use std::rc::Rc;

use content::Locale;
use domain::observability::capabilities::missing_settings;
use domain::publishing::errors::PublishResult;
use domain::publishing::platform_profiles::platform_profile;
use domain::publishing::queue::ClaimedPublishJob;
use domain::targets::{INSTAGRAM_STORY_TARGETS, TELEGRAM_STORY_TARGETS, THREADS_TARGETS};
use runtime::external::instagram::instagram_credentials_for_locale;
use runtime::http::Fut;
use serde_json::{Map, Value, json};

use crate::error::{AdapterError, Result, absent_if_missing};
use crate::ports::{AdapterContext, DeliveryPorts, EditOutcome, EditRequest, PrepareJob, SocialAdapter};
use crate::telegram_stories::StoriesClient;
use crate::zernio::{ZernioPlatform, verify_zernio_post};
use crate::{discord, instagram, telegram, telegram_stories, threads, x};

/// How one connected target is delivered (`TargetRouting`). A target absent
/// from the routing is delivered natively.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TargetRouting(pub Vec<(String, Route)>);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Route {
    pub provider: String,
    pub account_id: Option<String>,
}

impl TargetRouting {
    fn route(&self, target: &str) -> Option<&Route> {
        self.0.iter().find(|(name, _)| name == target).map(|(_, route)| route)
    }

    fn through_provider(&self, target: &str) -> bool {
        self.route(target).is_some_and(|route| route.provider == "zernio")
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Delivery {
    Telegram,
    Threads,
    X,
    XArticle,
    Discord,
    InstagramStory,
    TelegramStory,
    /// Routed through Zernio, on its platform; a Story is posted as one.
    Provider {
        platform: ZernioPlatform,
        account_id: Option<String>,
        story: bool,
    },
}

/// The Instagram credentials a Story target publishes with.
fn story_locale(target: &str) -> Locale {
    if target == "instagram_stories" {
        Locale::En
    } else {
        Locale::Ru
    }
}

/// `createPlatformAdapters(config, fetchImpl, prepare, routing)`.
pub fn create_platform_adapters(
    ctx: AdapterContext,
    prepare: Rc<dyn PrepareJob>,
    stories: Rc<dyn StoriesClient>,
    routing: &TargetRouting,
) -> DeliveryPorts {
    let ctx = Rc::new(ctx);
    let provider = |target: &str, platform, story| Delivery::Provider {
        platform,
        account_id: routing.route(target).and_then(|route| route.account_id.clone()),
        story,
    };
    let mut deliveries: Vec<(&str, Delivery)> = vec![("telegram", Delivery::Telegram)];
    for target in THREADS_TARGETS {
        deliveries.push((
            target,
            if routing.through_provider(target) {
                provider(target, ZernioPlatform::Threads, false)
            } else {
                Delivery::Threads
            },
        ));
    }
    deliveries.push(("x", Delivery::X));
    deliveries.push(("x_article", Delivery::XArticle));
    deliveries.push(("discord", Delivery::Discord));
    for target in INSTAGRAM_STORY_TARGETS {
        deliveries.push((
            target,
            if routing.through_provider(target) {
                provider(target, ZernioPlatform::Instagram, true)
            } else {
                Delivery::InstagramStory
            },
        ));
    }
    for target in TELEGRAM_STORY_TARGETS {
        deliveries.push((target, Delivery::TelegramStory));
    }
    DeliveryPorts(
        deliveries
            .into_iter()
            .map(|(target, delivery)| {
                let adapter: Box<dyn SocialAdapter> = Box::new(PlatformAdapter {
                    target: target.to_owned(),
                    delivery,
                    ctx: Rc::clone(&ctx),
                    prepare: Rc::clone(&prepare),
                    stories: Rc::clone(&stories),
                });
                (target.to_owned(), adapter)
            })
            .collect(),
    )
}

struct PlatformAdapter {
    target: String,
    delivery: Delivery,
    ctx: Rc<AdapterContext>,
    prepare: Rc<dyn PrepareJob>,
    stories: Rc<dyn StoriesClient>,
}

impl SocialAdapter for PlatformAdapter {
    fn validate(&self, _: &ClaimedPublishJob) -> Result<()> {
        validate_platform_target(
            &self.ctx,
            &self.target,
            matches!(self.delivery, Delivery::Provider { .. }),
        )
    }

    fn prepare(&self, job: ClaimedPublishJob) -> Fut<'_, Result<ClaimedPublishJob>> {
        if self.delivery == Delivery::Telegram {
            return Box::pin(async move { Ok(job) });
        }
        self.prepare.prepare(job, &self.ctx.config)
    }

    fn publish<'a>(&'a self, job: &'a ClaimedPublishJob) -> Fut<'a, Result<PublishResult>> {
        Box::pin(async move {
            let ctx = &self.ctx;
            let payload = &job.payload;
            match &self.delivery {
                Delivery::Telegram => telegram::publish_to_telegram(ctx, payload).await,
                Delivery::Threads => threads::publish_to_threads(ctx, payload, &self.target).await,
                Delivery::X => x::publish_to_x(ctx, payload).await,
                Delivery::XArticle => x::publish_x_article(ctx, payload).await,
                Delivery::Discord => discord::publish_to_discord(ctx, payload).await,
                Delivery::InstagramStory => {
                    let credentials = instagram_credentials_for_locale(&ctx.config, story_locale(&self.target));
                    instagram::publish_instagram_story(ctx, payload, credentials).await
                }
                Delivery::TelegramStory => {
                    telegram_stories::publish_telegram_story(ctx, self.stories.as_ref(), payload).await
                }
                Delivery::Provider {
                    platform,
                    account_id,
                    story,
                } => {
                    crate::zernio::publish_through_zernio(
                        ctx,
                        job,
                        &self.target,
                        *platform,
                        account_id.as_deref(),
                        *story,
                    )
                    .await
                }
            }
        })
    }

    fn verify<'a>(&'a self, _: &'a ClaimedPublishJob, result: PublishResult) -> Fut<'a, PublishResult> {
        Box::pin(async move {
            match &self.delivery {
                Delivery::Provider { platform, .. } => verify_zernio_publication(&self.ctx, result, *platform).await,
                _ => verify_platform_publication(&self.ctx, &self.target, result).await,
            }
        })
    }

    fn edit<'a>(&'a self, edit: &'a EditRequest) -> Option<Fut<'a, Result<EditOutcome>>> {
        let ctx = &self.ctx;
        match self.delivery {
            Delivery::Telegram => Some(Box::pin(telegram::edit_telegram_message(ctx, edit))),
            Delivery::Discord => Some(Box::pin(discord::edit_discord(ctx, edit))),
            _ => None,
        }
    }

    fn remove<'a>(&'a self, external_id: &'a str) -> Option<Fut<'a, Result<Value>>> {
        let ctx = &self.ctx;
        if THREADS_TARGETS.contains(&self.target.as_str()) {
            return Some(Box::pin(threads::delete_threads_post(ctx, external_id, &self.target)));
        }
        match self.delivery {
            Delivery::Telegram => Some(Box::pin(telegram::delete_telegram_message(ctx, external_id))),
            Delivery::Discord => Some(Box::pin(discord::delete_discord_message(ctx, external_id))),
            _ => None,
        }
    }
}

fn verification(status: &str) -> Map<String, Value> {
    let mut verification = Map::new();
    verification.insert("status".into(), status.into());
    verification
}

fn unavailable(mut result: PublishResult, error: &str) -> PublishResult {
    let mut verification = verification("unavailable");
    verification.insert("error".into(), error.into());
    result.insert("verification".into(), Value::Object(verification));
    result
}

/// A provider publication is verified once the platform has its id.
async fn verify_zernio_publication(
    ctx: &AdapterContext,
    mut result: PublishResult,
    platform: ZernioPlatform,
) -> PublishResult {
    if !result.get("ok").is_some_and(domain::json::truthy) {
        return result;
    }
    let Some(provider_post_id) = result
        .get("providerPostId")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_owned)
    else {
        return unavailable(result, "Zernio did not return a provider post ID");
    };
    match verify_zernio_post(ctx, &provider_post_id, platform).await {
        Err(error) => unavailable(result, error.message()),
        Ok(verified) => {
            let Some(external_id) = verified.external_id else {
                return unavailable(
                    result,
                    &format!("{} publication is still pending at Zernio", platform.as_str()),
                );
            };
            let url = verified
                .url
                .map(Value::from)
                .or_else(|| crate::js::present(result.get("url")).cloned())
                .unwrap_or(Value::Null);
            result.insert("id".into(), external_id.clone().into());
            result.insert("url".into(), url);
            result.insert(
                "verification".into(),
                json!({"status": "verified", "providerId": external_id}),
            );
            result
        }
    }
}

/// `verifyPlatformPublication`: the publication asked of the platform.
pub async fn verify_platform_publication(
    ctx: &AdapterContext,
    target: &str,
    mut result: PublishResult,
) -> PublishResult {
    let deferred = result.get("deferred").is_some_and(domain::json::truthy);
    if deferred || result.get("verification").is_some_and(Value::is_object) {
        return result;
    }
    let ok = result.get("ok").is_some_and(domain::json::truthy);
    let Some(id) = crate::js::present(result.get("id"))
        .filter(|_| ok)
        .map(domain::json::js_string)
    else {
        return result;
    };
    // x_article deliberately falls through to "unsupported": whether its
    // publish response carries a readable post id is undocumented, and asking
    // the posts endpoint for an article id would report every article
    // unverifiable.
    let verified: Result<(String, Option<Value>)> = if THREADS_TARGETS.contains(&target) {
        threads::verify_threads_post(ctx, &id, target)
            .await
            .map(|(id, url)| (id, Some(url)))
    } else if INSTAGRAM_STORY_TARGETS.contains(&target) {
        let credentials = instagram_credentials_for_locale(&ctx.config, story_locale(target));
        instagram::verify_instagram_publication(ctx, &id, credentials)
            .await
            .map(|(id, url)| (id, Some(url)))
    } else if target == "x" {
        x::verify_x_post(ctx, &id).await.map(|id| (id, None))
    } else if target == "discord" {
        discord::verify_discord_message(ctx, &id)
            .await
            .map(|(id, url)| (id, Some(url)))
    } else {
        result.insert("verification".into(), Value::Object(verification("unsupported")));
        return result;
    };
    match verified {
        Err(error) => unavailable(result, error.message()),
        Ok((provider_id, url)) => {
            if let Some(url) = url
                && crate::js::present(result.get("url")).is_none()
            {
                result.insert("url".into(), url);
            }
            result.insert(
                "verification".into(),
                json!({"status": "verified", "providerId": provider_id}),
            );
            result
        }
    }
}

/// `textTargetIsAbsent`: whether the platform still has a published text
/// post, asked of the platform — Threads and Instagram serve a login wall
/// with HTTP 200 to a logged-out request whether or not the post is there.
/// `None`: this target has no such API, and the caller falls back to the
/// public address.
pub async fn text_target_is_absent(ctx: &AdapterContext, target: &str, external_id: &str) -> Result<Option<bool>> {
    let absent = if THREADS_TARGETS.contains(&target) {
        absent_if_missing(threads::verify_threads_post(ctx, external_id, target).await)
    } else if target == "x" {
        absent_if_missing(x::verify_x_post(ctx, external_id).await)
    } else if target == "discord" {
        absent_if_missing(discord::verify_discord_message(ctx, external_id).await)
    } else if INSTAGRAM_STORY_TARGETS.contains(&target) {
        let credentials = instagram_credentials_for_locale(&ctx.config, story_locale(target));
        absent_if_missing(instagram::verify_instagram_publication(ctx, external_id, credentials).await)
    } else {
        return Ok(None);
    };
    absent.map(Some)
}

/// What a target needs is what its delivery path reads. A Story routed
/// through the provider needs the provider key, not Instagram tokens.
fn validate_platform_target(ctx: &AdapterContext, target: &str, through_provider: bool) -> Result<()> {
    let config = &ctx.config;
    if through_provider {
        if config.zernio_api_key.as_deref().is_none_or(str::is_empty) {
            return Err(AdapterError::message_text(
                "Delivery through the provider is not configured: ZERNIO_API_KEY",
            ));
        }
        return Ok(());
    }
    if INSTAGRAM_STORY_TARGETS.contains(&target) {
        let credentials = instagram_credentials_for_locale(config, story_locale(target));
        let missing: Vec<&str> = [
            credentials
                .access_token
                .is_none_or(str::is_empty)
                .then_some("Instagram access token"),
            credentials
                .user_id
                .is_none_or(str::is_empty)
                .then_some("Instagram user id"),
        ]
        .into_iter()
        .flatten()
        .collect();
        if !missing.is_empty() {
            return Err(AdapterError::Message(format!(
                "Instagram Stories is not configured: {}",
                missing.join(", ")
            )));
        }
        return Ok(());
    }
    let Some(profile) = platform_profile(target).filter(|profile| !profile.requirements.is_empty()) else {
        return Ok(());
    };
    let missing = missing_settings(config, profile.requirements);
    if missing.is_empty() {
        return Ok(());
    }
    Err(AdapterError::Message(format!(
        "{} is not configured: {}",
        profile.label,
        missing.join(", ")
    )))
}
