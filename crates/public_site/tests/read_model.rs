//! The read model's cache contract: what it reuses, what invalidates it, and
//! that tracking leaves the stored database alone.

use std::cell::Cell;
use std::path::Path;
use std::rc::Rc;

use db::rusqlite::Connection;
use db::{BackendDb, unsafe_db};
use domain::application::ports::FixedClock;
use public_site::FeedReader;

fn clock() -> FixedClock {
    FixedClock(Cell::new(
        foundation::time::parse_iso_instant("2026-11-01T10:00:00.000Z").unwrap(),
    ))
}

fn seed(sqlite: &Connection, draft: i64, status: &str) {
    sqlite
        .execute_batch(&format!(
            "INSERT INTO drafts (id, actor_id, status, targets_json, post_id, created_at, updated_at)
               VALUES ({draft}, 7, '{status}', '{{}}', {draft}, '2026-10-01T00:00:00.000Z', '2026-10-0{draft}T00:00:00.000Z');
             INSERT INTO post_locales (draft_id, locale, source_text, site_enabled, published_at, updated_at)
               VALUES ({draft}, 'en', 'Post {draft}', 1, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');"
        ))
        .unwrap();
}

fn texts(feed: &public_site::Feed) -> Vec<String> {
    feed.iter().map(|item| item.text_en.clone()).collect()
}

#[test]
fn reuses_unchanged_posts_and_the_feed_itself() {
    let dir = tempdir("reuse");
    let db = BackendDb::open(dir.join("pipeline.db")).unwrap();
    let clock = clock();
    let reader = FeedReader::default();
    seed(unsafe_db(&db), 1, "published");
    seed(unsafe_db(&db), 2, "published");
    let first = reader.load(&db, &clock).unwrap();
    assert!(Rc::ptr_eq(&first, &reader.load(&db, &clock).unwrap()));
    // A private draft is no publication input.
    seed(unsafe_db(&db), 3, "draft");
    assert!(Rc::ptr_eq(&first, &reader.load(&db, &clock).unwrap()));
    unsafe_db(&db)
        .execute_batch("INSERT INTO post_metrics (publication_key, target, metric_name, value) VALUES ('post:1', 'telegram', 'views', 5)")
        .unwrap();
    let second = reader.load(&db, &clock).unwrap();
    assert!(!Rc::ptr_eq(&first, &second));
    assert_eq!(second[1].views, 5.0);
    // The other post keeps its identity.
    assert!(Rc::ptr_eq(&first[0], &second[0]));
}

#[test]
fn never_caches_pending_transaction_changes() {
    let dir = tempdir("transaction");
    let db = BackendDb::open(dir.join("pipeline.db")).unwrap();
    let clock = clock();
    let reader = FeedReader::default();
    seed(unsafe_db(&db), 1, "published");
    let before = reader.load(&db, &clock).unwrap();
    let sqlite = unsafe_db(&db);
    sqlite.execute_batch("BEGIN").unwrap();
    seed(sqlite, 2, "published");
    assert_eq!(texts(&reader.load(&db, &clock).unwrap()), ["Post 2", "Post 1"]);
    sqlite.execute_batch("ROLLBACK").unwrap();
    let after = reader.load(&db, &clock).unwrap();
    assert!(Rc::ptr_eq(&before, &after));
    assert_eq!(texts(&after), ["Post 1"]);
}

#[test]
fn observes_another_connection_and_leaves_the_schema_alone() {
    let dir = tempdir("external");
    let path = dir.join("pipeline.db");
    let db = BackendDb::open(&path).unwrap();
    let clock = clock();
    let reader = FeedReader::default();
    let schema = |sqlite: &Connection| -> Vec<String> {
        let mut statement = sqlite
            .prepare("SELECT name FROM main.sqlite_master ORDER BY name")
            .unwrap();
        statement
            .query_map([], |row| row.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    };
    let stored = schema(unsafe_db(&db));
    seed(unsafe_db(&db), 1, "published");
    assert_eq!(texts(&reader.load(&db, &clock).unwrap()), ["Post 1"]);
    assert_eq!(schema(unsafe_db(&db)), stored);
    let other = Connection::open(&path).unwrap();
    seed(&other, 2, "published");
    assert_eq!(texts(&reader.load(&db, &clock).unwrap()), ["Post 2", "Post 1"]);
    // A second reader on the same handle shares its tracking.
    assert_eq!(
        texts(&FeedReader::default().load(&db, &clock).unwrap()),
        ["Post 2", "Post 1"]
    );
}

fn tempdir(name: &str) -> std::path::PathBuf {
    let dir =
        Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("../../_trash-rust/tmp/public-site-read-model/{name}"));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}
