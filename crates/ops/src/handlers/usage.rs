//! `observability/usage.ts` `usageReport`: the windowed report over
//! `runtime_usage`, every known feature included even at zero.

use std::cmp::Ordering;
use std::collections::HashMap;

use db::rusqlite::{Connection, params};
use domain::publishing::boundaries::UsageMeter;
use foundation::time::{parse_iso_instant, to_iso_string};
use jiff::Timestamp;
use serde::Serialize;

use crate::context::{OpResult, to_value};

/// The runtime's own curated operation boundaries (`TRACKED_FEATURES`).
const TRACKED_FEATURES: &[&str] = &[
    "publishing.plan.create",
    "publishing.social.job",
    "publishing.video.job",
    "publishing.site.materialize",
    "content.story_card.render",
    "content.draft.translate",
    "analytics.metrics.collect",
    "analytics.creator_profile.sync",
    "analytics.video_metrics.collect",
    "analytics.video_captions.collect",
    "analytics.audience_demographics.sync",
    "command_center.dashboard.render",
    "command_center.publication_details.render",
    "command_center.fingerprint.poll",
    "studio.queue.read",
    "studio.post.create",
    "studio.post.edit",
    "studio.post.publish",
    "studio.post.publish-article",
    "studio.post.schedule",
    "studio.post.cancel",
    "studio.post.retry",
    "studio.post.skip",
    "studio.post.resend",
    "studio.video.create",
    "studio.video.edit",
    "studio.video.publish",
    "studio.video.schedule",
    "studio.video.cancel",
    "studio.video.retry",
    "studio.video.settle",
    "studio.media.import",
    "studio.channel.list",
    "studio.channel.connect",
    "studio.channel.disable",
    "studio.channel.discover",
    "studio.analytics.dashboard.read",
    "studio.analytics.milestones.read",
    "studio.analytics.post.read",
    "studio.analytics.video.read",
    "studio.analytics.audience.read",
    "studio.mcp.request",
    "telegram.update.handle",
];

