//! `delivery/ports/social.ts`: the preparation every non-Telegram target's job
//! goes through before it is published — the media staged once per (post,
//! part, target, media) within this instance, one preparation at a time, and
//! a Story given its prepared vertical variant instead of a render.

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Arc;

use content::message::MediaItem;
use domain::json::stringify;
use domain::publishing::delivery_payload::has_resume_state;
use domain::publishing::media_policy::select_media_for_target;
use domain::publishing::queue::ClaimedPublishJob;
use domain::targets::is_story_target;
use foundation::config::Config;
use foundation::logger::{LogLevel, log};
use futures_util::FutureExt as _;
use futures_util::future::{LocalBoxFuture, Shared};
use runtime::http::Fut;
use serde_json::{Value, json};

use crate::error::{AdapterError, Result};
use crate::payload::{field, payload_media, payload_thread};
use crate::ports::PrepareJob;

const MAX_PREPARATION_CACHE_ENTRIES: usize = 32;

/// The media work preparation hands off (`delivery/media-prepare.ts`,
/// `delivery/story-derivatives.ts`), implemented by the delivery runtime.
pub trait MediaPreparation {
    /// `prepareMediaItems(config, media, fetchImpl, target)`: the items
    /// staged where the target's platform can fetch them.
    fn prepare_media_items(
        &self,
        config: Arc<Config>,
        media: Vec<MediaItem>,
        target: String,
    ) -> LocalBoxFuture<'static, Result<Vec<MediaItem>>>;
    /// `awaitPreparedStoryMedia(config, item)`: the Story variant made at
    /// ingress, waiting for a render already running — never starting one.
    fn await_prepared_story_media<'a>(
        &'a self,
        config: &'a Config,
        item: &'a MediaItem,
    ) -> Fut<'a, Result<Option<MediaItem>>>;
}

type Preparation = Shared<LocalBoxFuture<'static, Result<Vec<MediaItem>>>>;

/// `createPlatformPorts`' preparation: owned by one adapter set, so cache
/// entries never leak between independently configured instances.
pub struct PreparedMedia {
    preparation: Rc<dyn MediaPreparation>,
    cache: RefCell<Vec<(String, Preparation)>>,
    queue: Rc<tokio::sync::Mutex<()>>,
}

impl PreparedMedia {
    pub fn new(preparation: Rc<dyn MediaPreparation>) -> Self {
        Self {
            preparation,
            cache: RefCell::new(Vec::new()),
            queue: Rc::new(tokio::sync::Mutex::new(())),
        }
    }

    /// `part` is the post of a thread the media belongs to; an ordinary
    /// post is part 1. One preparation per (post, target, media) per cycle.
    async fn prepare_cached(
        &self,
        job: &ClaimedPublishJob,
        config: &Arc<Config>,
        media: Vec<MediaItem>,
        part: usize,
    ) -> Result<Vec<MediaItem>> {
        let key = cache_key(job, &media, config, part);
        let prepared = self.read_cache(&key).unwrap_or_else(|| {
            let queue = Rc::clone(&self.queue);
            let work = self
                .preparation
                .prepare_media_items(Arc::clone(config), media, job.target.clone());
            let prepared = async move {
                let _turn = queue.lock().await;
                work.await
            }
            .boxed_local()
            .shared();
            self.write_cache(key.clone(), prepared.clone());
            prepared
        });
        let outcome = prepared.await;
        if outcome.is_err() {
            self.cache.borrow_mut().retain(|(entry, _)| *entry != key);
        }
        outcome
    }

    fn read_cache(&self, key: &str) -> Option<Preparation> {
        let mut cache = self.cache.borrow_mut();
        let index = cache.iter().position(|(entry, _)| entry == key)?;
        let entry = cache.remove(index);
        let prepared = entry.1.clone();
        cache.push(entry);
        Some(prepared)
    }

