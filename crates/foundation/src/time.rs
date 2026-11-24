//! Zone-aware date math and display, driven by the Studio profile's timezone.
//!
//! Instants are built from parts in UTC and the zone is consulted only for its
//! offset; nothing is ever parsed or formatted in the host's timezone. The
//! arithmetic reproduces what the TypeScript code got from `Date.UTC` and `Intl`
//! (`ru-RU` for display), quirks included: an offset is the zone's wall clock,
//! read to the second, minus the instant, so it carries the instant's
//! milliseconds with the opposite sign, and the week and period bounds inherit
//! that.

use std::fmt;
use std::sync::LazyLock;

use jiff::Timestamp;
use jiff::tz::{Offset, TimeZone, TimeZoneDatabase};
use regex::Regex;

use crate::js;

const DAY_MS: i64 = 86_400_000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TimeError(String);

impl fmt::Display for TimeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for TimeError {}

/// A time zone as configured: the name it was given (kept for messages) and the
/// zone it resolves to. Accepts what `Intl.DateTimeFormat` accepts — IANA names
/// in any letter case and `±HH`, `±HHMM`, `±HH:MM` offsets.
#[derive(Clone, Debug)]
pub struct Zone {
    name: String,
    tz: TimeZone,
}

/// The tzdb bundled into the binary, never the host's: the zones valid here
/// are the ones `Intl` accepted, and a dependency enabling jiff's default
/// features (grammers does) would otherwise put `/usr/share/zoneinfo` first.
static TZDB: LazyLock<TimeZoneDatabase> = LazyLock::new(TimeZoneDatabase::bundled);

static OFFSET_ZONE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^([+-])([01][0-9]|2[0-3])(?::?([0-5][0-9]))?$").unwrap());

impl Zone {
    pub fn parse(name: &str) -> Option<Self> {
        let tz = match OFFSET_ZONE.captures(name) {
            Some(offset) => {
                let minutes =
                    offset[2].parse::<i32>().ok()? * 60 + offset.get(3).map_or(Ok(0), |m| m.as_str().parse()).ok()?;
                let sign = if &offset[1] == "-" { -1 } else { 1 };
                TimeZone::fixed(Offset::from_seconds(sign * minutes * 60).ok()?)
            }
            // Where the bundled tzdb and ICU's disagree, ICU decides: it has no
            // `Factory` zone and still knows the retired `US/Pacific-New` link.
            None if name.eq_ignore_ascii_case("Factory") => return None,
            None if name.eq_ignore_ascii_case("US/Pacific-New") => TZDB.get("America/Los_Angeles").ok()?,
            None => TZDB.get(name).ok()?,
        };
        Some(Self {
            name: name.to_owned(),
            tz,
        })
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    fn offset_seconds(&self, ms: i64) -> i64 {
        let at = Timestamp::from_millisecond(ms).expect("instant within year ±9999");
        i64::from(self.tz.to_offset(at).seconds())
    }

    /// The zone's wall clock at `ms`, to the second, as UTC-shaped milliseconds.
    fn wall_clock_ms(&self, ms: i64) -> i64 {
        ms.div_euclid(1000) * 1000 + self.offset_seconds(ms) * 1000
    }

    fn wall_clock(&self, ms: i64) -> Civil {
        Civil::from_ms(self.wall_clock_ms(ms))
    }
}

pub fn is_valid_time_zone(name: &str) -> bool {
    Zone::parse(name).is_some()
}

/// Civil date and time of a UTC-shaped millisecond count.
struct Civil {
    year: i64,
    month: i64,
    day: i64,
    hour: i64,
    minute: i64,
    second: i64,
    millisecond: i64,
    /// Days since 1970-01-01.
    days: i64,
}

impl Civil {
    fn from_ms(ms: i64) -> Self {
        let days = ms.div_euclid(DAY_MS);
        let time = ms.rem_euclid(DAY_MS);
        let (year, month, day) = civil_from_days(days);
        Self {
            year,
            month,
            day,
            hour: time / 3_600_000,
            minute: time / 60_000 % 60,
            second: time / 1000 % 60,
            millisecond: time % 1000,
            days,
        }
    }
}

// Howard Hinnant's days-from-civil algorithms, proleptic Gregorian.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let day_of_year = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let days = days + 719_468;
    let era = days.div_euclid(146_097);
    let day_of_era = days - era * 146_097;
    let year_of_era = (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * shifted_month + 2) / 5 + 1;
    let month = if shifted_month < 10 {
        shifted_month + 3
    } else {
        shifted_month - 9
    };
    (year_of_era + era * 400 + i64::from(month <= 2), month, day)
}

