//! The credential circuit breaker: after a
//! few consecutive auth failures a target stops calling its provider until a
//! cooldown passes or a call succeeds. Its state is the `details_json` of the
//! target's `credential_checks` row, of which it rewrites only its own fields.

use db::rusqlite::{Connection, OptionalExtension, params};
use foundation::js::{json_number, truthy};
use foundation::time::parse_iso_instant;
use serde_json::{Map, Value, json};

use crate::Result;
use crate::application::ports::{Clock, DomainEventInput, Severity};
use crate::publishing::boundaries::{AuthCircuit, AuthCircuitState};
use crate::repositories::{record_event, stamp, stamp_offset};

const AUTH_FAILURE_THRESHOLD: f64 = 3.0;
const AUTH_BLOCK_COOLDOWN_SECONDS: i64 = 30 * 60;

/// The breaker on the connection a caller hands it.
#[derive(Clone, Copy)]
pub struct AuthCircuitBreaker<C> {
    clock: C,
}

impl<C: Clock> AuthCircuitBreaker<C> {
    pub fn new(clock: C) -> Self {
        Self { clock }
    }
}

/// `parseDetails`: the stored object, or an empty one. An array is an object
/// to JavaScript too, and spreading it keys its items by index.
fn parse_details(json: Option<&str>) -> Map<String, Value> {
    match json.filter(|json| !json.is_empty()).map(serde_json::from_str::<Value>) {
        Some(Ok(Value::Object(details))) => details,
        Some(Ok(Value::Array(items))) => items
            .into_iter()
            .enumerate()
            .map(|(index, item)| (index.to_string(), item))
            .collect(),
        _ => Map::new(),
    }
}

fn details_of(sqlite: &Connection, target: &str) -> Result<Option<Option<String>>> {
    Ok(sqlite
        .query_row(
            r#"select "details_json" from "credential_checks" where "credential_checks"."target" = ?"#,
            [target],
            |row| row.get(0),
        )
        .optional()?)
}

fn write_details(sqlite: &Connection, target: &str, details: &Map<String, Value>) -> Result<()> {
    sqlite.execute(
        r#"update "credential_checks" set "details_json" = ? where "credential_checks"."target" = ?"#,
        params![crate::json::stringify_object(details), target],
    )?;
    Ok(())
}

/// `new Date(value).getTime()` of a stored instant; `None` stands for NaN.
fn instant_ms(value: Option<&Value>) -> Option<i64> {
    match value? {
        Value::String(text) if !text.is_empty() => parse_iso_instant(text).ok().map(|at| at.as_millisecond()),
        _ => None,
    }
}

/// `isTargetAuthBlocked`: checked before a publish call is attempted.
pub fn is_target_auth_blocked(sqlite: &Connection, clock: &dyn Clock, target: &str) -> Result<bool> {
    let Some(row) = details_of(sqlite, target)? else {
        return Ok(false);
    };
    let details = parse_details(row.as_deref());
    // `!details.blockedUntil`: an empty or absent value blocks nothing.
    match details.get("blockedUntil") {
        None | Some(Value::Null | Value::Bool(false)) => return Ok(false),
        Some(Value::String(text)) if text.is_empty() => return Ok(false),
        _ => {}
    }
    Ok(instant_ms(details.get("blockedUntil")).is_some_and(|until| until > clock.now().as_millisecond()))
}

/// `providerAnsweredAt`: when this target's provider last answered anything.
pub fn provider_answered_at(sqlite: &Connection, target: &str) -> Result<Option<String>> {
    let Some(row) = details_of(sqlite, target)? else {
        return Ok(None);
    };
    Ok(parse_details(row.as_deref())
        .get("lastAnswerAt")
        .and_then(Value::as_str)
        .map(str::to_owned))
}

impl<C: Clock> AuthCircuit for AuthCircuitBreaker<C> {
    /// `recordAuthFailure`: called after a publish attempt fails with
    /// errorClass `auth`.
    fn record_failure(&self, sqlite: &Connection, target: &str) -> Result<()> {
        let now = stamp(&self.clock);
        let row = details_of(sqlite, target)?;
        let mut details = parse_details(row.as_ref().and_then(|json| json.as_deref()));
        let streak = details.get("authFailureStreak").and_then(Value::as_f64).unwrap_or(0.0) + 1.0;
        let tripped = streak >= AUTH_FAILURE_THRESHOLD;
        let blocked_until = if tripped {
            Value::String(stamp_offset(&self.clock, AUTH_BLOCK_COOLDOWN_SECONDS * 1000))
        } else {
            details.get("blockedUntil").cloned().unwrap_or(Value::Null)
        };
        // The unrelated fields (token health's `lastPingAt`) stay as they were.
        details.insert("authFailureStreak".into(), json_number(streak));
        details.insert("blockedUntil".into(), blocked_until.clone());
        details.insert("lastAuthFailureAt".into(), Value::String(now.clone()));
        if row.is_some() {
            write_details(sqlite, target, &details)?;
        } else {
            sqlite.execute(
                r#"insert into "credential_checks" ("target", "status", "required_env_json", "missing_env_json", "expires_at", "last_checked_at", "next_check_at", "last_error", "details_json") values (?, 'unknown', '[]', '[]', null, ?, null, null, ?)"#,
                params![target, now, crate::json::stringify_object(&details)],
            )?;
        }
        if tripped && streak == AUTH_FAILURE_THRESHOLD {
            let Value::Object(event_details) =
                json!({"target": target, "streak": json_number(streak), "blockedUntil": blocked_until})
            else {
                unreachable!("built as an object")
            };
            record_event(
                sqlite,
                &self.clock,
                &DomainEventInput {
                    publication_ref: None,
                    event_type: "credential.auth_circuit_tripped".into(),
                    severity: Severity::Error,
                    target: Some(target.to_owned()),
                    message: format!(
                        "{target}: {} consecutive auth failures, pausing publishes for {}m",
                        foundation::js::number_to_string(streak),
                        AUTH_BLOCK_COOLDOWN_SECONDS / 60
                    ),
                    details: Some(event_details),
                    cooldown_seconds: Some(AUTH_BLOCK_COOLDOWN_SECONDS as u64),
                },
            )?;
        }
        Ok(())
    }

