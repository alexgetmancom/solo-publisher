//! Compiles `locales/ru.json` (written by `scripts/rust/export-ru-catalog.ts`)
//! into a `Key` enum and its text table, so a misspelled message key is a
//! compile error rather than a missing string on a screen.

use std::collections::HashSet;
use std::fmt::Write as _;
use std::path::Path;

fn main() {
    let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("locales/ru.json");
    println!("cargo::rerun-if-changed={}", source.display());
    let text = std::fs::read_to_string(&source).expect("read locales/ru.json");
    let catalog: serde_json::Map<String, serde_json::Value> =
        serde_json::from_str(&text).expect("locales/ru.json is a JSON object");

    let mut variants = Vec::with_capacity(catalog.len());
    let mut seen = HashSet::new();
    for key in catalog.keys() {
        let variant: String = key
            .split(['.', '-'])
            .map(|part| {
                let mut chars = part.chars();
                chars
                    .next()
                    .map(|first| first.to_ascii_uppercase().to_string() + chars.as_str())
                    .unwrap_or_default()
            })
            .collect();
        assert!(
            !variant.is_empty()
                && variant.chars().all(|c| c.is_ascii_alphanumeric())
                && !variant.starts_with(char::is_numeric),
            "message key {key:?} does not map to a Rust identifier"
        );
        assert!(
            seen.insert(variant.clone()),
            "message keys collide on variant {variant}"
        );
        variants.push(variant);
    }

    let mut out = String::new();
    out.push_str("/// Every interface message key, in catalog order.\n");
    out.push_str("#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]\npub enum Key {\n");
    for (variant, key) in variants.iter().zip(catalog.keys()) {
        writeln!(out, "    /// `{key}`\n    {variant},").unwrap();
    }
    out.push_str("}\n\n");
    writeln!(out, "const ALL: [Key; {}] = [", variants.len()).unwrap();
    for variant in &variants {
        writeln!(out, "    Key::{variant},").unwrap();
    }
    out.push_str("];\n\n");
    writeln!(out, "const NAMES: [&str; {}] = [", catalog.len()).unwrap();
    for key in catalog.keys() {
        writeln!(out, "    {key:?},").unwrap();
    }
    out.push_str("];\n\n");
    writeln!(out, "const TEXTS: [&str; {}] = [", catalog.len()).unwrap();
    for (key, value) in &catalog {
        let value = value
            .as_str()
            .unwrap_or_else(|| panic!("message {key:?} is not a string"));
        writeln!(out, "    {value:?},").unwrap();
    }
    out.push_str("];\n");

    let target = Path::new(&std::env::var("OUT_DIR").expect("OUT_DIR")).join("catalog.rs");
    std::fs::write(target, out).expect("write catalog.rs");
}
