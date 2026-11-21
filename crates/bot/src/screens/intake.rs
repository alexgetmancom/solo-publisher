//! The intake (`bot/intake.ts`, the `intake_*` routes of `bot/screen-routes.ts`,
//! spec §6.1): [📝 Текст] and [🎬 Видео] open it, the first message is
//! captured, and the intake asks what the material is only when the material
//! itself does not say.
//!
//! The material is captured first and asked about second, because that is the
//! order the operator has it in -- which is also why the video entry is a
//! prompt for a file and not a language: a button handler has no message to
//! fetch a file from.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;
use std::time::Duration;

use content::Locale;
use content::markdown::parse_markdown_article;
use content::message::{DraftMessage, first_non_empty_line};
use domain::application::ports::{ConversationSessionKind, JsonObject};
use domain::publishing::article_publish::PublishArticleInput;
use domain::publishing::video_types::{VIDEO_TARGETS, VideoTarget};
use domain::targets::{PublicationForm, targets_for};
use foundation::errors::StudioError;
use foundation::i18n::{Key, t};
use foundation::js;
use foundation::logger::{LogLevel, log};
use serde_json::{Map, Value, json};
use tokio::sync::Notify;

use crate::Fut;
use crate::api::ApiError;
use crate::api::payload::{InlineKeyboard, Payload};
use crate::api::types::MediaFile;
use crate::callback::{ScreenCallback, ScreenId, screen, screen_callback, screen_number};
use crate::context::Ctx;
use crate::dialog_ui::{cancel_prompt_keyboard, result_navigation_keyboard};
use crate::effects::{Effect, execute, show_screen};
use crate::error_text::describe_error;
use crate::media_ingress::import_telegram_media;
use crate::message::extract_message;
use crate::publication::run_callback_action;
use crate::registry::{MessageResult, MessageStage, Registry, TelegramVideoFile, VideoHandoff};
use crate::screens::entry::main_menu_text;
use crate::screens::post::create_post_from_message;
use crate::session::{ConversationState, ConversationStateInput};

const MARKDOWN_EXTENSIONS: [&str; 3] = [".md", ".markdown", ".mdx"];
const VIDEO_DOWNLOAD_RETRY_DELAYS: [Duration; 2] = [Duration::from_secs(2), Duration::from_secs(5)];

/// Text this short is a post here. Not a theory about writing -- the
/// operator's own posts run under this, and their articles run well over it.
/// Above it the two are equally likely, so the question is asked instead of
/// guessed.
const POST_WITHOUT_ASKING: usize = 900;

/// An article a person wrote and a file that would take the process down with
/// it are told apart by size, and a file server that stops answering is told
/// apart from a slow one by the clock.
const MARKDOWN_DOWNLOAD_LIMIT: u64 = 1_000_000;
const MARKDOWN_DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(10);

pub fn register(registry: &mut Registry) {
    registry.hears(&["📝 Text", "📝 Текст"], |ctx| {
        Box::pin(open_intake(ctx, Entry::Text))
    });
    registry.hears(&["🎬 Video", "🎬 Видео"], |ctx| {
        Box::pin(open_intake(ctx, Entry::Video))
    });
    registry.message_stage(MessageStage::Intake, handle_intake_message);
    registry.screen(ScreenId::IntakeKind, intake_kind);
    registry.screen(ScreenId::IntakeLocale, intake_locale);
    registry.screen(ScreenId::IntakeDownload, intake_download);
    registry.screen(ScreenId::IntakeTarget, intake_target);
    registry.screen(ScreenId::IntakeCancel, intake_cancel);
}

/// What captured material can become. A kind is offered only when the
/// material can actually become it, never withheld because it merely looks
/// unlikely.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MaterialKind {
    Post,
    Article,
    Video,
}

impl MaterialKind {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "post" => Some(Self::Post),
            "article" => Some(Self::Article),
            "video" => Some(Self::Video),
            _ => None,
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Post => "post",
            Self::Article => "article",
            Self::Video => "video",
        }
    }

    fn label(self) -> Key {
        match self {
            Self::Post => Key::IntakeKindPost,
            Self::Article => Key::IntakeKindArticle,
            Self::Video => Key::IntakeKindVideo,
        }
    }
}

/// The ways into the intake, and what each one accepts. A text publication
/// and a video publication are different entities with different flows, so
/// they are different buttons; the intake still decides post-or-article,
/// because that one is a genuine reading of the same text.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Entry {
    Text,
    Video,
}