/// Milliseconds of a civil date and time read as UTC; `month` and `day` may
/// overflow into the next month or year.
fn civil_ms(year: i64, month: i64, day: i64, hour: i64, minute: i64, second: i64) -> i64 {
    let month0 = month - 1;
    let days = days_from_civil(year + month0.div_euclid(12), month0.rem_euclid(12) + 1, 1) + day - 1;
    days * DAY_MS + hour * 3_600_000 + minute * 60_000 + second * 1000
}

/// `Date.UTC(year, month - 1, day, hour, minute, second)`, including its rule
/// that years 0–99 mean 1900–1999.
fn date_utc(year: i64, month: i64, day: i64, hour: i64, minute: i64, second: i64) -> i64 {
    let year = if (0..=99).contains(&year) { 1900 + year } else { year };
    civil_ms(year, month, day, hour, minute, second)
}

fn timestamp(ms: i64) -> Timestamp {
    Timestamp::from_millisecond(ms).expect("instant within year ±9999")
}

/// `Date.prototype.toISOString`: `2026-08-27T14:01:34.000Z`.
pub fn to_iso_string(at: Timestamp) -> String {
    let civil = Civil::from_ms(at.as_millisecond());
    let year = if (0..=9999).contains(&civil.year) {
        format!("{:04}", civil.year)
    } else {
        format!("{}{:06}", if civil.year < 0 { '-' } else { '+' }, civil.year.abs())
    };
    format!(
        "{year}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        civil.month, civil.day, civil.hour, civil.minute, civil.second, civil.millisecond
    )
}

static FULL_ISO_INSTANT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]+))?(?:Z|([+-])([0-9]{2}):([0-9]{2}))$",
    )
    .unwrap()
});

/// Machine timestamps name an instant with an explicit offset; host-local and
/// RFC-like dates are refused. Out-of-range days roll over into the next month
/// and `24:00:00` is the next midnight, as JavaScript's parser has it; precision
/// is the millisecond, further digits are dropped.
pub fn parse_iso_instant(value: &str) -> Result<Timestamp, TimeError> {
    let invalid = || TimeError("must be a full ISO timestamp, for example 2026-08-27T14:01:34Z".into());
    let parts = FULL_ISO_INSTANT.captures(value).ok_or_else(invalid)?;
    let number = |index: usize| parts.get(index).map_or(0, |m| m.as_str().parse::<i64>().unwrap_or(0));
    let (year, month, day, hour, minute, second) = (number(1), number(2), number(3), number(4), number(5), number(6));
    let millisecond = parts.get(7).map_or(0, |fraction| {
        format!("{:0<3}", &fraction.as_str()[..fraction.len().min(3)])
            .parse::<i64>()
            .unwrap_or(0)
    });
    let (offset_hours, offset_minutes) = (number(9), number(10));
    let valid = (1..=12).contains(&month)
        && (1..=31).contains(&day)
        && (hour < 24 || (hour == 24 && minute == 0 && second == 0 && millisecond == 0))
        && minute < 60
        && second < 60
        && offset_hours < 24
        && offset_minutes < 60;
    if !valid {
        return Err(invalid());
    }
    let sign = if parts.get(8).is_some_and(|sign| sign.as_str() == "-") {
        -1
    } else {
        1
    };
    let offset_ms = sign * (offset_hours * 3_600_000 + offset_minutes * 60_000);
    Timestamp::from_millisecond(civil_ms(year, month, day, hour, minute, second) + millisecond - offset_ms)
        .map_err(|_| invalid())
}

