//! Embeds `migrations/` — the single source of the schema — exactly as
//! drizzle's migrator read it: journal order, `when` as the bookkeeping
//! timestamp, and the SHA-256 of each file's text as its hash.

use std::fmt::Write as _;
use std::path::PathBuf;
use std::{env, fs};

use sha2::{Digest, Sha256};

fn main() {
    let folder = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap()).join("migrations");
    let folder = folder.canonicalize().expect("crates/db/migrations is missing");
    println!("cargo::rerun-if-changed={}", folder.display());
    let journal_path = folder.join("meta/_journal.json");
    println!("cargo::rerun-if-changed={}", journal_path.display());
    let journal: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&journal_path).expect("cannot read meta/_journal.json"))
            .expect("meta/_journal.json is not JSON");
    let mut generated = String::from("&[\n");
    for entry in journal["entries"].as_array().expect("journal has no entries") {
        let tag = entry["tag"].as_str().expect("journal entry without a tag");
        let when = entry["when"].as_i64().expect("journal entry without an integer `when`");
        let path = folder.join(format!("{tag}.sql"));
        println!("cargo::rerun-if-changed={}", path.display());
        let text = fs::read_to_string(&path).unwrap_or_else(|_| panic!("No file {} found", path.display()));
        let hash = Sha256::digest(text.as_bytes())
            .iter()
            .fold(String::new(), |mut hex, byte| {
                write!(hex, "{byte:02x}").unwrap();
                hex
            });
        writeln!(
            generated,
            "    Migration {{ created_at: {when}, hash: {hash:?}, sql: include_str!({path:?}) }},"
        )
        .unwrap();
    }
    generated.push(']');
    fs::write(
        PathBuf::from(env::var("OUT_DIR").unwrap()).join("migrations.rs"),
        generated,
    )
    .unwrap();
}