impl Entry {
    fn name(self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Video => "video",
        }
    }

    fn accepts(self, kind: MaterialKind) -> bool {
        match self {
            Self::Text => matches!(kind, MaterialKind::Post | MaterialKind::Article),
            Self::Video => kind == MaterialKind::Video,
        }
    }

    fn prompt(self) -> Key {
        match self {
            Self::Text => Key::IntakePromptText,
            Self::Video => Key::IntakePromptVideo,
        }
    }

    fn rejected(self) -> Key {
        match self {
            Self::Text => Key::IntakeNeedText,
            Self::Video => Key::IntakeNeedVideo,
        }
    }

    /// Which button opened this intake. A session that predates the split is
    /// a text one: that is what the single entry point mostly took.
    fn of(data: &JsonObject) -> Self {
        if data.get("entry").and_then(Value::as_str) == Some("video") {
            Self::Video
        } else {
            Self::Text
        }
    }
}

/// The material as the intake holds it between the first message and the choice.
struct Captured {
    message: DraftMessage,
    markdown: Option<String>,
    video: Option<TelegramVideoFile>,
    entry: Entry,
}

impl Captured {
    /// The session data (`captured as Record<string, unknown>`).
    fn to_json(&self) -> JsonObject {
        let objects = |items: &[Map<String, Value>]| Value::Array(items.iter().cloned().map(Value::Object).collect());
        let mut data = Map::new();
        data.insert(
            "message".into(),
            json!({
                "text": self.message.text,
                "media": objects(&self.message.media),
                "entities": objects(&self.message.entities),
            }),
        );
        data.insert(
            "markdown".into(),
            self.markdown.clone().map_or(Value::Null, Value::String),
        );
        data.insert(
            "video".into(),
            self.video
                .as_ref()
                .map_or(Ok(Value::Null), serde_json::to_value)
                .unwrap_or(Value::Null),
        );
        data.insert("entry".into(), self.entry.name().into());
        data
    }

    /// `capturedFrom`: what the open intake holds, or `intake.expired`.
    fn from_state(state: Option<&ConversationState>) -> crate::Result<Self> {
        let data = state.map(|state| &state.data);
        let Some(Value::Object(message)) = data.and_then(|data| data.get("message")) else {
            return Err(StudioError::new("intake.expired").into());
        };
        let data = data.expect("a message comes from a session");
        let records = |key: &str| -> Vec<Map<String, Value>> {
            message
                .get(key)
                .and_then(Value::as_array)
                .map(|items| items.iter().filter_map(|item| item.as_object().cloned()).collect())
                .unwrap_or_default()
        };
        Ok(Self {
            message: DraftMessage {
                text: message
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                media: records("media"),
                entities: records("entities"),
                ..DraftMessage::default()
            },
            markdown: data.get("markdown").and_then(Value::as_str).map(str::to_owned),
            video: data
                .get("video")
                .filter(|video| !video.is_null())
                .and_then(|video| serde_json::from_value(video.clone()).ok()),
            entry: Entry::of(data),
        })
    }

    /// What this material could become here: the kinds it physically can be,
    /// narrowed to the ones the entry the operator chose takes.
    fn offered_kinds(&self) -> Vec<MaterialKind> {
        let possible = if self.video.is_some() {
            [MaterialKind::Video, MaterialKind::Post]
        } else {
            [MaterialKind::Post, MaterialKind::Article]
        };
        possible.into_iter().filter(|kind| self.entry.accepts(*kind)).collect()
    }

    /// The kind the material plainly is, or none when both readings are live.
    /// Every rule here reads something the material carries, never how it reads.
    fn decided_kind(&self) -> Option<MaterialKind> {
        let offered = self.offered_kinds();
        if offered.len() == 1 {
            return offered.first().copied();
        }
        if self.markdown.is_some() {
            return Some(MaterialKind::Article);
        }
        (utf16_len(&self.message.text) <= POST_WITHOUT_ASKING).then_some(MaterialKind::Post)
    }

    fn article_markdown(&self) -> String {
        let source = self.markdown.as_deref().unwrap_or(&self.message.text);
        if has_title_line(source) {
            return source.to_owned();
        }
        let first = first_non_empty_line(Some(source), "Untitled");
        let rest = match source.find(first) {
            Some(index) => &source[index + first.len()..],
            // `indexOf` missed: `slice(-1 + first.length)`.
            None => utf16_slice_from(source, utf16_len(first) - 1),
        };
        format!("# {first}\n\n{}", js::trim_start(rest))
    }
}

fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `text.slice(units)` for a start in UTF-16 code units.
fn utf16_slice_from(text: &str, units: usize) -> &str {
    let mut seen = 0;
    for (index, character) in text.char_indices() {
        if seen >= units {
            return &text[index..];
        }
        seen += character.len_utf16();
    }
    ""
}

/// `/^#\s+\S/m`: a line that starts with `#`, whitespace, then something.
fn has_title_line(source: &str) -> bool {
    let starts = std::iter::once(0).chain(
        source
            .char_indices()
            .filter(|(_, character)| matches!(character, '\n' | '\r' | '\u{2028}' | '\u{2029}'))
            .map(|(index, character)| index + character.len_utf8()),
    );
    starts.into_iter().any(|start| {
        let Some(rest) = source[start..].strip_prefix('#') else {
            return false;
        };
        let after = rest.trim_start_matches(js::is_whitespace);
        after.len() < rest.len() && !after.is_empty()
    })
}

