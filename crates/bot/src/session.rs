//! Conversation state: one durable row per actor
//! and workflow kind, at most one of them active, expiring 30 minutes after it
//! was last saved.

use db::rusqlite::Connection;
use domain::application::conversation_flow::PublicationKind;
use domain::application::ports::{
    ClearConversationSession, Clock, ConversationSessionKind, ConversationSessionRecord, JsonObject,
    SaveConversationSession,
};
use domain::repositories::ConversationSessionStore;
use foundation::time::{parse_iso_instant, to_iso_string};

const TTL_MS: i64 = 30 * 60_000;

/// The single durable state shape every Telegram conversation uses.
#[derive(Clone, Debug, PartialEq)]
pub struct ConversationState {
    pub kind: ConversationSessionKind,
    pub draft_id: Option<i64>,
    pub step: String,
    pub data: JsonObject,
    pub control_message_id: Option<i64>,
    pub revision: i64,
}

/// What a save writes; `revision`, when given, must still be the stored one.
#[derive(Clone, Debug, PartialEq)]
pub struct ConversationStateInput {
    pub kind: ConversationSessionKind,
    pub draft_id: Option<i64>,
    pub step: String,
    pub data: JsonObject,
    pub control_message_id: Option<i64>,
    pub revision: Option<i64>,
}

pub fn publication_session_kind(kind: PublicationKind) -> ConversationSessionKind {
    match kind {
        PublicationKind::Post => ConversationSessionKind::Post,
        PublicationKind::Video => ConversationSessionKind::Video,
    }
}

#[derive(Clone, Copy)]
pub struct Sessions<'a> {
    sqlite: &'a Connection,
    clock: &'a dyn Clock,
}

impl<'a> Sessions<'a> {
    pub fn new(sqlite: &'a Connection, clock: &'a dyn Clock) -> Self {
        Self { sqlite, clock }
    }

    fn store(&self) -> ConversationSessionStore<'a> {
        ConversationSessionStore::new(self.sqlite)
    }

    fn now_ms(&self) -> i64 {
        self.clock.now().as_millisecond()
    }

    fn now_iso(&self) -> String {
        to_iso_string(self.clock.now())
    }

    /// `getConversationState`: an expired or empty row is retired and reads as
    /// none, an inactive one reads as none.
    pub fn get(&self, actor_id: i64, kind: ConversationSessionKind) -> domain::Result<Option<ConversationState>> {
        let Some(row) = self.store().get(actor_id, kind)? else {
            return Ok(None);
        };
        let expires_at = match row.expires_at.as_deref() {
            Some(expires_at) => parse_iso_instant(expires_at).ok().map(|at| at.as_millisecond()),
            None => parse_iso_instant(&row.updated_at)
                .ok()
                .map(|at| at.as_millisecond() + TTL_MS),
        };
        if expires_at.is_none_or(|expires_at| expires_at <= self.now_ms()) {
            self.store().retire(actor_id, kind, &self.now_iso())?;
            return Ok(None);
        }
        if row.active == 0 {
            return Ok(None);
        }
        let Some(step) = row.step.clone().filter(|step| !step.is_empty()) else {
            self.store().retire(actor_id, kind, &self.now_iso())?;
            return Ok(None);
        };
        Ok(Some(ConversationState {
            kind: row.kind,
            draft_id: row.draft_id,
            step,
            data: row.data,
            control_message_id: row.control_message_id,
            revision: row.revision,
        }))
    }

    /// `getActiveConversationState`: the video conversation wins over the post one.
    pub fn active(&self, actor_id: i64) -> domain::Result<Option<(PublicationKind, ConversationState)>> {
        if let Some(video) = self.get(actor_id, ConversationSessionKind::Video)? {
            return Ok(Some((PublicationKind::Video, video)));
        }
        Ok(self
            .get(actor_id, ConversationSessionKind::Post)?
            .map(|post| (PublicationKind::Post, post)))
    }

    /// `saveConversationState`: retires every other kind first (one active
    /// conversation per actor), keeps the revision when nothing semantic
    /// changed, refuses a stale `revision` with `action.session-stale`.
    pub fn save(&self, actor_id: i64, input: &ConversationStateInput) -> domain::Result<ConversationState> {
        let existing = self.store().get(actor_id, input.kind)?;
        let now = self.now_iso();
        let expires_at =
            to_iso_string(jiff::Timestamp::from_millisecond(self.now_ms() + TTL_MS).expect("an instant within range"));
        for kind in [
            ConversationSessionKind::Intake,
            ConversationSessionKind::Post,
            ConversationSessionKind::Video,
            ConversationSessionKind::Settings,
        ] {
            if kind != input.kind {
                self.store().retire(actor_id, kind, &now)?;
            }
        }
        let revision = self.store().save(&SaveConversationSession {
            actor_id,
            kind: input.kind,
            draft_id: input.draft_id,
            step: Some(input.step.clone()),
            data: input.data.clone(),
            control_message_id: input.control_message_id,
            active: 1,
            expected_revision: input.revision,
            preserve_revision: existing.as_ref().is_some_and(|row| !has_semantic_change(row, input)),
            updated_at: now,
            expires_at: Some(expires_at),
        })?;
        Ok(ConversationState {
            kind: input.kind,
            draft_id: input.draft_id,
            step: input.step.clone(),
            data: input.data.clone(),
            control_message_id: input.control_message_id,
            revision,
        })
    }

    pub fn clear(&self, actor_id: i64, kind: ConversationSessionKind) -> domain::Result<()> {
        self.store().retire(actor_id, kind, &self.now_iso())
    }

    /// `clearConversationStateIfCurrent`.
    pub fn clear_if_current(
        &self,
        actor_id: i64,
        kind: ConversationSessionKind,
        step: &str,
        draft_id: Option<i64>,
        expected_revision: Option<i64>,
    ) -> domain::Result<bool> {
        self.store().clear_if_current(&ClearConversationSession {
            draft_id,
            actor_id,
            kind,
            step: Some(step.to_owned()),
            expected_revision,
            updated_at: self.now_iso(),
        })
    }

    /// `requireConversationState`: fails with a plain error here, so the
    /// operator reads the code itself.
    pub fn require(
        &self,
        actor_id: i64,
        kind: ConversationSessionKind,
        expected_revision: Option<i64>,
    ) -> crate::Result<ConversationState> {
        match self.get(actor_id, kind)? {
            Some(state) if expected_revision.is_none_or(|revision| revision == state.revision) => Ok(state),
            _ => Err(crate::error("action.session-stale")),
        }
    }
}

fn has_semantic_change(row: &ConversationSessionRecord, input: &ConversationStateInput) -> bool {
    row.active != 1
        || row.draft_id != input.draft_id
        || row.step.as_deref() != Some(input.step.as_str())
        || domain::json::stringify_object(&row.data) != domain::json::stringify_object(&input.data)
}