/// Short enough that an ongoing failure cannot hide behind a quiet month.
const RECENT_WINDOW_DAYS: i64 = 7;
const MILLISECONDS_PER_DAY: i64 = 24 * 60 * 60 * 1000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UsageRecent {
    days: i64,
    calls: i64,
    failures: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UsageWorstDay {
    day: String,
    calls: i64,
    failures: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UsageFeature {
    feature_key: String,
    calls: i64,
    successes: i64,
    failures: i64,
    total_duration_ms: i64,
    first_seen_at: Option<String>,
    last_seen_at: Option<String>,
    days_with_calls: usize,
    average_duration_ms: i64,
    unused: bool,
    days_since_last_seen: Option<i64>,
    recent: UsageRecent,
    worst_day: Option<UsageWorstDay>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UsageReport {
    generated_at: String,
    window_days: i64,
    unused_days: i64,
    since: String,
    features: Vec<UsageFeature>,
}

struct DailyRow {
    bucket_day: String,
    calls: i64,
    successes: i64,
    failures: i64,
    total_duration_ms: i64,
}

fn day_string(ms: i64) -> String {
    iso(ms)[..10].to_owned()
}

fn iso(ms: i64) -> String {
    to_iso_string(Timestamp::from_millisecond(ms).unwrap_or(Timestamp::UNIX_EPOCH))
}

/// `localeCompare` for feature keys (`[a-z][a-z0-9_.-]*`): ICU orders
/// `_` < `-` < `.` < digits < letters, where bytes put `_` after digits.
fn feature_order(left: &str, right: &str) -> Ordering {
    fn weight(c: char) -> u32 {
        match c {
            '_' => 0,
            '-' => 1,
            '.' => 2,
            '0'..='9' => 10 + c as u32,
            _ => 1000 + c as u32,
        }
    }
    left.chars().map(weight).cmp(right.chars().map(weight))
}

/// `usageReport(db, { knownFeatures, days?, unusedDays? })`. The buffer is
/// flushed first, so this process's own calls are in it.
pub(crate) fn usage_report(
    sqlite: &Connection,
    usage: &dyn UsageMeter,
    now: Timestamp,
    days: Option<i64>,
    unused_days: Option<i64>,
    known_features: &[String],
) -> OpResult {
    usage.flush(sqlite);
    let now_ms = now.as_millisecond();
    let window_days = days.unwrap_or(30);
    let unused_days = unused_days.unwrap_or(90);
    let recent_days = window_days.min(RECENT_WINDOW_DAYS);
    let today = now_ms.div_euclid(MILLISECONDS_PER_DAY) * MILLISECONDS_PER_DAY;
    let since_ms = today - (window_days - 1) * MILLISECONDS_PER_DAY;
    let unused_since = day_string(today - (unused_days - 1) * MILLISECONDS_PER_DAY);
    let recent_since = day_string(today - (recent_days - 1) * MILLISECONDS_PER_DAY);
    // Lifetime bounds answer "has this ever run", a different question from
    // the window.
    let mut statement = sqlite.prepare(
        "SELECT feature_key AS featureKey, MIN(first_seen_at) AS firstSeenAt, MAX(last_seen_at) AS lastSeenAt
       FROM runtime_usage
       GROUP BY feature_key",
    )?;
    let lifetime: Vec<(String, Option<String>, Option<String>)> = statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
        .collect::<Result<_, _>>()?;
    let mut statement = sqlite.prepare(
        "SELECT feature_key AS featureKey, bucket_day AS bucketDay, calls, successes, failures, total_duration_ms AS totalDurationMs
       FROM runtime_usage
       WHERE bucket_day >= ?
       ORDER BY bucket_day",
    )?;
    let mut days_by_feature: HashMap<String, Vec<DailyRow>> = HashMap::new();
    let daily = statement.query_map(params![day_string(since_ms)], |row| {
        Ok((
            row.get::<_, String>(0)?,
            DailyRow {
                bucket_day: row.get(1)?,
                calls: row.get(2)?,
                successes: row.get(3)?,
                failures: row.get(4)?,
                total_duration_ms: row.get(5)?,
            },
        ))
    })?;
    for row in daily {
        let (feature_key, day) = row?;
        days_by_feature.entry(feature_key).or_default().push(day);
    }
    let mut feature_keys: Vec<String> = Vec::new();
    let candidates = TRACKED_FEATURES
        .iter()
        .map(|key| (*key).to_owned())
        .chain(known_features.iter().cloned())
        .chain(lifetime.iter().map(|(key, _, _)| key.clone()));
    for key in candidates {
        if !feature_keys.contains(&key) {
            feature_keys.push(key);
        }
    }
    let mut features: Vec<UsageFeature> = feature_keys
        .into_iter()
        .map(|feature_key| {
            let days = days_by_feature.get(&feature_key).map(Vec::as_slice).unwrap_or_default();
            let (first_seen_at, last_seen_at) = lifetime
                .iter()
                .find(|(key, _, _)| *key == feature_key)
                .map(|(_, first, last)| (first.clone(), last.clone()))
                .unwrap_or_default();
            let mut recent = UsageRecent {
                days: recent_days,
                calls: 0,
                failures: 0,
            };
            let (mut calls, mut successes, mut failures, mut total_duration_ms) = (0, 0, 0, 0);
            let mut worst_day: Option<UsageWorstDay> = None;
            for day in days {
                calls += day.calls;
                successes += day.successes;
                failures += day.failures;
                total_duration_ms += day.total_duration_ms;
                if day.bucket_day >= recent_since {
                    recent.calls += day.calls;
                    recent.failures += day.failures;
                }
                // Oldest first, so `>=` keeps the most recent of equally bad days.
                if day.failures > 0 && worst_day.as_ref().is_none_or(|worst| day.failures >= worst.failures) {
                    worst_day = Some(UsageWorstDay {
                        day: day.bucket_day.clone(),
                        calls: day.calls,
                        failures: day.failures,
                    });
                }
            }
            let last_seen_day = last_seen_at.as_deref().map(|at| at.get(..10).unwrap_or(at));
            let unused = last_seen_day.is_none_or(|day| day.is_empty() || day < unused_since.as_str());
            // `Math.max(0, NaN)` is `NaN`, which JSON writes as null.
            let days_since_last_seen = last_seen_at.as_deref().and_then(|at| {
                parse_iso_instant(at).ok().map(|seen| {
                    (((now_ms - seen.as_millisecond()) as f64) / MILLISECONDS_PER_DAY as f64)
                        .floor()
                        .max(0.0) as i64
                })
            });
            UsageFeature {
                average_duration_ms: if calls == 0 {
                    0
                } else {
                    (total_duration_ms as f64 / calls as f64 + 0.5).floor() as i64
                },
                feature_key,
                calls,
                successes,
                failures,
                total_duration_ms,
                first_seen_at,
                last_seen_at,
                days_with_calls: days.len(),
                unused,
                days_since_last_seen,
                recent,
                worst_day,
            }
        })
        .collect();
    features.sort_by(|left, right| {
        right
            .calls
            .cmp(&left.calls)
            .then_with(|| feature_order(&left.feature_key, &right.feature_key))
    });
    to_value(UsageReport {
        generated_at: to_iso_string(now),
        window_days,
        unused_days,
        since: iso(since_ms),
        features,
    })
}