// ---- video downloads ----

/// A running intake download's cancellation: the flag the task checks between
/// steps, and the bell that cuts its waits short.
#[derive(Default)]
struct Abort {
    aborted: Cell<bool>,
    bell: Notify,
}

impl Abort {
    fn abort(&self) {
        self.aborted.set(true);
        self.bell.notify_waiters();
    }

    fn aborted(&self) -> bool {
        self.aborted.get()
    }

    /// Waits, unless the download is aborted first.
    async fn sleep(&self, duration: Duration) -> Result<(), ()> {
        let rung = self.bell.notified();
        if self.aborted() {
            return Err(());
        }
        tokio::select! {
            () = tokio::time::sleep(duration) => Ok(()),
            () = rung => Err(()),
        }
    }
}

struct Download {
    revision: i64,
    abort: Rc<Abort>,
}

thread_local! {
    /// One running intake video download per actor (`videoDownloads`).
    static DOWNLOADS: RefCell<HashMap<i64, Download>> = RefCell::new(HashMap::new());
}

fn abort_download(actor_id: i64) {
    DOWNLOADS.with(|downloads| {
        if let Some(download) = downloads.borrow().get(&actor_id) {
            download.abort.abort();
        }
    });
}

fn release_download(actor_id: i64, abort: &Rc<Abort>) {
    DOWNLOADS.with(|downloads| {
        let mut downloads = downloads.borrow_mut();
        if downloads
            .get(&actor_id)
            .is_some_and(|download| Rc::ptr_eq(&download.abort, abort))
        {
            downloads.remove(&actor_id);
        }
    });
}

// ---- the session ----

fn intake_state(ctx: &Ctx, actor_id: i64) -> crate::Result<Option<ConversationState>> {
    Ok(ctx.sessions().get(actor_id, ConversationSessionKind::Intake)?)
}

fn save_intake(ctx: &Ctx, actor_id: i64, step: &str, data: JsonObject) -> crate::Result<ConversationState> {
    Ok(ctx.sessions().save(
        actor_id,
        &ConversationStateInput {
            kind: ConversationSessionKind::Intake,
            draft_id: None,
            step: step.to_owned(),
            data,
            control_message_id: None,
            revision: None,
        },
    )?)
}

fn clear_intake(ctx: &Ctx, actor_id: i64) -> crate::Result<()> {
    Ok(ctx.sessions().clear(actor_id, ConversationSessionKind::Intake)?)
}

fn expired() -> crate::Error {
    StudioError::new("intake.expired").into()
}

// ---- opening and the first message ----

/// `openIntake`.
async fn open_intake(ctx: &Ctx, entry: Entry) -> crate::Result<()> {
    let actor_id = ctx.actor_id();
    abort_download(actor_id);
    let mut data = Map::new();
    data.insert("entry".into(), entry.name().into());
    save_intake(ctx, actor_id, "awaiting", data)?;
    execute(
        ctx,
        vec![Effect::screen(
            t(entry.prompt(), &[]),
            Payload::new().reply_markup(cancel_prompt_keyboard(&screen(ScreenId::IntakeCancel), None)),
        )],
    )
    .await
}

/// `handleIntakeMessage`: captures the first message of an open intake and
/// offers the kinds it could be; anything it declines falls through unchanged.
fn handle_intake_message(ctx: &Ctx) -> Fut<'_, crate::Result<MessageResult>> {
    Box::pin(async move {
        let actor_id = ctx.actor_id();
        let Some(state) = intake_state(ctx, actor_id)?.filter(|state| state.step == "awaiting") else {
            return Ok(MessageResult::declined());
        };
        let incoming = ctx.update.message.as_ref();
        // An album arrives as several messages and can only be a post, so
        // there is nothing to ask: the intake steps aside and the album
        // collector assembles every part of it into one draft.
        if incoming
            .and_then(|message| message.media_group_id.as_deref())
            .is_some_and(|group| !group.is_empty())
        {
            clear_intake(ctx, actor_id)?;
            return Ok(MessageResult::declined());
        }
        let entry = Entry::of(&state.data);
        let message = extract_message(ctx);
        let document = incoming.and_then(|message| message.document.as_ref());
        let markdown = match document.filter(|document| is_markdown(document)) {
            Some(document) => Some(download_document(ctx, document).await?),
            None => None,
        };
        let video = captured_video(ctx, &message);
        // A voice note, a sticker, a PDF: the bot has no publication that
        // carries it, and capturing it anyway made an empty draft. The intake
        // stays open, so the next message is still the first one.
        if markdown.is_none() && js::trim(&message.text).is_empty() && message.media.is_empty() {
            return Ok(MessageResult::handled(vec![Effect::screen(
                t(Key::IntakeUnsupported, &[]),
                Payload::new(),
            )]));
        }
        let message = match &markdown {
            Some(markdown) => DraftMessage {
                text: markdown.clone(),
                ..message
            },
            None => message,
        };
        let captured = Captured {
            message,
            markdown,
            video,
            entry,
        };
        // Material this entry does not take. The intake stays open rather
        // than guessing: a video sent to the text button is a video.
        if captured.offered_kinds().is_empty() {
            return Ok(MessageResult::handled(vec![Effect::screen(
                t(entry.rejected(), &[]),
                Payload::new(),
            )]));
        }
        save_intake(ctx, actor_id, "choose", captured.to_json())?;
        if let Some(kind) = captured.decided_kind() {
            return Ok(MessageResult::handled(apply_intake_kind(ctx, kind).await?));
        }
        Ok(MessageResult::handled(vec![choose_kind_screen(&captured)?]))
    })
}

