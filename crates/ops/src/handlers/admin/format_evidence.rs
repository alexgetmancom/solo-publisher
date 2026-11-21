//! `recordFormatEvidence` and `seedFormatSupport` (`operations/format-support.ts`):
//! the message that proves which targets carry a media format.

use db::rusqlite::{Connection, OptionalExtension, params};
use domain::application::publication_ref::{PublicationRefKind, publication_ref};
use domain::targets::TARGETS;
use foundation::time::to_iso_string;
use jiff::Timestamp;
use serde_json::Value;

use super::rows;
use crate::context::OpError;

const MEDIA_TEST_CASES: [(&str, &str, &str, &str); 9] = [
    ("T01", "text_only", "Text only", "Send a plain text message."),
    ("T02", "text_picture", "Text + picture", "Send 1 photo with caption."),
    (
        "T03",
        "text_pictures",
        "Text + pictures",
        "Send album with 2 photos and caption.",
    ),
    ("T04", "text_video", "Text + video", "Send 1 video with caption."),
    (
        "T05",
        "text_videos",
        "Text + videos",
        "Send album with 2 videos and caption.",
    ),
    (
        "T06",
        "pictures_only",
        "Pictures only",
        "Send album with 2 photos, no caption.",
    ),
    (
        "T07",
        "videos_only",
        "Videos only",
        "Send album with 2 videos, no caption.",
    ),
    (
        "T08",
        "video_picture",
        "Video + picture",
        "Send album with 1 video and 1 photo with caption.",
    ),
    (
        "T09",
        "videos_pictures",
        "Videos + pictures",
        "Send mixed photo/video album with caption.",
    ),
];

/// The curated subset a media-format test is graded against: stories and X
/// are hand-driven and would keep every case pending.
const EXPECTED_TARGETS: [&str; 4] = ["telegram", "site_ru", "site_en", "threads_ru"];

/// `seedFormatSupport`.
pub fn seed_format_support(sqlite: &Connection, now: Timestamp) -> Result<(), OpError> {
    let unknown: Vec<&str> = EXPECTED_TARGETS
        .into_iter()
        .filter(|target| !TARGETS.iter().any(|known| known.id == *target))
        .collect();
    if !unknown.is_empty() {
        return Err(OpError::failed(format!(
            "format fixture references unknown targets: {}",
            unknown.join(", ")
        )));
    }
    let now = to_iso_string(now);
    let expected = serde_json::to_string(&EXPECTED_TARGETS)?;
    domain::repositories::transaction(sqlite, || {
        for (test_id, format_key, title, recipe) in MEDIA_TEST_CASES {
            sqlite.execute(
                r#"insert into "media_test_cases" ("test_id", "format_key", "title", "input_recipe", "expected_targets_json", "created_at", "updated_at") values (?1, ?2, ?3, ?4, ?5, ?6, ?6) on conflict ("media_test_cases"."test_id") do update set "format_key" = ?2, "title" = ?3, "input_recipe" = ?4, "expected_targets_json" = ?5, "updated_at" = ?6"#,
                params![test_id, format_key, title, recipe, expected, now],
            )?;
            for target in &TARGETS {
                sqlite.execute(
                    r#"insert into "format_support" ("target", "format_key", "status", "updated_at") values (?, ?, 'unknown', ?) on conflict do nothing"#,
                    params![target.id, format_key, now],
                )?;
            }
        }
        Ok(())
    })?;
    Ok(())
}

