//! When a publication goes out: slot buttons, typed times in the Studio's
//! zone, and the bounds every schedule must keep.

use std::sync::LazyLock;

use foundation::errors::StudioError;
use foundation::js::WHITESPACE_CLASS;
use foundation::time::{Zone, zoned_date_parts, zoned_slot};
use jiff::Timestamp;
use regex::Regex;

use crate::{Error, Result};

const MAX_SCHEDULE_AHEAD_MS: i64 = 30 * 24 * 60 * 60 * 1000;

/// The soonest a publication can be given. Delivery runs off the schedule, so
/// "now" is a timestamp a minute out rather than a second path to publication.
const IMMEDIATE_SCHEDULE_LEAD_MS: i64 = 60_000;

/// Resolves a slot-button clock (`HH:MM` in the configured zone) to today's
/// occurrence, or tomorrow's if today's has already passed.
pub fn publication_slot_time(clock: &str, zone: &Zone, now: Timestamp) -> Result<Timestamp> {
    let slot = |(year, month, day)| {
        zoned_slot(year, month, day, clock, zone).map_err(|error| Error::message(error.to_string()))
    };
    let today = zoned_date_parts(now, zone);
    let value = slot((today.year, today.month, today.day))?;
    if value > now {
        return Ok(value);
    }
    slot(calendar_date_after(today.year, today.month, today.day))
}

/// JavaScript's `\s+`.
static WHITESPACE_RUN: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!("[{WHITESPACE_CLASS}]+")).unwrap());
static CLOCK_ONLY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^([0-9]{1,2}):([0-9]{2})$").unwrap());
static DATE_AND_CLOCK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^([0-9]{1,2})\.([0-9]{1,2})(?:\.([0-9]{4}))? ([0-9]{1,2}):([0-9]{2})$").unwrap());

fn parse_error() -> StudioError {
    StudioError::new("common.schedule-parse-error")
}

/// An operator's typed time: `HH:MM` (today, or tomorrow once it has passed)
/// or `DD.MM[.YYYY] HH:MM`, in the Studio's zone.
pub fn parse_manual_schedule(value: &str, zone: &Zone, now: Timestamp) -> std::result::Result<Timestamp, StudioError> {
    let input = WHITESPACE_RUN.replace_all(foundation::js::trim(value), " ");
    let today = zoned_date_parts(now, zone);
    let number = |text: &str| text.parse::<i64>().expect("matched digits");
    if let Some(found) = CLOCK_ONLY.captures(&input) {
        let (hour, minute) = (number(&found[1]), number(&found[2]));
        if hour > 23 || minute > 59 {
            return Err(parse_error());
        }
        let clock = format!("{:0>2}:{}", &found[1], &found[2]);
        let candidate = parse_zoned_slot((today.year, today.month, today.day), &clock, zone)?;
        if candidate > now {
            return Ok(candidate);
        }
        return parse_zoned_slot(calendar_date_after(today.year, today.month, today.day), &clock, zone);
    }
    let found = DATE_AND_CLOCK.captures(&input).ok_or_else(parse_error)?;
    let year = found.get(3).map_or(today.year, |year| number(year.as_str()));
    let (month, day, hour, minute) = (
        number(&found[2]),
        number(&found[1]),
        number(&found[4]),
        number(&found[5]),
    );
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || hour > 23 || minute > 59 {
        return Err(parse_error());
    }
    let clock = format!("{:0>2}:{}", &found[4], &found[5]);
    let candidate = parse_zoned_slot((year, month, day), &clock, zone)?;
    let parts = zoned_date_parts(candidate, zone);
    if parts.year != year || parts.month != month || parts.day != day {
        return Err(parse_error());
    }
    if found.get(3).is_none() && candidate <= now {
        return Err(StudioError::new("err.schedule-date-past"));
    }
    assert_future_schedule(candidate, now)?;
    Ok(candidate)
}

pub fn immediate_schedule_time(now: Timestamp) -> Timestamp {
    Timestamp::from_millisecond(now.as_millisecond() + IMMEDIATE_SCHEDULE_LEAD_MS).expect("instant within year ±9999")
}

pub fn is_immediate_schedule(value: Timestamp, now: Timestamp) -> bool {
    value.as_millisecond() - now.as_millisecond() <= IMMEDIATE_SCHEDULE_LEAD_MS
}

/// The application-level contract shared by post and video scheduling.
pub fn assert_future_schedule(value: Timestamp, now: Timestamp) -> std::result::Result<(), StudioError> {
    let ahead = value.as_millisecond() - now.as_millisecond();
    if ahead <= 0 {
        return Err(StudioError::new("err.schedule-time-past"));
    }
    if ahead > MAX_SCHEDULE_AHEAD_MS {
        return Err(StudioError::new("err.schedule-too-far"));
    }
    Ok(())
}

fn parse_zoned_slot(
    (year, month, day): (i64, i64, i64),
    clock: &str,
    zone: &Zone,
) -> std::result::Result<Timestamp, StudioError> {
    zoned_slot(year, month, day, clock, zone).map_err(|_| parse_error())
}

/// The calendar day after a date the zone produced.
fn calendar_date_after(year: i64, month: i64, day: i64) -> (i64, i64, i64) {
    let date = jiff::civil::Date::new(year as i16, month as i8, day as i8)
        .and_then(|date| date.tomorrow())
        .expect("a date the zone produced has a next day");
    (i64::from(date.year()), i64::from(date.month()), i64::from(date.day()))
}