fn choose_kind_screen(captured: &Captured) -> crate::Result<Effect> {
    let mut keyboard = InlineKeyboard::new();
    for kind in captured.offered_kinds() {
        keyboard = keyboard.text(
            t(kind.label(), &[]),
            screen_callback(ScreenId::IntakeKind, &[&kind.name()])?,
        );
    }
    let keyboard = keyboard
        .row()
        .text(t(Key::CommonCancel, &[]), screen(ScreenId::IntakeCancel));
    Ok(Effect::screen(
        t(
            Key::IntakeChooseKind,
            &[
                ("characters", &utf16_len(&captured.message.text)),
                ("media", &captured.message.media.len()),
            ],
        ),
        Payload::new().reply_markup(keyboard),
    ))
}

fn is_markdown(document: &MediaFile) -> bool {
    let name = document.file_name.as_deref().unwrap_or_default().to_lowercase();
    document
        .mime_type
        .as_deref()
        .unwrap_or_default()
        .starts_with("text/markdown")
        || MARKDOWN_EXTENSIONS.iter().any(|extension| name.ends_with(extension))
}

/// The captured video file, when the message carries one.
fn captured_video(ctx: &Ctx, message: &DraftMessage) -> Option<TelegramVideoFile> {
    if !message
        .media
        .iter()
        .any(|item| item.get("type").and_then(Value::as_str) == Some("video"))
    {
        return None;
    }
    let incoming = ctx.update.message.as_ref()?;
    let file = incoming.video.as_ref().or(incoming.document.as_ref())?;
    Some(TelegramVideoFile {
        file_id: file.file_id.clone(),
        name: file.file_name.clone().unwrap_or_default(),
        mime: file.mime_type.clone().unwrap_or_default(),
        size_bytes: file.file_size,
    })
}

/// `downloadDocument`: the Markdown file, through the Bot API file endpoint.
async fn download_document(ctx: &Ctx, document: &MediaFile) -> crate::Result<String> {
    if ctx.config.controller_bot_token.as_deref().is_none_or(str::is_empty) {
        return Err(crate::error("Telegram bot token is not configured."));
    }
    let too_large = || -> crate::Error { StudioError::new("intake.file-too-large").into() };
    if document.file_size.unwrap_or_default() > MARKDOWN_DOWNLOAD_LIMIT as i64 {
        return Err(too_large());
    }
    let file = ctx.bot.api().get_file(&document.file_id).await?;
    let file_path = file
        .file_path
        .ok_or_else(|| crate::error("Telegram did not return a file path."))?;
    // Up to four bytes a character: a body past that is past the limit in
    // characters too, so the rest of it is never read.
    let read_limit = MARKDOWN_DOWNLOAD_LIMIT * 4;
    let response = ctx
        .bot
        .api()
        .download_file(&file_path, read_limit, MARKDOWN_DOWNLOAD_TIMEOUT)
        .await
        .map_err(|error| crate::error(error.0))?;
    if !(200..300).contains(&response.status) {
        return Err(crate::error(format!(
            "Telegram file download failed: {}",
            response.status
        )));
    }
    // Telegram may report no size at all, so the body is measured as well.
    if response.content_length.unwrap_or_default() > MARKDOWN_DOWNLOAD_LIMIT || response.body.len() as u64 > read_limit
    {
        return Err(too_large());
    }
    let text = String::from_utf8_lossy(&response.body).into_owned();
    if utf16_len(&text) as u64 > MARKDOWN_DOWNLOAD_LIMIT {
        return Err(too_large());
    }
    Ok(text)
}

// ---- the kind ----

