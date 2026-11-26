//! What each area of the bot contributes, gathered once at construction.
//!
//! The middleware chain, the routers and the menu plugin read only this. An
//! area module registers its commands, text triggers, screen routes,
//! publication actions, card renderer, message handlers and menus in one
//! `register` function (see `README.md`); nothing shared has to be edited to
//! add a screen.

use std::collections::BTreeMap;

use content::Locale;
use domain::application::conversation_flow::PublicationKind;
use domain::publishing::video_types::{VideoTarget, VideoTechnicalCheck};

use crate::Fut;
use crate::callback::{ScreenCallback, ScreenId};
use crate::context::Ctx;
use crate::effects::Effect;
use crate::menu::MenuDef;
use crate::publication::{ActionDef, CardRenderer};

/// A command, text trigger or other whole-update handler.
pub type Handler = for<'a> fn(&'a Ctx) -> Fut<'a, crate::Result<()>>;

/// A screen button's route. `Ok(false)` means the data was well-formed but
/// meaningless; the dispatcher then answers "Unknown action".
pub type ScreenRoute = for<'a> fn(&'a Ctx, &'a ScreenCallback) -> Fut<'a, crate::Result<bool>>;

/// What a message handler made of a message: whether it was its message, and
/// what to show (executed by the dispatcher, in order).
#[derive(Default)]
pub struct MessageResult {
    pub handled: bool,
    pub effects: Vec<Effect>,
}

impl MessageResult {
    pub fn handled(effects: Vec<Effect>) -> Self {
        Self { handled: true, effects }
    }

    pub fn declined() -> Self {
        Self::default()
    }
}

pub type MessageHandler = for<'a> fn(&'a Ctx) -> Fut<'a, crate::Result<MessageResult>>;

/// A video Telegram already accepted, carried by id rather than by the
/// message that brought it (`TelegramVideoFile`): the intake stores the file
/// only once the operator has said it is a video publication.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramVideoFile {
    pub file_id: String,
    pub name: String,
    pub mime: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<i64>,
}

/// A stored intake video handed to the video conversation, with where it goes.
pub struct VideoHandoff {
    pub actor_id: i64,
    pub selected: Vec<VideoTarget>,
    pub video_locale: Locale,
    pub asset_id: i64,
    pub technical: VideoTechnicalCheck,
}

/// What the video area does for the intake's video entry: store the captured
/// file as a Content asset (`storeTelegramVideo`), and open the video
/// conversation on it (`saveVideoState` + `attachVideoAsset`).
#[derive(Clone, Copy)]
pub struct VideoIntake {
    pub store: for<'a> fn(&'a Ctx, &'a TelegramVideoFile) -> Fut<'a, crate::Result<i64>>,
    pub attach: for<'a> fn(&'a Ctx, VideoHandoff) -> Fut<'a, crate::Result<Vec<Effect>>>,
}

/// The stages a message passes before the publication flows,
/// in this order.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum MessageStage {
    /// `handleSettingsMessage`: an open settings input.
    Settings,
    /// `handleIntakeMessage`: the intake's first message.
    Intake,
}

impl MessageStage {
    fn area(self) -> &'static str {
        match self {
            Self::Settings => "settings",
            Self::Intake => "intake",
        }
    }
}

fn kind_index(kind: PublicationKind) -> usize {
    match kind {
        PublicationKind::Post => 0,
        PublicationKind::Video => 1,
    }
}

fn kind_area(kind: PublicationKind) -> &'static str {
    match kind {
        PublicationKind::Post => "post",
        PublicationKind::Video => "video",
    }
}

#[derive(Default)]
pub struct Registry {
    commands: Vec<(&'static str, Handler)>,
    hears: Vec<(&'static [&'static str], Handler)>,
    screens: BTreeMap<ScreenId, ScreenRoute>,
    actions: Vec<(PublicationKind, &'static str, ActionDef)>,
    renderers: [Option<CardRenderer>; 2],
    publication_messages: [Option<MessageHandler>; 2],
    stages: BTreeMap<MessageStage, MessageHandler>,
    menus: Vec<MenuDef>,
    video_intake: Option<VideoIntake>,
}

impl Registry {
    /// `bot.command(name, handler)`.
    pub fn command(&mut self, name: &'static str, handler: Handler) {
        assert!(
            self.commands.iter().all(|(known, _)| *known != name),
            "command /{name} registered twice"
        );
        self.commands.push((name, handler));
    }

    /// `bot.hears(texts, handler)`: the whole message text equals one of them.
    pub fn hears(&mut self, texts: &'static [&'static str], handler: Handler) {
        for text in texts {
            assert!(
                self.hears_handler(text).is_none(),
                "text trigger {text:?} registered twice"
            );
        }
        self.hears.push((texts, handler));
    }

    pub fn screen(&mut self, id: ScreenId, route: ScreenRoute) {
        assert!(
            self.screens.insert(id, route).is_none(),
            "screen {} routed twice",
            id.name()
        );
    }