pub fn is_iso_instant(value: &str) -> bool {
    parse_iso_instant(value).is_ok()
}

/// Wall-clock-minus-UTC offset in milliseconds for `at` in `zone`.
pub fn timezone_offset_ms(at: Timestamp, zone: &Zone) -> i64 {
    let ms = at.as_millisecond();
    zone.wall_clock_ms(ms) - ms
}

/// The zone's offset as `Intl` names it at `now`: `GMT+3`, `GMT+5:30`, `GMT+0`.
pub fn time_zone_offset_label(zone: &Zone, now: Timestamp) -> String {
    let seconds = zone.offset_seconds(now.as_millisecond());
    let (hours, minutes, rest) = (seconds.abs() / 3600, seconds.abs() / 60 % 60, seconds.abs() % 60);
    let mut label = format!("GMT{}{hours}", if seconds < 0 { '-' } else { '+' });
    if minutes != 0 || rest != 0 {
        label.push_str(&format!(":{minutes:02}"));
    }
    if rest != 0 {
        label.push_str(&format!(":{rest:02}"));
    }
    label
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ZonedDate {
    pub year: i64,
    pub month: i64,
    pub day: i64,
}

/// Calendar date `at` reads as in `zone`.
pub fn zoned_date_parts(at: Timestamp, zone: &Zone) -> ZonedDate {
    let civil = zone.wall_clock(at.as_millisecond());
    ZonedDate {
        year: civil.year,
        month: civil.month,
        day: civil.day,
    }
}

pub fn zoned_calendar_day(at: Timestamp, zone: &Zone) -> String {
    let date = zoned_date_parts(at, zone);
    format!("{}-{:02}-{:02}", date.year, date.month, date.day)
}

/// Whole calendar days from `now` to `date` in `zone`; negative is in the past.
/// Not milliseconds: a day is not 86,400,000 ms across a DST change.
pub fn zoned_day_distance(date: Timestamp, now: Timestamp, zone: &Zone) -> i64 {
    let day_number = |at: Timestamp| {
        let parts = zoned_date_parts(at, zone);
        date_utc(parts.year, parts.month, parts.day, 0, 0, 0)
    };
    (day_number(date) - day_number(now)) / DAY_MS
}

/// `18:30`.
pub fn format_zoned_clock(at: Timestamp, zone: &Zone) -> String {
    let civil = zone.wall_clock(at.as_millisecond());
    format!("{:02}:{:02}", civil.hour, civil.minute)
}

const MONTHS_SHORT: [&str; 12] = [
    "янв.",
    "февр.",
    "мар.",
    "апр.",
    "мая",
    "июн.",
    "июл.",
    "авг.",
    "сент.",
    "окт.",
    "нояб.",
    "дек.",
];

/// `5 авг.` — a date close enough that the year is noise.
pub fn format_zoned_day_month(at: Timestamp, zone: &Zone) -> String {
    let civil = zone.wall_clock(at.as_millisecond());
    format!("{} {}", civil.day, MONTHS_SHORT[(civil.month - 1) as usize])
}

/// `21.11 HH:MM`: today's date in `zone`, as an input example.
pub fn manual_schedule_example(zone: &Zone, now: Timestamp) -> String {
    let date = zoned_date_parts(now, zone);
    format!("{:02}.{:02} HH:MM", date.day, date.month)
}

/// The instant at which the wall clock in `zone` reads `clock` (`HH:MM`) on the
/// given date; the earlier one when the reading happens twice.
pub fn zoned_slot(year: i64, month: i64, day: i64, clock: &str, zone: &Zone) -> Result<Timestamp, TimeError> {
    let mut parts = clock.split(':').map(js::number);
    let (hour, minute) = (parts.next().unwrap_or(f64::NAN), parts.next().unwrap_or(f64::NAN));
    if !hour.is_finite() || !minute.is_finite() {
        return Err(TimeError(
            "date value is not finite in DateTimeFormat formatToParts()".into(),
        ));
    }
    let wall = date_utc(year, month, day, hour.trunc() as i64, minute.trunc() as i64, 0);
    // Sample both sides of the requested wall clock: a single lookup at the
    // UTC-shaped wall clock picks the wrong side of a DST change. No zone's
    // offset is a day away from the instant it labels, and the round trip
    // below rejects a wrong guess.
    let mut offsets: Vec<i64> = Vec::with_capacity(3);
    for probe in [wall - DAY_MS, wall, wall + DAY_MS] {
        let offset = zone.wall_clock_ms(probe) - probe;
        if !offsets.contains(&offset) {
            offsets.push(offset);
        }
    }
    offsets
        .into_iter()
        .map(|offset| wall - offset)
        .filter(|candidate| zone.wall_clock_ms(*candidate) == wall)
        .min()
        .map(timestamp)
        .ok_or_else(|| TimeError(format!("Wall-clock time does not exist in {}", zone.name)))
}

/// Telegram and dashboard display: `15.07.2026, 18:30 MSK`, or `-` for no time.
pub fn format_zoned_date_time(value: Option<Timestamp>, zone: &Zone, label: &str) -> String {
    let Some(at) = value else { return "-".into() };
    let civil = zone.wall_clock(at.as_millisecond());
    format!(
        "{:02}.{:02}.{}, {:02}:{:02} {label}",
        civil.day, civil.month, civil.year, civil.hour, civil.minute
    )
}

/// `date.toLocaleString("ru-RU", { timeZone })`: `20.08.2026, 18:00:00`.
pub fn format_zoned_locale_string(at: Timestamp, zone: &Zone) -> String {
    let civil = zone.wall_clock(at.as_millisecond());
    format!(
        "{:02}.{:02}.{}, {:02}:{:02}:{:02}",
        civil.day, civil.month, civil.year, civil.hour, civil.minute, civil.second
    )
}

/// Sortable `YYYY-MM-DD HH:MM` in `zone`, for machine-friendly summaries.
pub fn format_zoned_sortable(at: Timestamp, zone: &Zone) -> String {
    let civil = zone.wall_clock(at.as_millisecond());
    format!(
        "{}-{:02}-{:02} {:02}:{:02}",
        civil.year, civil.month, civil.day, civil.hour, civil.minute
    )
}

/// Inclusive ISO `[start, end]` of the Monday-start week `offset` weeks before
/// the one containing `now` in `zone`; `end` is the week's last millisecond.
pub fn zoned_week_bounds(offset: i64, zone: &Zone, now: Timestamp) -> (String, String) {
    let offset_ms = timezone_offset_ms(now, zone);
    let zoned = Civil::from_ms(now.as_millisecond() + offset_ms);
    let weekday = (zoned.days + 3).rem_euclid(7);
    let start = date_utc(zoned.year, zoned.month, zoned.day - weekday - offset * 7, 0, 0, 0) - offset_ms;
    (
        to_iso_string(timestamp(start)),
        to_iso_string(timestamp(start + 7 * DAY_MS - 1)),
    )
}

/// Inclusive ISO `[start, end]` of a rolling `days`-long period ending today in
/// `zone`, moved back `offset` whole periods (a fraction moves part of one).
pub fn zoned_rolling_period_bounds(offset: f64, days: i64, zone: &Zone, now: Timestamp) -> (String, String) {
    // `new Date(now - offset * days * 86_400_000)`: float arithmetic, truncated.
    let shifted = (now.as_millisecond() as f64 - offset * days as f64 * DAY_MS as f64).trunc() as i64;
    let offset_ms = timezone_offset_ms(timestamp(shifted), zone);
    let zoned = Civil::from_ms(shifted + offset_ms);
    let end_wall = date_utc(zoned.year, zoned.month, zoned.day + 1, 0, 0, 0);
    let start_wall = end_wall - days * DAY_MS;
    (
        to_iso_string(timestamp(start_wall - offset_ms)),
        to_iso_string(timestamp(end_wall - offset_ms - 1)),
    )
}