/// `applyIntakeKind`: acts on the kind the operator chose, or the material
/// chose for them.
async fn apply_intake_kind(ctx: &Ctx, kind: MaterialKind) -> crate::Result<Vec<Effect>> {
    let actor_id = ctx.actor_id();
    let captured = Captured::from_state(intake_state(ctx, actor_id)?.as_ref())?;
    // Only a kind picked from the screen that offered it has a reading to undo.
    let asked = ctx.update.callback_query.is_some();
    match kind {
        MaterialKind::Post => {
            let services = ctx.services();
            let media = import_telegram_media(
                ctx.bot.api(),
                services.media,
                &ctx.config,
                actor_id,
                &captured.message.media,
            )
            .await?;
            let message = DraftMessage {
                media,
                ..captured.message
            };
            clear_intake(ctx, actor_id)?;
            create_post_from_message(ctx, actor_id, &message)
        }
        MaterialKind::Article => {
            let parsed = parse_markdown_article(&captured.article_markdown());
            save_intake(ctx, actor_id, "article_review", captured.to_json())?;
            let mut keyboard = InlineKeyboard::new()
                .text(
                    t(Key::IntakeArticlePublish, &[]),
                    screen_callback(ScreenId::IntakeKind, &[&"article_confirm"])?,
                )
                .row();
            if !asked {
                keyboard = keyboard
                    .text(
                        t(Key::IntakeRatherPost, &[]),
                        screen_callback(ScreenId::IntakeKind, &[&"post"])?,
                    )
                    .row();
            }
            let keyboard = keyboard.text(t(Key::CommonCancel, &[]), screen(ScreenId::IntakeCancel));
            Ok(vec![Effect::screen(
                t(
                    Key::IntakeArticleReview,
                    &[("title", &parsed.title), ("characters", &utf16_len(&parsed.body.text))],
                ),
                Payload::new().reply_markup(keyboard),
            )])
        }
        MaterialKind::Video => {
            if captured.video.is_none() {
                return Err(expired());
            }
            let targets = connected_video_targets(ctx)?;
            let mut data = captured.to_json();
            data.insert("targets".into(), target_names(&targets));
            save_intake(ctx, actor_id, "video_locale", data)?;
            Ok(vec![video_destination_screen(ctx, &targets)?])
        }
    }
}

/// `publishReviewedArticle`: the reviewed article to every connected target
/// that carries one, in the first carrier's language.
fn publish_reviewed_article(ctx: &Ctx, actor_id: i64) -> crate::Result<String> {
    let state = intake_state(ctx, actor_id)?;
    if state.as_ref().map(|state| state.step.as_str()) != Some("article_review") {
        return Err(expired());
    }
    let captured = Captured::from_state(state.as_ref())?;
    // Which targets carry an article, and in which language, is the
    // catalogue's answer; naming one here is how the bot and the publisher
    // drift apart.
    let carriers: Vec<_> = targets_for(PublicationForm::Article).collect();
    let first = carriers
        .first()
        .ok_or_else(|| StudioError::new("intake.no-article-target"))?;
    let targets: Vec<&str> = carriers
        .iter()
        .filter(|carrier| carrier.locale == first.locale)
        .map(|carrier| carrier.id)
        .collect();
    let markdown = captured.article_markdown();
    let published = ctx.services().posts.publish_article(
        actor_id,
        &PublishArticleInput {
            locale: first.locale,
            targets: &targets,
            markdown: &markdown,
        },
    )?;
    clear_intake(ctx, actor_id)?;
    Ok(published.title)
}

// ---- the video destination ----

/// `connectedVideoTargets`: the video platforms this Studio has a connected
/// account for, in the catalogue's order.
pub fn connected_video_targets(ctx: &Ctx) -> crate::Result<Vec<VideoTarget>> {
    let channels = domain::channels::list_channels(ctx.db(), true)?;
    Ok(VIDEO_TARGETS
        .into_iter()
        .filter(|target| {
            channels
                .iter()
                .any(|channel| channel.connection.platform == target.platform())
        })
        .collect())
}

fn target_names(targets: &[VideoTarget]) -> Value {
    Value::Array(targets.iter().map(|target| target.as_str().into()).collect())
}

/// The platforms the destination screen currently has selected.
fn intake_video_targets(ctx: &Ctx, state: &ConversationState) -> crate::Result<Vec<VideoTarget>> {
    let connected = connected_video_targets(ctx)?;
    let Some(Value::Array(stored)) = state.data.get("targets") else {
        return Ok(connected);
    };
    let selected: Vec<VideoTarget> = connected
        .iter()
        .copied()
        .filter(|target| stored.iter().any(|item| item.as_str() == Some(target.as_str())))
        .collect();
    Ok(if selected.is_empty() { connected } else { selected })
}

