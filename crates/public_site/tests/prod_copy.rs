//! The route over a copy of a real database, for comparing with the
//! TypeScript side without printing anything the database holds:
//!
//!   PUBLIC_SITE_DB=<copy> PUBLIC_SITE_NOW=<ISO> cargo test -p public_site --test prod_copy -- --ignored --nocapture
//!   bun scripts/rust/public-site-goldens.ts --prod <other copy> <ISO>
//!
//! Each side opens (and migrates) its own copy; both print the body's sha256,
//! the ETag and the item count.

use std::cell::Cell;

use db::BackendDb;
use domain::application::ports::Clock;
use foundation::config::load_config;
use jiff::Timestamp;
use public_site::{PublicSite, SiteRequest};
use sha2::{Digest, Sha256};

struct FixedClock(Cell<Timestamp>);

impl Clock for FixedClock {
    fn now(&self) -> Timestamp {
        self.0.get()
    }
}

#[tokio::test(flavor = "current_thread")]
#[ignore = "needs PUBLIC_SITE_DB and PUBLIC_SITE_NOW"]
async fn answers_over_a_database_copy() {
    let path = std::env::var("PUBLIC_SITE_DB").expect("PUBLIC_SITE_DB");
    let now = std::env::var("PUBLIC_SITE_NOW").expect("PUBLIC_SITE_NOW");
    let data_dir = std::path::Path::new(&path).parent().unwrap().join("rust-data");
    let db = BackendDb::open(&path).unwrap();
    let config = load_config([
        ("DATA_DIR", data_dir.to_str().unwrap()),
        ("PUBLIC_BASE_URL", "https://studio.example.com"),
    ])
    .unwrap();
    let clock = FixedClock(Cell::new(foundation::time::parse_iso_instant(&now).unwrap()));
    let response = PublicSite::new()
        .respond(&db, &config, &clock, SiteRequest::default())
        .await
        .unwrap();
    let body = response.body.unwrap_or_default();
    let items = serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|value| value["items"].as_array().map(Vec::len));
    let etag = response
        .headers
        .iter()
        .find(|(name, _)| *name == "etag")
        .map(|(_, value)| value.clone());
    let sha256: String = Sha256::digest(body.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    println!(
        "{}",
        serde_json::json!({"status": response.status, "sha256": sha256, "etag": etag, "items": items})
    );
}