/// `recordFormatEvidence`: grades the test by what each expected target of
/// the post did, and answers the test's status.
pub fn record_format_evidence(
    sqlite: &Connection,
    test_id: &str,
    post_id: i64,
    notes: Option<&str>,
    now: Timestamp,
) -> Result<String, OpError> {
    seed_format_support(sqlite, now)?;
    let test: Option<(String, String)> = sqlite
        .query_row(
            r#"select "format_key", "expected_targets_json" from "media_test_cases" where "media_test_cases"."test_id" = ?"#,
            [test_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((format_key, expected_json)) = test else {
        return Err(OpError::failed(format!("unknown test: {test_id}")));
    };
    let post: Option<Option<i64>> = sqlite
        .query_row(
            r#"select "post_id" from "drafts" where "drafts"."post_id" = ?"#,
            [post_id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(post) = post.flatten().filter(|post| *post != 0) else {
        return Err(OpError::failed(format!("post not found: {post_id}")));
    };
    let publication_key = publication_ref(PublicationRefKind::Post, post);
    let found = rows::all(
        sqlite,
        r#"select * from "publication_targets" where "publication_targets"."publication_key" = ?"#,
        [&publication_key],
    )?;
    let expected: Vec<String> = serde_json::from_str(&expected_json)?;
    let now = to_iso_string(now);
    let mut statuses: Vec<&str> = Vec::new();
    domain::repositories::transaction(sqlite, || {
        for target in &TARGETS {
            // `new Map(rows)`: a later row for the same target wins.
            let row = found.iter().rev().find(|row| rows::text(row, "target") == target.id);
            let status = row.map(|row| rows::text(row, "status"));
            let skipped = row.is_some_and(|row| match row.get("skipped") {
                Some(Value::Number(number)) => number.as_f64() != Some(0.0),
                Some(Value::Bool(flag)) => *flag,
                Some(Value::String(text)) => !text.is_empty(),
                _ => false,
            });
            let status = if status == Some("published") {
                "supported"
            } else if skipped {
                "blocked"
            } else if status == Some("failed") {
                "failed"
            } else {
                "unknown"
            };
            let is_expected = expected.iter().any(|name| name == target.id);
            if is_expected {
                statuses.push(status);
            }
            if is_expected && ["supported", "failed", "blocked"].contains(&status) {
                let evidence_url = row.and_then(|row| {
                    [row.get("url"), row.get("external_id")]
                        .into_iter()
                        .flatten()
                        .find(|value| !value.is_null())
                        .cloned()
                });
                sqlite.execute(
                    r#"insert into "format_support" ("target", "format_key", "status", "evidence_test_id", "evidence_message_id", "evidence_url", "notes", "updated_at") values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) on conflict ("format_support"."target", "format_support"."format_key") do update set "status" = ?3, "evidence_test_id" = ?4, "evidence_message_id" = ?5, "evidence_url" = ?6, "notes" = ?7, "updated_at" = ?8"#,
                    params![
                        target.id,
                        format_key,
                        status,
                        test_id,
                        post_id,
                        evidence_url.as_ref().and_then(Value::as_str),
                        notes,
                        now
                    ],
                )?;
            }
        }
        let test_status = if statuses.iter().all(|status| *status == "supported") {
            "pass"
        } else if statuses.contains(&"failed") {
            "fail"
        } else if statuses.contains(&"supported") {
            "partial"
        } else {
            "pending"
        };
        match notes.filter(|notes| !notes.is_empty()) {
            Some(notes) => sqlite.execute(
                r#"update "media_test_cases" set "status" = ?, "last_message_id" = ?, "notes" = ?, "updated_at" = ? where "media_test_cases"."test_id" = ?"#,
                params![test_status, post_id, notes, now, test_id],
            )?,
            None => sqlite.execute(
                r#"update "media_test_cases" set "status" = ?, "last_message_id" = ?, "updated_at" = ? where "media_test_cases"."test_id" = ?"#,
                params![test_status, post_id, now, test_id],
            )?,
        };
        Ok(())
    })?;
    let status: Option<String> = sqlite
        .query_row(
            r#"select "status" from "media_test_cases" where "media_test_cases"."test_id" = ?"#,
            [test_id],
            |row| row.get(0),
        )
        .optional()?;
    Ok(status.unwrap_or_else(|| "pending".into()))
}