/// Where this video goes: the platforms it is sent to and the audience it is
/// for, on one screen. Nothing is asked when one platform is connected.
fn video_destination_screen(ctx: &Ctx, selected: &[VideoTarget]) -> crate::Result<Effect> {
    let connected = connected_video_targets(ctx)?;
    let mut keyboard = InlineKeyboard::new();
    if connected.len() > 1 {
        for target in &connected {
            let mark = if selected.contains(target) { "✅" } else { "⬜" };
            keyboard = keyboard.text(
                format!("{mark} {}", target.label()),
                screen_callback(ScreenId::IntakeTarget, &[&target.as_str()])?,
            );
        }
        keyboard = keyboard.row();
    }
    let keyboard = keyboard
        .text(
            t(Key::VideoLanguageRu, &[]),
            screen_callback(ScreenId::IntakeLocale, &[&"ru"])?,
        )
        .text(
            t(Key::VideoLanguageEn, &[]),
            screen_callback(ScreenId::IntakeLocale, &[&"en"])?,
        )
        .row()
        .text(t(Key::CommonCancel, &[]), screen(ScreenId::IntakeCancel));
    Ok(Effect::screen(
        t(Key::VideoChooseLanguage, &[]),
        Payload::new().reply_markup(keyboard),
    ))
}

/// `toggleIntakeVideoTarget`: one platform on or off; the last selected one
/// cannot be turned off, because a publication with no platform can never be
/// published.
fn toggle_intake_video_target(ctx: &Ctx, actor_id: i64, target: VideoTarget) -> crate::Result<Vec<Effect>> {
    let Some(state) = intake_state(ctx, actor_id)?.filter(|state| state.step == "video_locale") else {
        return Err(expired());
    };
    let current = intake_video_targets(ctx, &state)?;
    let next: Vec<VideoTarget> = if current.contains(&target) {
        current.iter().copied().filter(|item| *item != target).collect()
    } else {
        connected_video_targets(ctx)?
            .into_iter()
            .filter(|item| current.contains(item) || *item == target)
            .collect()
    };
    if next.is_empty() {
        return Ok(vec![Effect::answer(t(Key::VideoNeedOnePlatform, &[]))]);
    }
    let mut data = state.data.clone();
    data.insert("targets".into(), target_names(&next));
    save_intake(ctx, actor_id, "video_locale", data)?;
    Ok(vec![video_destination_screen(ctx, &next)?])
}

/// `applyIntakeVideoLocale`: shows the download and runs it in the
/// background. The audience choice stays in the session, so the download can
/// be retried from the same card, including after a restart.
async fn apply_intake_video_locale(ctx: &Ctx, actor_id: i64, video_locale: Locale) -> crate::Result<Vec<Effect>> {
    let Some(state) = intake_state(ctx, actor_id)?.filter(|state| state.step == "video_locale") else {
        return Err(expired());
    };
    let video = Captured::from_state(Some(&state))?.video.ok_or_else(expired)?;
    let selected = intake_video_targets(ctx, &state)?;
    if selected.is_empty() {
        return Err(StudioError::new("err.no-video-platforms-connected").into());
    }
    let pending = DOWNLOADS.with(|downloads| {
        downloads
            .borrow()
            .get(&actor_id)
            .map(|download| (download.revision, Rc::clone(&download.abort)))
    });
    if let Some((revision, abort)) = &pending {
        if *revision == state.revision && !abort.aborted() {
            return Ok(Vec::new());
        }
        abort.abort();
    }
    let options = Payload::new().reply_markup(
        InlineKeyboard::new()
            .text(
                t(Key::IntakeRetryVideoDownload, &[]),
                screen_callback(ScreenId::IntakeDownload, &[&state.revision, &video_locale.as_str()])?,
            )
            .text(
                t(Key::CommonCancel, &[]),
                screen_callback(ScreenId::IntakeDownload, &[&state.revision, &"cancel"])?,
            ),
    );
    let abort = Rc::new(Abort::default());
    DOWNLOADS.with(|downloads| {
        downloads.borrow_mut().insert(
            actor_id,
            Download {
                revision: state.revision,
                abort: Rc::clone(&abort),
            },
        );
    });
    if let Err(error) = show_screen(ctx, &t(Key::IntakeDownloadingVideo, &[]), options.clone()).await {
        release_download(actor_id, &abort);
        return Err(error);
    }
    let background = Ctx::new(ctx.bot.clone(), ctx.update.clone());
    let request = VideoRequest {
        actor_id,
        state,
        video,
        selected,
        video_locale,
        options,
    };
    ctx.bot.spawn(async move {
        if let Err(error) = run_video_download(&background, &request, &abort).await {
            log(
                LogLevel::Error,
                "Telegram video intake could not report its outcome",
                Some(json!({"updateId": background.update.update_id, "error": error.to_string()})),
            );
        }
        release_download(request.actor_id, &abort);
    });
    Ok(Vec::new())
}

struct VideoRequest {
    actor_id: i64,
    state: ConversationState,
    video: TelegramVideoFile,
    selected: Vec<VideoTarget>,
    video_locale: Locale,
    options: Payload,
}