    fn write_cache(&self, key: String, prepared: Preparation) {
        let mut cache = self.cache.borrow_mut();
        cache.retain(|(entry, _)| *entry != key);
        cache.push((key, prepared));
        while cache.len() > MAX_PREPARATION_CACHE_ENTRIES {
            drop(cache.remove(0));
        }
    }

    /// A read, and a wait for a render already running — never a render of
    /// its own: a missing variant is refused rather than paid for with the
    /// audience waiting. `story-media-backfill` makes what predates ingress.
    async fn require_story_media(&self, config: &Config, media: Vec<MediaItem>) -> Result<Vec<MediaItem>> {
        let Some(source) = media.first() else {
            return Ok(media);
        };
        if let Some(prepared) = self.preparation.await_prepared_story_media(config, source).await? {
            return Ok(vec![prepared]);
        }
        Err(AdapterError::Message(format!(
            "story_media_unprepared: no Story variant for {} -- run `ops story-media-backfill --apply`",
            field(source, "localPath").unwrap_or("media with no local file")
        )))
    }
}

/// The identity of one preparation. Story media is a separately rendered
/// 9:16 asset and never shares an entry with the feed source.
fn cache_key(job: &ClaimedPublishJob, media: &[MediaItem], config: &Config, part: usize) -> String {
    let item = |item: &MediaItem| {
        json!([
            item.get("fileId").cloned().unwrap_or(Value::Null),
            item.get("localPath").cloned().unwrap_or(Value::Null),
            item.get("type").cloned().unwrap_or(Value::Null),
        ])
    };
    stringify(&json!({
        "post": job.publication_key,
        "part": part,
        "target": job.target,
        "locale": crate::js::present(job.payload.get("locale")).cloned().unwrap_or_else(|| "en".into()),
        "story": is_story_target(&job.target),
        "media": media.iter().map(item).collect::<Vec<_>>(),
        "remote": config.remote_media_path,
    }))
}

impl PrepareJob for PreparedMedia {
    fn prepare<'a>(&'a self, job: ClaimedPublishJob, config: &'a Arc<Config>) -> Fut<'a, Result<ClaimedPublishJob>> {
        Box::pin(async move {
            let story = is_story_target(&job.target);
            // Thread parts are prepared on every attempt: a chain resumed after
            // its first post still has replies to send, each with its media.
            let thread = if story {
                Vec::new()
            } else {
                payload_thread(&job.payload)
            };
            let mut prepared = job.clone();
            if thread.iter().any(|part| !part.media.is_empty()) {
                let mut parts = Vec::new();
                for (index, part) in thread.into_iter().enumerate() {
                    let media = if part.media.is_empty() {
                        Vec::new()
                    } else {
                        self.prepare_cached(&job, config, part.media, index + 2).await?
                    };
                    parts.push(json!({"text": part.text, "entities": part.entities, "media": media}));
                }
                prepared.payload.insert("thread".into(), Value::Array(parts));
            }
            // A job carrying resume state is going back to finish a
            // publication: the first post's media is already uploaded.
            if has_resume_state(&job.payload) {
                return Ok(prepared);
            }
            let media = payload_media(&job.payload);
            if media.is_empty() {
                return Ok(prepared);
            }
            // A Story is one vertical visual: select the locale's first item
            // before any transformation, and take the durable Story variant
            // rather than staging the source first.
            let values: Vec<Value> = media.into_iter().map(Value::Object).collect();
            let selected: Vec<MediaItem> = select_media_for_target(&job.target, &values, |value| value)
                .into_iter()
                .filter_map(|value| match value {
                    Value::Object(item) => Some(item),
                    _ => None,
                })
                .collect();
            let source = if story {
                log(
                    LogLevel::Info,
                    "story delivery preparation started",
                    Some(json!({"jobId": job.job_id, "target": job.target})),
                );
                self.require_story_media(config, selected).await?
            } else {
                selected
            };
            let items = self.prepare_cached(&job, config, source, 1).await?;
            prepared.payload.insert(
                "media".into(),
                Value::Array(items.into_iter().map(Value::Object).collect()),
            );
            Ok(prepared)
        })
    }
}
