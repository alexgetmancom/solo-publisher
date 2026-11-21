//! The session revision guard under a concurrent writer: the expected-revision
//! check lives in the write's own `WHERE`, so a revision another connection
//! bumped after this one read the session makes the write change no row.
//! Scratch files live under `_trash-rust/tmp/domain-tests`.

use std::fs;
use std::path::Path;

use db::{BackendDb, unsafe_db};
use domain::Error;
use domain::application::ports::{ApplicationPorts, ConversationSessionKind, SaveConversationSession, SystemClock};
use serde_json::json;

fn save(step: &str, expected_revision: Option<i64>) -> SaveConversationSession {
    SaveConversationSession {
        actor_id: 1,
        kind: ConversationSessionKind::Post,
        draft_id: Some(5),
        step: Some(step.into()),
        data: json!({ "step": step }).as_object().unwrap().clone(),
        control_message_id: Some(100),
        active: 1,
        expected_revision,
        preserve_revision: false,
        updated_at: "2026-03-01T10:00:00.000Z".into(),
        expires_at: None,
    }
}

#[test]
fn a_revision_bumped_by_another_connection_refuses_the_write() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../_trash-rust/tmp/domain-tests/session-race");
    if dir.exists() {
        fs::remove_dir_all(&dir).unwrap();
    }
    let path = dir.join("pipeline.db");
    let (first, second) = (BackendDb::open(&path).unwrap(), BackendDb::open(&path).unwrap());
    let clock = SystemClock;
    let (mine, theirs) = (
        ApplicationPorts::new(&first, &clock),
        ApplicationPorts::new(&second, &clock),
    );

    assert_eq!(mine.conversation_sessions().save(&save("edit_text", None)).unwrap(), 1);
    let read = mine
        .conversation_sessions()
        .get(1, ConversationSessionKind::Post)
        .unwrap()
        .unwrap();
    assert_eq!(read.revision, 1);

    // Another connection advances the session after this one read it.
    assert_eq!(
        theirs
            .conversation_sessions()
            .save(&save("schedule_manual", Some(1)))
            .unwrap(),
        2
    );

    let stale = mine
        .conversation_sessions()
        .save(&save("thread_part", Some(read.revision)));
    assert!(
        matches!(stale, Err(Error::Studio(ref error)) if error.code == "action.session-stale"),
        "{stale:?}"
    );
    assert_eq!(unsafe_db(&first).changes(), 0, "the guarded write updated a row");
    let stored = theirs
        .conversation_sessions()
        .get(1, ConversationSessionKind::Post)
        .unwrap()
        .unwrap();
    assert_eq!((stored.revision, stored.step.as_deref()), (2, Some("schedule_manual")));
}
