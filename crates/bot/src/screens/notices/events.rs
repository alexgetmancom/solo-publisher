//! The Telegram event loop's tick:
//! durable domain events rendered as Telegram-only side effects,
//! at most once each.

use db::rusqlite::{OptionalExtension, params};
use domain::application::publication_ref::{PublicationRefKind, parse_publication_ref};
use foundation::logger::{LogLevel, log};
use foundation::time::{iso_at, to_iso_string};
use serde_json::{Map, Value, json};

use super::notifications::{
    StudioEvent, notify_final_video_failure, notify_unresolved_video_target, refresh_video_control_card,
    send_studio_completion, send_studio_reminder,
};
use crate::bot::Bot;
use crate::context::Ctx;
use crate::effects::error_js_string;
use crate::screens::post::refresh_post_control_card;

const TELEGRAM_EVENT_TYPES: [&str; 13] = [
    "delivery.post.settled",
    "delivery.post.locale.completed",
    "publish.job.claimed",
    "publish.job.published",
    "publish.job.failed",
    "publish.job.retry",
    "video.target.failed",
    "video.target.unresolved",
    "video.job.completed",
    "video.job.failed",
    "studio.notification.reminder.due",
    "delivery.post.completed",
    "delivery.video.completed",
];

/// Telegram is an immediate interface, not an archival transport: older
/// undelivered events stay in the journal but are never replayed. A reminder
/// anchored to a moment is meaningless hours late, so it keeps a short window;
/// a failure or completion must survive an outage or a deploy.
const REMINDER_EVENT_TYPE: &str = "studio.notification.reminder.due";
const REMINDER_EVENT_MAX_AGE_MS: i64 = 30 * 60 * 1000;
const OUTCOME_EVENT_MAX_AGE_MS: i64 = 24 * 60 * 60 * 1000;

struct JournalEvent {
    id: i64,
    publication_key: Option<String>,
    event_type: String,
    details_json: Option<String>,
}

/// `consumeTelegramEvents`: how many events were delivered this tick.
pub async fn consume_telegram_events(bot: &Bot) -> crate::Result<usize> {
    let ctx = Ctx::worker(bot);
    let now = ctx.now().as_millisecond();
    let since = |age_ms: i64| iso_at(now - age_ms);
    let types = TELEGRAM_EVENT_TYPES
        .iter()
        .map(|kind| format!("'{kind}'"))
        .collect::<Vec<_>>()
        .join(", ");
    // Filtered in SQL, before the limit: filtering after it starves new events
    // once the first page is taken by events already delivered.
    let events: Vec<JournalEvent> = ctx
        .db()
        .prepare(&format!(
            r#"select "id", "publication_key", "event_type", "details_json" from "publication_events" where ("publication_events"."event_type" in ({types}) and (("publication_events"."event_type" in (?1) and "publication_events"."created_at" >= ?2) or ("publication_events"."event_type" not in (?1) and "publication_events"."created_at" >= ?3)) and not exists (select 1 from "alert_dedup" where "alert_dedup"."alert_key" = 'telegram:event:' || "publication_events"."id")) order by "publication_events"."created_at" asc, "publication_events"."id" asc limit ?4"#
        ))?
        .query_map(
            params![
                REMINDER_EVENT_TYPE,
                since(REMINDER_EVENT_MAX_AGE_MS),
                since(OUTCOME_EVENT_MAX_AGE_MS),
                50
            ],
            |row| {
                Ok(JournalEvent {
                    id: row.get(0)?,
                    publication_key: row.get(1)?,
                    event_type: row.get(2)?,
                    details_json: row.get(3)?,
                })
            },
        )?
        .collect::<db::rusqlite::Result<_>>()?;
    let mut handled = 0;
    for event in events {
        if !claim_delivery(&ctx, event.id)? {
            continue;
        }
        // At most once by design: the reservation is committed before
        // Telegram is called, and a failed send is never retried, because its
        // outcome may be ambiguous and a duplicate notice is worse than none.
        match deliver_event(&ctx, &event).await {
            Ok(()) => handled += 1,
            Err(error) => log(
                LogLevel::Error,
                "telegram event delivery failed",
                Some(json!({"event": event.id, "type": event.event_type, "error": error_js_string(&*error)})),
            ),
        }
    }
    Ok(handled)
}

async fn deliver_event(ctx: &Ctx, event: &JournalEvent) -> crate::Result<()> {
    let details = event_details(event.details_json.as_deref());
    let video_draft_id = number_detail(&details, "videoDraftId");
    let video_target_id = number_detail(&details, "videoTargetId");
    let kind = event.event_type.as_str();
    let studio_event = StudioEvent {
        publication_key: event.publication_key.as_deref(),
        event_type: kind,
        details: &details,
    };
    match kind {
        REMINDER_EVENT_TYPE => send_studio_reminder(ctx, &studio_event).await,
        "delivery.post.completed" | "delivery.post.locale.completed" | "delivery.video.completed" => {
            send_studio_completion(ctx, &studio_event).await
        }
        _ if kind == "delivery.post.settled" || kind.starts_with("publish.job.") => {
            let post_id = number_detail(&details, "post_id").or_else(|| {
                parse_publication_ref(event.publication_key.as_deref())
                    .filter(|publication| publication.kind == PublicationRefKind::Post)
                    .map(|publication| publication.id)
            });
            let draft = match post_id {
                Some(post_id) => ctx
                    .db()
                    .query_row(
                        r#"select "id" from "drafts" where "drafts"."post_id" = ? limit 1"#,
                        [post_id],
                        |row| row.get::<_, i64>(0),
                    )
                    .optional()?,
                None => None,
            };
            match draft {
                Some(draft_id) => refresh_post_control_card(ctx, draft_id).await,
                None => Ok(()),
            }
        }
        "video.target.failed" if video_draft_id.is_some() => {
            notify_final_video_failure(ctx, video_draft_id.unwrap_or_default(), video_target_id).await
        }
        "video.target.unresolved" if video_draft_id.is_some() => {
            notify_unresolved_video_target(ctx, video_draft_id.unwrap_or_default(), video_target_id).await
        }
        _ => match video_draft_id {
            Some(video_draft_id) => refresh_video_control_card(ctx, video_draft_id).await,
            None => Ok(()),
        },
    }
}

/// The durable reservation of one event's Telegram delivery.
fn claim_delivery(ctx: &Ctx, event_id: i64) -> crate::Result<bool> {
    Ok(ctx
        .db()
        .query_row(
            r#"insert into "alert_dedup" ("alert_key", "last_sent_at", "suppressed_count") values (?, ?, 0) on conflict do nothing returning "alert_key""#,
            params![format!("telegram:event:{event_id}"), to_iso_string(ctx.now())],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .is_some())
}

/// A safe-integer number under `key`.
fn number_detail(details: &Map<String, Value>, key: &str) -> Option<i64> {
    details
        .get(key)
        .and_then(Value::as_f64)
        .filter(|value| foundation::js::is_safe_integer(*value))
        .map(|value| value as i64)
}

/// The details column as an object: JSON text, possibly holding JSON text
/// again; anything else is no details.
fn event_details(value: Option<&str>) -> Map<String, Value> {
    match value.map(serde_json::from_str::<Value>) {
        Some(Ok(Value::Object(object))) => object,
        Some(Ok(Value::String(text))) => match serde_json::from_str(&text) {
            Ok(Value::Object(object)) => object,
            _ => Map::new(),
        },
        _ => Map::new(),
    }
}
