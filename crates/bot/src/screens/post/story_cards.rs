//! The Story-card choice (`bot/post-story-cards.ts`, spec §6.3.2): whether the
//! generated text card also goes to Stories, asked once the cards exist.

use std::cell::{Cell, RefCell};
use std::collections::BTreeSet;
use std::path::PathBuf;
use std::rc::Rc;
use std::time::Duration;

use domain::application::conversation_flow::PublicationKind;
use domain::publishing::boundaries::StoryCardState;
use domain::targets::story_card_use;
use foundation::i18n::{Key, t};
use foundation::logger::{LogLevel, log};
use serde_json::json;
use tokio::sync::Notify;

use crate::api::payload::{InlineKeyboard, Payload};
use crate::callback::publication_callback;
use crate::cards::is_superseded_card;
use crate::context::Ctx;
use crate::effects::{CardRef, Effect, execute};

/// How long the Story renderer is given, in polls, before the operator is
/// told it did not finish. Rendering both cards is seconds of work; a minute
/// means it is stuck.
const STORY_CARD_WAIT_POLLS: u32 = 60;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Intent {
    Publish,
    Schedule,
}

impl Intent {
    fn as_str(self) -> &'static str {
        match self {
            Self::Publish => "publish",
            Self::Schedule => "schedule",
        }
    }
}

/// The waiters running on this thread (the bot's one thread), keyed as
/// `pendingStoryCardChoices` is, and how long each of their polls waits.
struct Waiters {
    keys: RefCell<BTreeSet<String>>,
    idle: Rc<Notify>,
    poll: Cell<Duration>,
}

thread_local! {
    static WAITERS: Waiters = Waiters {
        keys: RefCell::new(BTreeSet::new()),
        idle: Rc::new(Notify::new()),
        poll: Cell::new(Duration::from_secs(1)),
    };
}

/// How long one poll of a waiter waits (one second; a replay shortens it).
pub fn set_story_card_poll(poll: Duration) {
    WAITERS.with(|waiters| waiters.poll.set(poll));
}

/// Resolves once no waiter is running. A waiter is not the update's work: an
/// update ends with the "still rendering" toast while its waiter goes on.
pub async fn story_card_waiters_settled() {
    loop {
        let (idle, empty) = WAITERS.with(|waiters| (Rc::clone(&waiters.idle), waiters.keys.borrow().is_empty()));
        let notified = idle.notified();
        if empty {
            return;
        }
        notified.await;
    }
}

fn cards_ready(cards: &[StoryCardState]) -> bool {
    cards
        .iter()
        .all(|card| card.status == "ready" && card.local_path.as_deref().is_some_and(|path| !path.is_empty()))
}

/// `showStoryCardChoice`: `None` when there is nothing to ask.
pub fn show_story_card_choice(
    ctx: &Ctx,
    actor_id: i64,
    draft_id: i64,
    intent: Intent,
) -> crate::Result<Option<Vec<Effect>>> {
    let preview = ctx.services().posts.preview(actor_id, draft_id)?;
    // A site takes the card as the page's own illustration either way, and a
    // Studio with no Story target has nothing to answer.
    if !story_card_use(&preview.targets).stories {
        return Ok(None);
    }
    let cards = preview.story_cards;
    if cards.is_empty() {
        return Ok(None);
    }
    if !cards_ready(&cards) {
        queue_story_card_choice(ctx, actor_id, draft_id, intent);
        return Ok(Some(vec![Effect::toast(t(Key::PostStoryCardsGenerating, &[]))]));
    }
    Ok(Some(send_story_card_choice(draft_id, intent, &cards)?))
}

/// The Story worker owns rendering; this continuation only waits for its
/// durable result and sends the choice as a follow-up message.
fn queue_story_card_choice(ctx: &Ctx, actor_id: i64, draft_id: i64, intent: Intent) {
    let key = format!("{actor_id}:{draft_id}:{}", intent.as_str());
    let started = WAITERS.with(|waiters| waiters.keys.borrow_mut().insert(key.clone()));
    if !started {
        return;
    }
    let waiter = Ctx::new(ctx.bot.clone(), ctx.update.clone());
    let key = WaiterKey(key);
    ctx.bot.spawn_detached(async move {
        let _key = key;
        if let Err(error) = wait_for_story_cards(&waiter, actor_id, draft_id, intent).await {
            log(
                LogLevel::Error,
                "failed to send Story card choice",
                Some(json!({"actorId": actor_id, "draftId": draft_id, "error": error.to_string()})),
            );
        }
    });
}