fn is_current(ctx: &Ctx, request: &VideoRequest, abort: &Abort) -> bool {
    !abort.aborted()
        && intake_state(ctx, request.actor_id)
            .ok()
            .flatten()
            .is_some_and(|state| state.revision == request.state.revision)
}

/// The download's background half: store, check, hand off to the video
/// conversation, and say how it went. A replaced or cancelled download ends
/// silently.
async fn run_video_download(ctx: &Ctx, request: &VideoRequest, abort: &Abort) -> crate::Result<()> {
    let mut handed_off = false;
    let outcome: crate::Result<Option<Vec<Effect>>> = async {
        let intake = ctx
            .bot
            .registry()
            .video_intake_handler()
            .ok_or_else(|| crate::error("the video intake handoff is not registered"))?;
        let asset_id = download_intake_video(ctx, request, abort, intake.store).await?;
        if !is_current(ctx, request, abort) {
            return Ok(None);
        }
        let technical = ctx
            .services()
            .videos
            .asset_technical_check(request.actor_id, asset_id)
            .await?;
        if !is_current(ctx, request, abort)
            || !ctx.sessions().clear_if_current(
                request.actor_id,
                ConversationSessionKind::Intake,
                &request.state.step,
                request.state.draft_id,
                Some(request.state.revision),
            )?
        {
            return Ok(None);
        }
        handed_off = true;
        let effects = (intake.attach)(
            ctx,
            VideoHandoff {
                actor_id: request.actor_id,
                selected: request.selected.clone(),
                video_locale: request.video_locale,
                asset_id,
                technical,
            },
        )
        .await?;
        Ok(Some(effects))
    }
    .await;
    let mut effects = match outcome {
        Ok(Some(effects)) => effects,
        Ok(None) => return Ok(()),
        Err(error) => {
            if abort.aborted() || (!handed_off && !is_current(ctx, request, abort)) {
                return Ok(());
            }
            log(
                LogLevel::Warn,
                "Telegram video intake failed",
                Some(json!({"updateId": ctx.update.update_id, "error": crate::effects::error_js_string(&*error)})),
            );
            let message = describe_error(&*error);
            if handed_off {
                show_screen(ctx, &message, Payload::new().reply_markup(InlineKeyboard::new())).await?;
            } else {
                show_screen(
                    ctx,
                    &t(Key::IntakeVideoDownloadFailed, &[("error", &message)]),
                    request.options.clone(),
                )
                .await?;
            }
            return Ok(());
        }
    };
    if !matches!(effects.first(), Some(Effect::Screen { .. })) {
        effects.insert(
            0,
            Effect::screen(
                t(Key::IntakeVideoDownloaded, &[]),
                Payload::new().reply_markup(InlineKeyboard::new()),
            ),
        );
    }
    execute(ctx, effects).await
}

/// Stores the captured video, retrying a file Telegram has not made
/// available yet and a request that got no answer.
async fn download_intake_video(
    ctx: &Ctx,
    request: &VideoRequest,
    abort: &Abort,
    store: for<'a> fn(&'a Ctx, &'a TelegramVideoFile) -> Fut<'a, crate::Result<i64>>,
) -> crate::Result<i64> {
    for attempt in 0.. {
        if !is_current(ctx, request, abort) {
            return Err(crate::error("Video intake was replaced."));
        }
        let error = match store(ctx, &request.video).await {
            Ok(asset_id) => return Ok(asset_id),
            Err(error) => error,
        };
        let retryable = match error.downcast_ref::<ApiError>() {
            Some(ApiError::Telegram(failure)) => {
                failure.method == "getFile"
                    && failure.error_code == 400
                    && failure
                        .description
                        .contains("wrong file_id or the file is temporarily unavailable")
            }
            Some(ApiError::Network { .. }) => true,
            _ => false,
        };
        let Some(delay) = VIDEO_DOWNLOAD_RETRY_DELAYS.get(attempt).copied() else {
            return Err(error);
        };
        if !is_current(ctx, request, abort) || !retryable {
            return Err(error);
        }
        log(
            LogLevel::Info,
            "Retrying Telegram video download",
            Some(
                json!({"updateId": ctx.update.update_id, "attempt": attempt + 2, "delayMs": delay.as_millis() as u64}),
            ),
        );
        if abort.sleep(delay).await.is_err() {
            return Err(crate::error("Video intake was aborted."));
        }
    }
    unreachable!("the retry loop returns")
}

fn cancel_intake(ctx: &Ctx, actor_id: i64) -> crate::Result<Vec<Effect>> {
    abort_download(actor_id);
    clear_intake(ctx, actor_id)?;
    Ok(vec![Effect::MainMenu {
        text: main_menu_text(ctx, actor_id)?,
    }])
}

// ---- the routes ----

