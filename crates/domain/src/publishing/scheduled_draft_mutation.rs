//! Changes a scheduled draft and its replaceable delivery plan under one
//! write lock. The root update is fenced on the status and revision Studio
//! read; a worker or another interface that moved it first wins without being
//! erased.

use content::Locale;
use content::draft_content::draft_locale_content;

use super::Publishing;
use super::chain_plan::draft_content;
use super::preflight::assert_publication_preflight;
use super::publication_plan::{PublicationSchedule, PublishMode, create_publication_plan};
use crate::application::ports::{DomainEventInput, DraftPatch, DraftRecord};
use crate::channels::{channel_upload_limits, registered_post_target_ids};
use crate::repositories::{DraftStore, immediate_transaction, record_event};
use crate::targets::{TargetMap, is_story_target};
use crate::{Error, Result};

#[derive(Clone, Debug, Default, PartialEq)]
pub struct ScheduledDraftMutation {
    pub patch: DraftPatch,
    pub queue_story_cards: bool,
    pub event: Option<DomainEventInput>,
}

impl Publishing<'_> {
    pub fn mutate_scheduled_draft(&self, draft: &DraftRecord, mutation: &ScheduledDraftMutation) -> Result<bool> {
        if draft.status != "scheduled" || draft.post_id.is_none() {
            return Ok(false);
        }
        let sqlite = self.sqlite;
        let replanned = immediate_transaction(sqlite, || {
            let drafts = DraftStore::new(sqlite, self.clock);
            if !drafts.update_if_current(draft.id, "scheduled", &draft.updated_at, &mutation.patch)? {
                return Ok(None);
            }
            if mutation.queue_story_cards {
                self.boundaries.story_cards.queue(sqlite, draft.id)?;
            }
            let updated = drafts
                .get(draft.id)?
                .filter(|updated| updated.post_id.is_some())
                .ok_or_else(|| Error::message(format!("scheduled draft {} lost its post id", draft.id)))?;
            assert_publication_preflight(&self.effective_draft(&updated)?, &channel_upload_limits(sqlite)?)?;
            if !self.wait_for_story_cards(&updated)? {
                self.persist_replan(&updated)?;
            }
            if let Some(event) = &mutation.event {
                record_event(sqlite, self.clock, event)?;
            }
            Ok(updated.post_id)
        })?;
        let Some(post_id) = replanned else { return Ok(false) };
        self.refresh_publication_status(post_id)?;
        Ok(true)
    }

    /// A text-only post bound for a Story waits for its generated cards
    /// before it is planned again.
    fn wait_for_story_cards(&self, draft: &DraftRecord) -> Result<bool> {
        let targets = self.effective_draft(draft)?;
        let has_story_target = TargetMap::parse(Some(&targets.targets_json))
            .enabled()
            .any(is_story_target);
        let source = draft_content(draft);
        let has_media = !draft_locale_content(&source, Locale::Ru).media.is_empty()
            || !draft_locale_content(&source, Locale::En).media.is_empty();
        let cards = self.boundaries.story_cards;
        Ok(matches!(draft.story_publish_mode.as_deref(), Some("all" | "site_only"))
            && has_story_target
            && !has_media
            && !cards
                .for_draft(self.sqlite, draft.id)?
                .iter()
                .any(|card| card.status == "failed")
            && cards.ready_media(self.sqlite, draft.id)?.is_none())
    }

    fn persist_replan(&self, draft: &DraftRecord) -> Result<()> {
        let effective = self.effective_draft(draft)?;
        assert_publication_preflight(&effective, &channel_upload_limits(self.sqlite)?)?;
        let now = self.now();
        let story_cards = self.boundaries.story_cards.ready_media(self.sqlite, draft.id)?;
        let registered = registered_post_target_ids(self.sqlite)?;
        let plan = create_publication_plan(
            &effective,
            draft.id,
            draft.post_id.expect("checked by the caller"),
            &PublicationSchedule {
                mode: PublishMode::Scheduled,
                ru_at: draft.scheduled_at.clone(),
                en_at: draft.scheduled_en_at.clone(),
            },
            &now,
            (!registered.is_empty()).then_some(registered.as_slice()),
            story_cards.as_ref(),
        )?;
        self.persist_publication_plan_tx(&plan)
    }
}