    /// `recordAuthSuccess`: clears any tripped breaker and records that the
    /// provider answered; nothing for a target with no row.
    fn record_success(&self, sqlite: &Connection, target: &str) -> Result<()> {
        let Some(row) = details_of(sqlite, target)? else {
            return Ok(());
        };
        let mut details = parse_details(row.as_deref());
        details.insert("authFailureStreak".into(), json!(0));
        details.insert("blockedUntil".into(), Value::Null);
        details.insert("lastAnswerAt".into(), Value::String(stamp(&self.clock)));
        details.shift_remove("lastAuthFailureAt");
        write_details(sqlite, target, &details)
    }

    /// `authCircuitStates`: every target the breaker has a record for.
    fn states(&self, sqlite: &Connection) -> Result<Vec<AuthCircuitState>> {
        let now = self.clock.now().as_millisecond();
        let rows: Vec<(String, Option<String>, Option<String>)> = sqlite
            .prepare(r#"select "target", "details_json", "expires_at" from "credential_checks""#)?
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
            .collect::<db::rusqlite::Result<_>>()?;
        Ok(rows
            .into_iter()
            .map(|(target, details, expires_at)| {
                let details = parse_details(details.as_deref());
                let text = |key: &str| details.get(key).and_then(Value::as_str).map(str::to_owned);
                AuthCircuitState {
                    target,
                    blocked: instant_ms(details.get("blockedUntil")).is_some_and(|until| until > now),
                    blocked_until: text("blockedUntil"),
                    auth_failure_streak: details.get("authFailureStreak").and_then(Value::as_i64).unwrap_or(0),
                    last_auth_failure_at: text("lastAuthFailureAt"),
                    last_ping_at: text("lastPingAt"),
                    token_expires_at: expires_at,
                }
            })
            .collect())
    }
}

impl<C: Clock> AuthCircuitBreaker<C> {
    /// Whether token health's live probe of `target` is due. A stored ping
    /// time that does not parse is never due: its comparison is false, as a
    /// `NaN` comparison is.
    pub fn should_ping_token(&self, sqlite: &Connection, target: &str, interval_seconds: i64) -> Result<bool> {
        let row = details_of(sqlite, target)?;
        let details = parse_details(row.flatten().as_deref());
        let Some(last_ping) = details.get("lastPingAt").filter(|value| truthy(value)) else {
            return Ok(true);
        };
        Ok(instant_ms(Some(last_ping))
            .is_some_and(|at| self.clock.now().as_millisecond() - at >= interval_seconds * 1000))
    }

    /// `recordTokenPing`: a live probe ran. `token_expires_at` is the expiry
    /// the provider reported (`None` leaves a stored one as it is);
    /// `backdate_seconds` makes the next probe due that much sooner.
    pub fn record_token_ping(
        &self,
        sqlite: &Connection,
        target: &str,
        token_expires_at: Option<&str>,
        backdate_seconds: Option<i64>,
    ) -> Result<()> {
        let now = stamp(&self.clock);
        let row = details_of(sqlite, target)?;
        let mut details = parse_details(row.as_ref().and_then(|json| json.as_deref()));
        let last_ping_at = match backdate_seconds.filter(|seconds| *seconds != 0) {
            Some(seconds) => stamp_offset(&self.clock, -seconds * 1000),
            None => now.clone(),
        };
        details.insert("lastPingAt".into(), Value::String(last_ping_at));
        let details = crate::json::stringify_object(&details);
        match (row.is_some(), token_expires_at) {
            (true, Some(expires_at)) => sqlite.execute(
                r#"update "credential_checks" set "expires_at" = ?, "details_json" = ? where "credential_checks"."target" = ?"#,
                params![expires_at, details, target],
            )?,
            (true, None) => sqlite.execute(
                r#"update "credential_checks" set "details_json" = ? where "credential_checks"."target" = ?"#,
                params![details, target],
            )?,
            (false, expires_at) => sqlite.execute(
                r#"insert into "credential_checks" ("target", "status", "required_env_json", "missing_env_json", "expires_at", "last_checked_at", "next_check_at", "last_error", "details_json") values (?, 'unknown', '[]', '[]', ?, ?, null, null, ?)"#,
                params![target, expires_at, now, details],
            )?,
        };
        Ok(())
    }
}
