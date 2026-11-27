//! The read-only work inbox every Studio interface shows.
//! It returns entity references, not
//! callbacks or display markup.

use jiff::Timestamp;
use serde::{Serialize, Serializer};

use crate::application::conversation_flow::PublicationKind;
use crate::application::ports::StudioQueueVideoTarget;
use crate::channels::effective_post_targets;
use crate::publishing::state::has_unscheduled_locale;
use crate::studio::Studio;
use crate::targets::TargetMap;
use crate::{Error, Result};

const MAX_QUEUE_ROWS: i64 = 100;

pub(crate) fn serialize_instant<S: Serializer>(at: &Timestamp, serializer: S) -> std::result::Result<S::Ok, S::Error> {
    serializer.serialize_str(&foundation::time::to_iso_string(*at))
}

fn is_false(value: &bool) -> bool {
    !value
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct StudioQueueItem {
    pub id: i64,
    pub label: String,
    #[serde(serialize_with = "serialize_instant")]
    pub time: Timestamp,
    pub kind: PublicationKind,
    pub targets: usize,
    /// Its time has passed and it has not published: the operator is looking
    /// at work that is stuck, not at work that is coming.
    #[serde(skip_serializing_if = "is_false")]
    pub overdue: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct StudioQueueAttentionItem {
    pub id: i64,
    pub label: String,
    pub kind: PublicationKind,
    #[serde(serialize_with = "serialize_instant")]
    pub time: Timestamp,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct StudioQueueSnapshot {
    pub upcoming: Vec<StudioQueueItem>,
    pub drafts: Vec<StudioQueueItem>,
    pub attention: Vec<StudioQueueAttentionItem>,
}

/// The latest publication, as the inbox headline names it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct StudioQueueActivity {
    pub id: i64,
    pub label: String,
    #[serde(serialize_with = "serialize_instant")]
    pub time: Timestamp,
    pub kind: PublicationKind,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct StudioQueueHeadline {
    /// The head of the upcoming queue, as the queue lists it.
    pub upcoming: Option<StudioQueueItem>,
    pub published: Option<StudioQueueActivity>,
    pub pending: usize,
}

fn instant(value: &str) -> Result<Timestamp> {
    foundation::time::parse_iso_instant(value).map_err(|error| Error::message(error.to_string()))
}

/// `truncateUnicode(value.replace(/\s+/g, " "), 38).trim()`.
fn shorten(value: &str) -> String {
    let mut collapsed = String::with_capacity(value.len());
    let mut in_space = false;
    for c in value.chars() {
        if c.is_whitespace() {
            if !in_space {
                collapsed.push(' ');
            }
            in_space = true;
        } else {
            collapsed.push(c);
            in_space = false;
        }
    }
    foundation::text::truncate_unicode(&collapsed, 38).trim().to_owned()
}

fn first_line(text: &str) -> &str {
    text.split('\n').next().unwrap_or("").trim()
}

#[derive(Clone, Copy)]
pub struct QueueService<'a> {
    studio: Studio<'a>,
}

impl<'a> QueueService<'a> {
    pub fn new(studio: Studio<'a>) -> Self {
        Self { studio }
    }

    /// The one-line state of the work inbox, plus how much of it is open.
    /// The menu headline and the queue button both read this, so they cannot
    /// disagree about what is waiting.
    pub fn headline(&self, actor_id: i64) -> Result<StudioQueueHeadline> {
        let actor_ids = self.studio.accessible_actor_ids(actor_id);
        let snapshot = self.snapshot(actor_id, None)?;
        let published = self.studio.ports().studio_queue().latest_published(&actor_ids)?;
        Ok(StudioQueueHeadline {
            pending: snapshot.upcoming.len() + snapshot.drafts.len(),
            upcoming: snapshot.upcoming.into_iter().next(),
            published: published
                .map(|published| -> Result<StudioQueueActivity> {
                    Ok(StudioQueueActivity {
                        id: published.id,
                        label: shorten(if published.kind == PublicationKind::Post {
                            first_line(&published.label)
                        } else {
                            &published.label
                        }),
                        time: instant(&published.published_at)?,
                        kind: published.kind,
                    })
                })
                .transpose()?,
        })
    }

    pub fn snapshot(&self, actor_id: i64, limit: Option<i64>) -> Result<StudioQueueSnapshot> {
        self.studio
            .track("studio.queue.read", || self.read_snapshot(actor_id, limit))
    }

    fn read_snapshot(&self, actor_id: i64, limit: Option<i64>) -> Result<StudioQueueSnapshot> {
        let ports = self.studio.ports();
        let sqlite = self.studio.sqlite();
        let actor_ids = self.studio.accessible_actor_ids(actor_id);
        let row_limit = limit.unwrap_or(MAX_QUEUE_ROWS).clamp(1, MAX_QUEUE_ROWS);
        let queue = ports.studio_queue();
        let posts = queue.posts(&actor_ids, row_limit)?;
        let videos = queue.videos(&actor_ids, row_limit)?;
        // One definition of "needs attention" for the whole system: the
        // Studio screen and the Command Center's red dot read the same rows.
        let needs_attention: Vec<(PublicationKind, i64)> = ports
            .actionable_issues()
            .list(Some(&actor_ids))?
            .into_iter()
            .map(|issue| {
                let kind = if issue.kind == crate::application::ports::IssueKind::Video {
                    PublicationKind::Video
                } else {
                    PublicationKind::Post
                };
                (kind, issue.draft_id)
            })
            .collect();
        let now_ms = self.studio.now().as_millisecond();
        let (mut upcoming, mut drafts, mut attention) = (Vec::new(), Vec::new(), Vec::new());

        for draft in &posts {
            let line = first_line(&draft.text_ru);
            let label = shorten(&if line.is_empty() {
                format!("Post #{}", draft.id)
            } else {
                line.to_owned()
            });
            let schedule_gap = draft.status == "scheduled"
                && has_unscheduled_locale(
                    &effective_post_targets(sqlite, &TargetMap::parse(Some(&draft.targets_json)))?,
                    draft.scheduled_at.as_deref(),
                    draft.scheduled_en_at.as_deref(),
                );
            if draft.status == "scheduled" && !schedule_gap {
                // A time that has already passed keeps its place at the head
                // of the queue: a publication nobody sent is exactly what the
                // operator has to see.
                let earliest = [&draft.scheduled_at, &draft.scheduled_en_at]
                    .into_iter()
                    .filter_map(|value| value.as_deref().and_then(foundation::time::parse_iso_ms))
                    .min();
                if let Some(ms) = earliest {
                    let time = Timestamp::from_millisecond(ms).expect("a parsed instant");
                    upcoming.push(StudioQueueItem {
                        id: draft.id,
                        label: label.clone(),
                        time,
                        kind: PublicationKind::Post,
                        targets: effective_post_targets(sqlite, &TargetMap::parse(Some(&draft.targets_json)))?
                            .enabled()
                            .count(),
                        overdue: ms <= now_ms,
                    });
                }
            }
            let updated = instant(&draft.updated_at)?;
            if schedule_gap {
                drafts.push(StudioQueueItem {
                    id: draft.id,
                    label: format!("⏳ {label}"),
                    time: updated,
                    kind: PublicationKind::Post,
                    targets: 0,
                    overdue: false,
                });
            }
            if draft.status == "needs_review" {
                drafts.push(StudioQueueItem {
                    id: draft.id,
                    label: label.clone(),
                    time: updated,
                    kind: PublicationKind::Post,
                    targets: 0,
                    overdue: false,
                });
            }
            if needs_attention.contains(&(PublicationKind::Post, draft.id)) {
                attention.push(StudioQueueAttentionItem {
                    id: draft.id,
                    label,
                    kind: PublicationKind::Post,
                    time: updated,
                });
            }
        }

        // One query for every draft's targets rather than one per draft: this
        // snapshot backs a screen the operator opens constantly.
        let targets: Vec<StudioQueueVideoTarget> = if videos.is_empty() {
            Vec::new()
        } else {
            queue.video_targets(&videos.iter().map(|video| video.id).collect::<Vec<_>>())?
        };
        for video in &videos {
            let scheduled: Vec<i64> = targets
                .iter()
                .filter(|target| target.publication_id == video.id && target.status == "scheduled")
                .filter_map(|target| target.scheduled_at.as_deref())
                .map(|at| instant(at).map(|at| at.as_millisecond()))
                .collect::<Result<_>>()?;
            let trimmed = video.label.trim();
            let label = shorten(&if trimmed.is_empty() {
                format!("Video #{}", video.id)
            } else {
                trimmed.to_owned()
            });
            if video.status == "scheduled"
                && let Some(ms) = scheduled.iter().copied().min()
            {
                upcoming.push(StudioQueueItem {
                    id: video.id,
                    label: label.clone(),
                    time: Timestamp::from_millisecond(ms).expect("a parsed instant"),
                    kind: PublicationKind::Video,
                    targets: scheduled.len(),
                    overdue: ms <= now_ms,
                });
            }
            let updated = instant(&video.updated_at)?;
            if video.status == "draft" || video.status == "editing" {
                drafts.push(StudioQueueItem {
                    id: video.id,
                    label: label.clone(),
                    time: updated,
                    kind: PublicationKind::Video,
                    targets: 0,
                    overdue: false,
                });
            }
            if needs_attention.contains(&(PublicationKind::Video, video.id)) {
                attention.push(StudioQueueAttentionItem {
                    id: video.id,
                    label,
                    kind: PublicationKind::Video,
                    time: updated,
                });
            }
        }

        upcoming.sort_by_key(|item| item.time);
        drafts.sort_by_key(|item| std::cmp::Reverse(item.time));
        attention.sort_by_key(|item| std::cmp::Reverse(item.time));
        Ok(StudioQueueSnapshot {
            upcoming,
            drafts,
            attention,
        })
    }
}
