//! The foundation modules against outputs the TypeScript backend recorded
//! before the cutover (`tests/fixtures/`).

use std::path::Path;

use foundation::i18n::plural;
use foundation::markdown::escape_markdown;
use foundation::redact::redact_external_secrets;
use foundation::secret_box::{encryption_key, fingerprint, open, seal};
use foundation::text::truncate_unicode;
use foundation::time::*;
use jiff::Timestamp;
use serde_json::{Value, json};

fn fixture(name: &str) -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name);
    serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap()
}

fn rows<'a>(value: &'a Value, key: &str) -> &'a Vec<Value> {
    let rows = value[key].as_array().unwrap();
    assert!(!rows.is_empty(), "fixture section {key} is empty");
    rows
}

fn text(value: &Value) -> &str {
    value
        .as_str()
        .unwrap_or_else(|| panic!("expected a string, got {value}"))
}

fn instant(value: &Value) -> Timestamp {
    parse_iso_instant(text(value)).unwrap()
}

fn zone(value: &Value) -> Zone {
    Zone::parse(text(&value["zone"])).unwrap()
}

/// `{"ok": …}` or `{"error": "…"}`, as the fixture generator records results.
fn outcome<T: Into<Value>>(result: Result<T, impl std::fmt::Display>) -> Value {
    match result {
        Ok(value) => json!({ "ok": value.into() }),
        Err(error) => json!({ "error": error.to_string() }),
    }
}

#[test]
fn time_matches_intl() {
    let time = fixture("time.json");
    for case in rows(&time, "valid_zones") {
        assert_eq!(
            is_valid_time_zone(text(&case["name"])),
            case["valid"].as_bool().unwrap(),
            "{case}"
        );
    }
    for case in rows(&time, "parse") {
        assert_eq!(
            outcome(parse_iso_instant(text(&case["input"])).map(to_iso_string)),
            case["result"],
            "{case}"
        );
    }
    for case in rows(&time, "instants") {
        let (zone, at) = (zone(case), instant(&case["at"]));
        let parts = zoned_date_parts(at, &zone);
        let actual = json!({
            "zone": case["zone"],
            "at": to_iso_string(at),
            "offset_ms": timezone_offset_ms(at, &zone),
            "calendar_day": zoned_calendar_day(at, &zone),
            "parts": [parts.year, parts.month, parts.day],
            "clock": format_zoned_clock(at, &zone),
            "day_month": format_zoned_day_month(at, &zone),
            "date_time": format_zoned_date_time(Some(at), &zone, "LBL"),
            "sortable": format_zoned_sortable(at, &zone),
            "manual_example": manual_schedule_example(&zone, at),
            "offset_label": time_zone_offset_label(&zone, at),
        });
        assert_eq!(&actual, case);
    }
    for case in rows(&time, "day_distance") {
        let days = zoned_day_distance(instant(&case["date"]), instant(&case["now"]), &zone(case));
        assert_eq!(days, case["days"].as_i64().unwrap(), "{case}");
    }
    for case in rows(&time, "slots") {
        let number = |key: &str| case[key].as_i64().unwrap();
        let result = zoned_slot(
            number("year"),
            number("month"),
            number("day"),
            text(&case["clock"]),
            &zone(case),
        );
        assert_eq!(outcome(result.map(to_iso_string)), case["result"], "{case}");
    }
    for case in rows(&time, "week_bounds") {
        let bounds = zoned_week_bounds(case["offset"].as_i64().unwrap(), &zone(case), instant(&case["now"]));
        assert_eq!(
            (bounds.0.as_str(), bounds.1.as_str()),
            (text(&case["start"]), text(&case["end"])),
            "{case}"
        );
    }
    for case in rows(&time, "rolling_bounds") {
        let (offset, days) = (case["offset"].as_f64().unwrap(), case["days"].as_i64().unwrap());
        let bounds = zoned_rolling_period_bounds(offset, days, &zone(case), instant(&case["now"]));
        assert_eq!(
            (bounds.0.as_str(), bounds.1.as_str()),
            (text(&case["start"]), text(&case["end"])),
            "{case}"
        );
    }
    assert_eq!(format_zoned_date_time(None, &Zone::parse("UTC").unwrap(), "MSK"), "-");
}

#[test]
fn plural_matches_intl_plural_rules() {
    let plurals = fixture("plural.json");
    let cases = plurals.as_array().unwrap();
    assert!(cases.len() > 40);
    for case in cases {
        let n = case["n"].as_u64().unwrap();
        assert_eq!(plural(n, "one", "few", "many"), text(&case["category"]), "n = {n}");
    }
    assert_eq!(plural(3, "{n} день", "{n} дня", "{n} дней"), "3 дня");
}

#[test]
fn text_helpers_match_typescript() {
    let texts = fixture("text.json");
    for case in rows(&texts, "truncate") {
        let max = case["max"].as_u64().unwrap() as usize;
        assert_eq!(
            truncate_unicode(text(&case["value"]), max),
            text(&case["result"]),
            "{case}"
        );
    }
    for case in rows(&texts, "markdown") {
        assert_eq!(escape_markdown(text(&case["value"])), text(&case["result"]), "{case}");
    }
    for case in rows(&texts, "redact") {
        assert_eq!(
            redact_external_secrets(text(&case["value"])),
            text(&case["result"]),
            "{case}"
        );
    }
}

#[test]
fn secret_box_is_byte_compatible_with_typescript() {
    let boxes = fixture("secret-box.json");
    let key_hex = text(&boxes["key"]);
    let key = encryption_key(Some(key_hex)).unwrap().unwrap();

    for case in rows(&boxes, "sealed") {
        assert_eq!(open(text(&case["sealed"]), &key).unwrap(), text(&case["value"]));
    }
    for case in rows(&boxes, "open_errors") {
        assert_eq!(outcome(open(text(&case["sealed"]), &key)), case["result"], "{case}");
    }
    for case in rows(&boxes, "fingerprints") {
        assert_eq!(fingerprint(text(&case["value"])), text(&case["fingerprint"]), "{case}");
    }
    for case in rows(&boxes, "keys") {
        let decoded = encryption_key(Some(text(&case["raw"]))).map(|key| {
            key.unwrap()
                .bytes()
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        });
        assert_eq!(outcome(decoded), case["result"], "{case}");
    }
    assert!(encryption_key(None).unwrap().is_none() && encryption_key(Some("")).unwrap().is_none());

    // What Rust seals opens again, under a fresh IV each time.
    for case in rows(&boxes, "sealed") {
        let value = text(&case["value"]);
        let (first, second) = (seal(value, &key), seal(value, &key));
        assert_ne!(first, second, "{case}");
        assert_eq!(first.split('.').count(), 3, "{case}");
        assert_eq!(open(&first, &key).unwrap(), value, "{case}");
        assert_eq!(open(&second, &key).unwrap(), value, "{case}");
    }
}