/// A running waiter's key, released when its task ends however it ends, so
/// a waiter that panicked does not keep [`story_card_waiters_settled`] waiting.
struct WaiterKey(String);

impl Drop for WaiterKey {
    fn drop(&mut self) {
        // The thread-local is gone only when the thread itself is ending.
        let _ = WAITERS.try_with(|waiters| {
            let mut keys = waiters.keys.borrow_mut();
            keys.remove(&self.0);
            if keys.is_empty() {
                waiters.idle.notify_waiters();
            }
        });
    }
}

async fn wait_for_story_cards(ctx: &Ctx, actor_id: i64, draft_id: i64, intent: Intent) -> crate::Result<()> {
    for _ in 0..STORY_CARD_WAIT_POLLS {
        tokio::time::sleep(WAITERS.with(|waiters| waiters.poll.get())).await;
        let cards = ctx.services().posts.preview(actor_id, draft_id)?.story_cards;
        if !cards_ready(&cards) {
            continue;
        }
        if is_superseded_card(ctx, PublicationKind::Post, draft_id)? {
            return Ok(());
        }
        return execute(ctx, send_story_card_choice(draft_id, intent, &cards)?).await;
    }
    // The renderer never finished. The operator tapped Publish and is owed an
    // answer either way.
    if is_superseded_card(ctx, PublicationKind::Post, draft_id)? {
        return Ok(());
    }
    let keyboard = InlineKeyboard::new().text(t(Key::CommonBack, &[]), overview_callback(draft_id)?);
    execute(
        ctx,
        vec![Effect::Message {
            text: t(Key::PostStoryCardsTimeout, &[]),
            options: Payload::new().reply_markup(keyboard),
            card: Some(CardRef::Post { draft_id, view: None }),
        }],
    )
    .await
}

fn overview_callback(draft_id: i64) -> crate::Result<String> {
    Ok(publication_callback(
        PublicationKind::Post,
        "view",
        &[&draft_id, &"overview"],
        None,
    )?)
}

fn send_story_card_choice(draft_id: i64, intent: Intent, cards: &[StoryCardState]) -> crate::Result<Vec<Effect>> {
    let mut effects = Vec::new();
    for card in cards {
        if let Some(path) = card.local_path.as_deref().filter(|path| !path.is_empty()) {
            effects.push(Effect::Photo {
                path: PathBuf::from(path),
                options: Payload::new().set("caption", format!("Story · {}", card.locale.to_uppercase())),
                card: None,
            });
        }
    }
    let callback =
        |action: &str| -> crate::Result<String> { Ok(publication_callback(PublicationKind::Post, action, &[&draft_id], None)?) };
    let keyboard = match intent {
        Intent::Publish => InlineKeyboard::new()
            .text(t(Key::PostStoryCardsAll, &[]), callback("story_publish_all")?)
            .row()
            .text(t(Key::PostStoryCardsSiteOnly, &[]), callback("story_publish_site")?),
        Intent::Schedule => InlineKeyboard::new()
            .text(t(Key::PostStoryCardsAllSchedule, &[]), callback("story_schedule_all")?)
            .row()
            .text(
                t(Key::PostStoryCardsSiteOnlySchedule, &[]),
                callback("story_schedule_site")?,
            ),
    };
    let keyboard = keyboard
        .row()
        .text(t(Key::CommonBack, &[]), overview_callback(draft_id)?);
    effects.push(Effect::Message {
        text: t(Key::PostStoryCardsQuestion, &[]),
        options: Payload::new().markdown().reply_markup(keyboard),
        card: Some(CardRef::Post { draft_id, view: None }),
    });
    Ok(effects)
}
