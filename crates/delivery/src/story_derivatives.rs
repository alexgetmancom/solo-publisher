//! The Story shapes of an imported file,
//! made once at ingress and named by its content. Publishing only reads them;
//! `story-media-backfill` makes the ones ingress never saw.
//!
//! [`DeliveryMedia`] is the one media runtime of a process: the adapters'
//! [`MediaPreparation`] and Studio's [`StoryDerivatives`] are both it, so a
//! publication waiting for its Story variant waits on the very render ingress
//! started.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::Arc;
use std::time::Instant;

use adapters::social_ports::MediaPreparation;
use adapters::{AdapterContext, AdapterError};
use content::message::MediaItem;
use domain::application::ports::Clock;
use domain::studio::boundaries::StoryDerivatives;
use foundation::config::{Config, SharedConfig};
use foundation::logger::{LogLevel, log};
use futures_util::FutureExt as _;
use futures_util::future::{LocalBoxFuture, Shared};
use runtime::http::{Fut, HttpClient};
use serde_json::{Map, Value, json};

use crate::media_prepare::prepare_media_items;
use crate::story_media::{render_story_variants, story_directory};

/// Where one source's Story shapes live: a standard render, and for a video
/// the Telegram variant.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoryVariantPaths {
    pub standard: PathBuf,
    pub telegram: Option<PathBuf>,
}

impl StoryVariantPaths {
    pub fn files(&self) -> impl Iterator<Item = &Path> {
        std::iter::once(self.standard.as_path()).chain(self.telegram.as_deref())
    }

    fn present(&self) -> bool {
        self.files().all(Path::exists)
    }
}

/// `storyVariantPaths`: the import stores every asset as
/// `<first 24 of sha256><ext>`, so the stem is the content address and the
/// variants hang off it. The file being there is the record that it was made.
pub fn story_variant_paths(config: &Config, source_path: &str, video: bool) -> StoryVariantPaths {
    let name = source_path.rsplit('/').next().unwrap_or_default();
    // `.replace(/\.[^.]+$/, "")`: the last extension, if it has a character.
    let stem = match name.rfind('.') {
        Some(index) if index + 1 < name.len() => &name[..index],
        _ => name,
    };
    let directory = story_directory(config);
    StoryVariantPaths {
        standard: directory.join(format!("{stem}-story-standard.{}", if video { "mp4" } else { "jpg" })),
        telegram: video.then(|| directory.join(format!("{stem}-story-telegram.mp4"))),
    }
}

/// `storyDerivativePresent`.
pub fn story_derivative_present(config: &Config, source: &str, video: bool) -> bool {
    story_variant_paths(config, source, video).present()
}

fn story_item_is_video(item: &MediaItem) -> bool {
    let kind = match item.get("type") {
        None | Some(Value::Null) => String::new(),
        Some(kind) => foundation::js::string_of(kind),
    };
    kind.to_lowercase().contains("video")
}

fn local_path(item: &MediaItem) -> Option<&str> {
    item.get("localPath").and_then(Value::as_str)
}

/// `preparedStoryMedia`: the item with its prepared variant, or `None` if it
/// was never made.
pub fn prepared_story_media(config: &Config, item: &MediaItem) -> Option<MediaItem> {
    let source = local_path(item)?;
    let paths = story_variant_paths(config, source, story_item_is_video(item));
    if !paths.present() {
        return None;
    }
    let standard = paths.standard.to_string_lossy().into_owned();
    let mut prepared = item.clone();
    prepared.insert("story_local_path".into(), standard.clone().into());
    prepared.insert("storyLocalPath".into(), standard.into());
    if let Some(telegram) = &paths.telegram {
        prepared.insert(
            "telegramStoryLocalPath".into(),
            telegram.to_string_lossy().into_owned().into(),
        );
    }
    prepared.insert("story_width".into(), 1080.into());
    prepared.insert("story_height".into(), 1920.into());
    Some(prepared)
}

type Render = Shared<LocalBoxFuture<'static, Result<bool, String>>>;

/// The process's media runtime: staging for the platforms, and the Story
/// renders, one at a time and shared by path while in flight. Clones share
/// the renders.
#[derive(Clone)]
pub struct DeliveryMedia {
    client: HttpClient,
    config: SharedConfig,
    clock: Rc<dyn Clock>,
    renders: Rc<RefCell<HashMap<PathBuf, (u64, Render)>>>,
    next_render: Rc<Cell<u64>>,
    lane: Rc<tokio::sync::Mutex<()>>,
}

impl DeliveryMedia {
    pub fn new(client: HttpClient, config: SharedConfig, clock: Rc<dyn Clock>) -> Self {
        Self {
            client,
            config,
            clock,
            renders: Rc::new(RefCell::new(HashMap::new())),
            next_render: Rc::new(Cell::new(0)),
            lane: Rc::new(tokio::sync::Mutex::new(())),
        }
    }

    fn context(&self, config: Arc<Config>) -> AdapterContext {
        AdapterContext {
            config,
            client: self.client.clone(),
            clock: Rc::clone(&self.clock),
        }
    }

    fn in_flight(&self, standard: &Path) -> Option<Render> {
        self.renders.borrow().get(standard).map(|(_, render)| render.clone())
    }

