//! `observability/alerts.ts`: unacknowledged warnings and errors of the event
//! journal, delivered through an optional transport, one subject quiet for an
//! hour after it was reported.

use std::fmt::Display;
use std::future::Future;

use db::rusqlite::{Connection, OptionalExtension, params};
use foundation::logger::{LogLevel, log};
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::Result;
use crate::application::ports::Clock;
use crate::repositories::{stamp, transaction};

/// How long one alert subject stays quiet after it has been reported.
pub const ALERT_COOLDOWN_SECONDS: i64 = 3600;

struct PendingAlert {
    id: i64,
    event_type: String,
    severity: String,
    target: Option<String>,
    message: String,
}

#[derive(PartialEq, Eq)]
enum Disposition {
    Unavailable,
    Claimed,
    Suppressed,
    Send,
}

/// `deliverPendingAlerts(backendDb, { sendAlert })`: how many alerts were sent.
/// The durable reservation precedes the external call, so a failed send is
/// settled rather than retried.
pub async fn deliver_pending_alerts<F, Fut, E>(
    sqlite: &Connection,
    clock: &dyn Clock,
    send_alert: Option<F>,
) -> Result<usize>
where
    F: Fn(String) -> Fut,
    Fut: Future<Output = std::result::Result<(), E>>,
    E: Display,
{
    let events = {
        let mut statement = sqlite.prepare(
            r#"select "id", "event_type", "severity", "target", "message" from "publication_events" where ("publication_events"."severity" in (?, ?) and "publication_events"."acked_at" is null) order by "publication_events"."created_at" asc, "publication_events"."id" asc limit ?"#,
        )?;
        statement
            .query_map(params!["warn", "error", 20], |row| {
                Ok(PendingAlert {
                    id: row.get(0)?,
                    event_type: row.get(1)?,
                    severity: row.get(2)?,
                    target: row.get(3)?,
                    message: row.get(4)?,
                })
            })?
            .collect::<db::rusqlite::Result<Vec<_>>>()?
    };
    let mut alerts = 0;
    for event in events {
        let key = format!(
            "{:x}",
            Sha256::digest(format!(
                "{}\0{}\0{}",
                event.event_type,
                event.target.as_deref().unwrap_or_default(),
                event.message
            ))
        );
        let now = stamp(clock);
        let disposition = transaction(sqlite, || {
            let last_sent_at = sqlite
                .query_row(
                    r#"select "last_sent_at" from "alert_dedup" where "alert_dedup"."alert_key" = ?"#,
                    [&key],
                    |row| row.get::<_, String>(0),
                )
                .optional()?;
            let cooling = last_sent_at
                .as_deref()
                .and_then(|sent| foundation::time::parse_iso_instant(sent).ok())
                .is_some_and(|sent| {
                    clock.now().as_millisecond() - sent.as_millisecond() < ALERT_COOLDOWN_SECONDS * 1000
                });
            if !cooling && send_alert.is_none() {
                return Ok(Disposition::Unavailable);
            }
            let claimed = sqlite
                .query_row(
                    r#"update "publication_events" set "acked_at" = ? where ("publication_events"."id" = ? and "publication_events"."acked_at" is null) returning "id""#,
                    params![now, event.id],
                    |row| row.get::<_, i64>(0),
                )
                .optional()?;
            if claimed.is_none() {
                return Ok(Disposition::Claimed);
            }
            if cooling {
                sqlite.execute(
                    r#"update "alert_dedup" set "suppressed_count" = "alert_dedup"."suppressed_count" + 1 where "alert_dedup"."alert_key" = ?"#,
                    [&key],
                )?;
                return Ok(Disposition::Suppressed);
            }
            sqlite.execute(
                r#"insert into "alert_dedup" ("alert_key", "last_sent_at", "suppressed_count") values (?1, ?2, 0) on conflict ("alert_dedup"."alert_key") do update set "last_sent_at" = ?2, "suppressed_count" = 0"#,
                params![key, now],
            )?;
            Ok(Disposition::Send)
        })?;
        if disposition != Disposition::Send {
            continue;
        }
        let Some(send) = &send_alert else { continue };
        let text = format!(
            "[{}] {}\n{}",
            event.severity.to_uppercase(),
            event.target.as_deref().unwrap_or(&event.event_type),
            event.message
        );
        match send(foundation::js::slice_utf16(&text, 4000).to_owned()).await {
            Ok(()) => alerts += 1,
            // A transport error may still mean the message was accepted, so
            // retrying could alert twice; the attempt stays settled.
            Err(error) => log(
                LogLevel::Error,
                "alert delivery failed after durable reservation",
                Some(json!({"event": event.id, "error": error.to_string()})),
            ),
        }
    }
    Ok(alerts)
}
