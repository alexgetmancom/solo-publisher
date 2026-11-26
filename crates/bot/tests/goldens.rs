//! Byte-for-byte replay of the recorded bot goldens (parity/bot-goldens/),
//! one test per golden directory:
//!
//!   cargo test -p bot --test goldens            # every area
//!   cargo test -p bot --test goldens entry      # one area (add `-- --nocapture` for the report)
//!
//! A case whose area, or an area it reaches, is still pending
//! (`support/pending.rs`) is listed as NOT PORTED on every run, never skipped
//! silently.

mod support;

use support::pending::{CASE_NEEDS, PENDING_AREAS, pending_for};
use support::{areas, cases, missing_registrations, run_area};

fn check(area: &str) {
    let report = run_area(area);
    assert!(
        report.failed.is_empty(),
        "{area}: {} of {} replayed cases differ from the goldens: {}",
        report.failed.len(),
        report.failed.len() + report.passed.len(),
        report
            .failed
            .iter()
            .map(|(case, _)| case.as_str())
            .collect::<Vec<_>>()
            .join(", ")
    );
}

#[test]
fn callbacks() {
    check("callbacks");
}

#[test]
fn deploy() {
    check("deploy");
}

#[test]
fn entry() {
    check("entry");
}

#[test]
fn intake() {
    check("intake");
}

#[test]
fn loops() {
    check("loops");
}

#[test]
fn notices() {
    check("notices");
}

#[test]
fn post() {
    check("post");
}

#[test]
fn queue() {
    check("queue");
}

#[test]
fn settings() {
    check("settings");
}

#[test]
fn video() {
    check("video");
}

/// Every golden directory has its test above, every allowlist entry names a
/// real area and a real case, and the allowlist tells the truth about the
/// registry: a registered area misses nothing, a pending area still misses something.
#[test]
fn the_pending_allowlist_matches_the_registry() {
    let directories = areas();
    let tested = [
        "callbacks",
        "deploy",
        "entry",
        "intake",
        "loops",
        "notices",
        "post",
        "queue",
        "settings",
        "video",
    ];
    assert_eq!(
        directories, tested,
        "a golden directory without a test, or a test without a directory"
    );
    for (case, needs) in CASE_NEEDS {
        let (area, name) = case.split_once('/').unwrap();
        assert!(
            cases(area).iter().any(|known| known == name),
            "CASE_NEEDS names an unknown case {case}"
        );
        assert!(
            needs.iter().all(|need| directories.iter().any(|dir| dir == need)),
            "{case} needs an unknown area"
        );
    }
    let missing = missing_registrations();
    for (area, what) in &missing {
        assert!(
            PENDING_AREAS.contains(area),
            "area {area} is not pending but the registry misses its {what}"
        );
    }
    for area in PENDING_AREAS {
        // Areas that are golden directories only (notices: pushes, not screens)
        // are pending until their cases replay.
        let owns_registrations = missing.iter().any(|(owner, _)| owner == area);
        let has_cases = directories.iter().any(|dir| dir == area);
        assert!(
            owns_registrations || has_cases,
            "{area} is pending but neither misses a registration nor has goldens: remove it from PENDING_AREAS"
        );
    }
    // The core's own goldens run now; only cases waiting for an area are listed.
    assert!(pending_for("entry", "start").is_empty());
}