/// `intakeAction`: the intake's controls run the way every publication
/// control does -- one acknowledgement, one tap at a time, a failure the
/// operator can read. The whole intake shares one lock key, because two of
/// its buttons pressed together would otherwise both store a video and open
/// two drafts.
async fn intake_action<'a>(ctx: &'a Ctx, produce: Fut<'a, crate::Result<Vec<Effect>>>) -> crate::Result<bool> {
    let lock_key = format!("{}:intake", ctx.actor_id());
    let describe = |error: &(dyn std::error::Error + 'static)| describe_error(error);
    run_callback_action(ctx, &lock_key, &describe, None, produce).await?;
    Ok(true)
}

fn intake_kind<'a>(ctx: &'a Ctx, callback: &'a ScreenCallback) -> Fut<'a, crate::Result<bool>> {
    Box::pin(intake_action(
        ctx,
        Box::pin(async move {
            let choice = callback.arg("choice");
            if choice == "article_confirm" {
                let title = publish_reviewed_article(ctx, ctx.actor_id())?;
                return Ok(vec![Effect::screen(
                    t(Key::IntakeArticlePublished, &[("title", &title)]),
                    Payload::new().reply_markup(result_navigation_keyboard()),
                )]);
            }
            match MaterialKind::parse(choice) {
                Some(kind) => apply_intake_kind(ctx, kind).await,
                None => Ok(Vec::new()),
            }
        }),
    ))
}

fn locale_choice(value: &str) -> Option<Locale> {
    match value {
        "ru" => Some(Locale::Ru),
        "en" => Some(Locale::En),
        _ => None,
    }
}

fn intake_locale<'a>(ctx: &'a Ctx, callback: &'a ScreenCallback) -> Fut<'a, crate::Result<bool>> {
    Box::pin(intake_action(
        ctx,
        Box::pin(async move {
            match locale_choice(callback.arg("locale")) {
                Some(locale) => apply_intake_video_locale(ctx, ctx.actor_id(), locale).await,
                None => Ok(Vec::new()),
            }
        }),
    ))
}

fn intake_download<'a>(ctx: &'a Ctx, callback: &'a ScreenCallback) -> Fut<'a, crate::Result<bool>> {
    Box::pin(intake_action(
        ctx,
        Box::pin(async move {
            let actor_id = ctx.actor_id();
            let revision = screen_number(callback.arg("revision"), 1);
            let current = intake_state(ctx, actor_id)?.map(|state| state.revision);
            if revision.is_none() || current != revision {
                return Err(expired());
            }
            let choice = callback.arg("choice");
            if choice == "cancel" {
                return cancel_intake(ctx, actor_id);
            }
            match locale_choice(choice) {
                Some(locale) => apply_intake_video_locale(ctx, actor_id, locale).await,
                None => Ok(Vec::new()),
            }
        }),
    ))
}

fn intake_target<'a>(ctx: &'a Ctx, callback: &'a ScreenCallback) -> Fut<'a, crate::Result<bool>> {
    Box::pin(intake_action(
        ctx,
        Box::pin(async move {
            match VideoTarget::parse(callback.arg("target")) {
                Some(target) => toggle_intake_video_target(ctx, ctx.actor_id(), target),
                None => Ok(Vec::new()),
            }
        }),
    ))
}

fn intake_cancel<'a>(ctx: &'a Ctx, _: &'a ScreenCallback) -> Fut<'a, crate::Result<bool>> {
    Box::pin(intake_action(
        ctx,
        Box::pin(async move { cancel_intake(ctx, ctx.actor_id()) }),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn captured(text: &str, markdown: Option<&str>) -> Captured {
        Captured {
            message: DraftMessage {
                text: text.to_owned(),
                ..DraftMessage::default()
            },
            markdown: markdown.map(str::to_owned),
            video: None,
            entry: Entry::Text,
        }
    }

    #[test]
    fn short_text_is_a_post_long_text_is_asked_and_a_file_is_an_article() {
        assert_eq!(
            captured(&"я".repeat(900), None).decided_kind(),
            Some(MaterialKind::Post)
        );
        assert_eq!(captured(&"я".repeat(901), None).decided_kind(), None);
        assert_eq!(captured("x", Some("x")).decided_kind(), Some(MaterialKind::Article));
    }

    #[test]
    fn an_article_without_a_heading_takes_its_first_line() {
        assert_eq!(
            captured("\n  Заголовок \nтело", None).article_markdown(),
            "# Заголовок\n\nтело"
        );
        assert_eq!(captured("# Есть\nтело", None).article_markdown(), "# Есть\nтело");
        assert_eq!(
            captured("текст\n#\n\nниже", None).article_markdown(),
            "текст\n#\n\nниже"
        );
        assert_eq!(captured("#заголовок", None).article_markdown(), "# #заголовок\n\n");
        assert_eq!(captured("   ", Some("   ")).article_markdown(), "# Untitled\n\n");
    }
}