    /// `ensureStoryDerivative`: the Story shapes for one source file, made if
    /// they are not already there; whether this call made them. A forced
    /// render (the operator's repair) cannot be answered by one already
    /// running — which may be the very one being repaired — so it queues
    /// behind it. Must run inside the process's `LocalSet`: the render goes on
    /// whether or not anyone keeps waiting for it.
    pub async fn ensure_story_derivative(
        &self,
        config: Arc<Config>,
        source: &str,
        video: bool,
        label: Map<String, Value>,
        force: bool,
    ) -> Result<bool, String> {
        let paths = story_variant_paths(&config, source, video);
        if !force && paths.present() {
            return Ok(false);
        }
        let in_flight = self.in_flight(&paths.standard);
        if let Some(render) = &in_flight
            && !force
        {
            return render.clone().await;
        }
        let id = self.next_render.get();
        self.next_render.set(id + 1);
        let ctx = self.context(config);
        let standard = paths.standard.clone();
        let (renders, lane, key) = (Rc::clone(&self.renders), Rc::clone(&self.lane), standard.clone());
        let source = source.to_owned();
        let task = tokio::task::spawn_local(async move {
            if let Some(prior) = in_flight {
                let _ = prior.await;
            }
            let outcome = {
                let _turn = lane.lock().await;
                render_variants(&ctx, &source, &paths, video, &label, force).await
            };
            let mut renders = renders.borrow_mut();
            if renders.get(&key).is_some_and(|(current, _)| *current == id) {
                renders.remove(&key);
            }
            outcome
        });
        let render: Render = async move { task.await.unwrap_or_else(|error| Err(error.to_string())) }
            .boxed_local()
            .shared();
        self.renders.borrow_mut().insert(standard, (id, render.clone()));
        render.await
    }

    /// `awaitPreparedStoryMedia`: the prepared variant once a render already
    /// running for it has finished. Waiting is not starting — an encode is
    /// never begun on the way to the audience.
    pub async fn await_prepared_story_media(&self, config: &Config, item: &MediaItem) -> Option<MediaItem> {
        let source = local_path(item)?;
        if let Some(render) = self.in_flight(&story_variant_paths(config, source, story_item_is_video(item)).standard) {
            let _ = render.await;
        }
        prepared_story_media(config, item)
    }
}

/// Re-checked inside the lane: a render this one queued behind may have been
/// for the same file. A failure removes both files — a half-written pair reads
/// as prepared and ships a Telegram Story rendered for Instagram.
async fn render_variants(
    ctx: &AdapterContext,
    source: &str,
    paths: &StoryVariantPaths,
    video: bool,
    label: &Map<String, Value>,
    force: bool,
) -> Result<bool, String> {
    if !force && paths.present() {
        return Ok(false);
    }
    if !Path::new(source).exists() {
        return Err(format!("story_source_missing: {source}"));
    }
    tokio::fs::create_dir_all(story_directory(&ctx.config))
        .await
        .map_err(|error| error.to_string())?;
    let started = Instant::now();
    let timing = |success: bool, error: Option<&str>| {
        let mut details = json!({"operation": "media.story.prepare"});
        let fields = details.as_object_mut().expect("built as an object");
        fields.extend(label.clone());
        fields.insert("success".into(), success.into());
        fields.insert("totalMs".into(), (started.elapsed().as_millis() as u64).into());
        if let Some(error) = error {
            fields.insert("error".into(), error.into());
        }
        details
    };
    let rendered = render_story_variants(
        ctx,
        Path::new(source),
        &paths.standard,
        paths.telegram.as_deref(),
        video,
    )
    .await;
    match rendered {
        Ok(()) => {
            log(LogLevel::Info, "operation timing", Some(timing(true, None)));
            Ok(true)
        }
        Err(error) => {
            for file in paths.files() {
                let _ = tokio::fs::remove_file(file).await;
            }
            log(LogLevel::Warn, "operation timing", Some(timing(false, Some(&error))));
            Err(error)
        }
    }
}

impl MediaPreparation for DeliveryMedia {
    fn prepare_media_items(
        &self,
        config: Arc<Config>,
        media: Vec<MediaItem>,
        target: String,
    ) -> LocalBoxFuture<'static, adapters::Result<Vec<MediaItem>>> {
        let ctx = self.context(config);
        async move { prepare_media_items(&ctx, media, Some(&target)).await }.boxed_local()
    }

    fn await_prepared_story_media<'a>(
        &'a self,
        config: &'a Config,
        item: &'a MediaItem,
    ) -> Fut<'a, adapters::Result<Option<MediaItem>>> {
        Box::pin(
            async move { Ok::<_, AdapterError>(DeliveryMedia::await_prepared_story_media(self, config, item).await) },
        )
    }
}

/// Nobody waits for it: the draft is saved and its card drawn while the
/// encode runs. A failure leaves the asset unprepared, which the delivery
/// refuses and `story-media-backfill` repairs.
impl StoryDerivatives for DeliveryMedia {
    fn ensure(&self, local_path: &str, video: bool, draft_id: i64) {
        let media = self.clone();
        let local_path = local_path.to_owned();
        tokio::task::spawn_local(async move {
            let config = media.config.load();
            let label = match json!({"draftId": draft_id, "source": "draft"}) {
                Value::Object(label) => label,
                _ => unreachable!("built as an object"),
            };
            if let Err(error) = media
                .ensure_story_derivative(config, &local_path, video, label, false)
                .await
            {
                log(
                    LogLevel::Warn,
                    "story derivative not prepared for draft",
                    Some(json!({"draftId": draft_id, "error": error})),
                );
            }
        });
    }
}