    /// One publication action (`p:<kind>:<name>`).
    pub fn action(&mut self, kind: PublicationKind, name: &'static str, definition: ActionDef) {
        assert!(
            self.publication_action(kind, name).is_none(),
            "action p:{}:{name} registered twice",
            kind.as_str()
        );
        self.actions.push((kind, name, definition));
    }

    /// How a publication of this kind renders as a card.
    pub fn renderer(&mut self, kind: PublicationKind, renderer: CardRenderer) {
        let slot = &mut self.renderers[kind_index(kind)];
        assert!(slot.is_none(), "{} renderer registered twice", kind.as_str());
        *slot = Some(renderer);
    }

    /// The message handler of this kind's conversation (`handlePostMessage`,
    /// `handleVideoConversationMessage`).
    pub fn publication_messages(&mut self, kind: PublicationKind, handler: MessageHandler) {
        let slot = &mut self.publication_messages[kind_index(kind)];
        assert!(slot.is_none(), "{} message handler registered twice", kind.as_str());
        *slot = Some(handler);
    }

    pub fn message_stage(&mut self, stage: MessageStage, handler: MessageHandler) {
        assert!(
            self.stages.insert(stage, handler).is_none(),
            "{stage:?} registered twice"
        );
    }

    /// A menu (`new Menu(id)` plus its `register` under `parent`).
    pub fn menu(&mut self, menu: MenuDef) {
        assert!(self.menu_def(menu.id).is_none(), "menu {} registered twice", menu.id);
        self.menus.push(menu);
    }

    /// The video area's side of the intake's video entry.
    pub fn video_intake(&mut self, intake: VideoIntake) {
        assert!(self.video_intake.is_none(), "video intake registered twice");
        self.video_intake = Some(intake);
    }

    // ---- reads ----

    pub fn command_handler(&self, name: &str) -> Option<Handler> {
        self.commands
            .iter()
            .find(|(known, _)| *known == name)
            .map(|(_, handler)| *handler)
    }

    pub fn hears_handler(&self, text: &str) -> Option<Handler> {
        self.hears
            .iter()
            .find(|(texts, _)| texts.contains(&text))
            .map(|(_, handler)| *handler)
    }

    pub fn screen_route(&self, id: ScreenId) -> Option<ScreenRoute> {
        self.screens.get(&id).copied()
    }

    pub fn publication_action(&self, kind: PublicationKind, name: &str) -> Option<&ActionDef> {
        self.actions
            .iter()
            .find(|(known_kind, known, _)| *known_kind == kind && *known == name)
            .map(|(_, _, definition)| definition)
    }

    pub fn card_renderer(&self, kind: PublicationKind) -> Option<CardRenderer> {
        self.renderers[kind_index(kind)]
    }

    pub fn publication_message_handler(&self, kind: PublicationKind) -> Option<MessageHandler> {
        self.publication_messages[kind_index(kind)]
    }

    pub fn message_stages(&self) -> impl Iterator<Item = MessageHandler> + '_ {
        self.stages.values().copied()
    }

    pub fn video_intake_handler(&self) -> Option<VideoIntake> {
        self.video_intake
    }

    pub fn menu_def(&self, id: &str) -> Option<&MenuDef> {
        self.menus.iter().find(|menu| menu.id == id)
    }

    /// What the goldens route and this registry does not, each with the
    /// area that owns it. Empty once every area is registered; the golden test
    /// checks that everything missing belongs to an area still pending.
    pub fn missing(&self) -> Vec<(&'static str, String)> {
        let mut missing = Vec::new();
        for id in ScreenId::ALL {
            if !self.screens.contains_key(id) {
                missing.push((id.area(), format!("screen {}", id.name())));
            }
        }
        for kind in [PublicationKind::Post, PublicationKind::Video] {
            if self.card_renderer(kind).is_none() {
                missing.push((kind_area(kind), format!("{} card renderer", kind.as_str())));
            }
            if self.publication_message_handler(kind).is_none() {
                missing.push((kind_area(kind), format!("{} message handler", kind.as_str())));
            }
        }
        for stage in [MessageStage::Settings, MessageStage::Intake] {
            if !self.stages.contains_key(&stage) {
                missing.push((stage.area(), format!("{stage:?} message stage")));
            }
        }
        for (texts, area) in [
            (["⚙️"].as_slice(), "settings"),
            (["📝 Текст"].as_slice(), "intake"),
            (["🎬 Видео"].as_slice(), "intake"),
        ] {
            for text in texts {
                if self.hears_handler(text).is_none() {
                    missing.push((area, format!("text trigger {text:?}")));
                }
            }
        }
        if self.video_intake.is_none() {
            missing.push(("video", "video intake handoff".to_owned()));
        }
        if self.menu_def(crate::screens::entry::SETTINGS_MENU).is_none() {
            missing.push(("settings", "menu settings-menu".to_owned()));
        }
        missing
    }
}
