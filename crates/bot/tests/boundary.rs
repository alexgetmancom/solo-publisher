//! The callback boundary and the menu plugin's format, checked on the core
//! alone: the parts of the callback goldens that reach no area yet, and the
//! boundary rules (spec §5.4–5.7) driven through the main menu, the one menu
//! the core owns.

#[allow(dead_code)]
mod support;

use bot::menu::tiny_hash;
use serde_json::{Value, json};
use support::pending::pending_for;
use support::{Harness, ensure_seeds, on_bot_thread, replay_steps, seed_database};

/// Callback goldens whose first steps reach only the core, and how many.
const CORE_PREFIXES: &[(&str, usize)] = &[("callback-menu-legacy", 3), ("callback-unknown", 3)];

#[test]
fn the_core_steps_of_the_callback_goldens_replay() {
    ensure_seeds();
    for (case, steps) in CORE_PREFIXES {
        assert!(
            !pending_for("callbacks", case).is_empty(),
            "callbacks/{case} replays whole now: remove it from CORE_PREFIXES"
        );
        replay_steps("callbacks", case, *steps).unwrap_or_else(|error| panic!("callbacks/{case}: {error}"));
    }
}

const ADMIN: i64 = 1001;

fn user() -> Value {
    json!({"id": ADMIN, "is_bot": false, "first_name": "Admin", "language_code": "ru"})
}

fn text(update_id: i64, message_id: i64, text: &str) -> Value {
    json!({"update_id": update_id, "message": {
        "message_id": message_id, "date": 1787216400,
        "chat": {"id": ADMIN, "type": "private", "first_name": "Admin"}, "from": user(), "text": text
    }})
}

fn tap(update_id: i64, id: &str, message_id: i64, data: &str) -> Value {
    json!({"update_id": update_id, "callback_query": {
        "id": id, "from": user(), "chat_instance": "chat-instance-1001", "data": data,
        "message": {"message_id": message_id, "date": 1787216400,
            "chat": {"id": ADMIN, "type": "private", "first_name": "Admin"},
            "from": {"id": 123456, "is_bot": true, "first_name": "Studio", "username": "studio_test_bot"},
            "text": "✅ Очередь пуста"}
    }})
}

fn methods(calls: &[Value]) -> Vec<String> {
    calls
        .iter()
        .map(|call| call["method"].as_str().unwrap().to_owned())
        .collect()
}

fn texts(calls: &[Value]) -> Vec<String> {
    calls
        .iter()
        .filter_map(|call| call["payload"]["text"].as_str().map(str::to_owned))
        .collect()
}

/// A bot on the default seeded Studio with the main menu sent as message 2.
async fn with_menu() -> Harness {
    let dir = support::repo_root().join("_trash-rust/tmp/bot-goldens/cases/boundary");
    std::fs::create_dir_all(&dir).unwrap();
    let db = seed_database("entry", "boundary-start", "start.db");
    let at = foundation::time::parse_iso_instant("2026-08-20T09:00:00.000Z").unwrap();
    let harness = Harness::new(db, &dir, &json!({}), at).await.unwrap();
    harness.telegram.prepare(&json!({"files": {}}), at.as_second());
    let calls = harness.feed(&[text(1, 1, "☰ Меню")]).await.unwrap();
    assert_eq!(texts(&calls), ["✅ Очередь пуста"]);
    harness
}

#[test]
fn a_redelivered_callback_is_answered_and_not_handled_again() {
    ensure_seeds();
    on_bot_thread(async {
        let harness = with_menu().await;
        let outdated = tap(2, "dup#1", 2, "main-menu/0/0//h0000");
        let first = harness.feed(std::slice::from_ref(&outdated)).await.unwrap();
        assert_eq!(
            methods(&first),
            ["answerCallbackQuery", "sendMessage", "editMessageReplyMarkup"]
        );
        assert_eq!(texts(&first), ["Menu was outdated, try again!"]);
        let again = harness.feed(&[outdated]).await.unwrap();
        assert_eq!(methods(&again), ["answerCallbackQuery"]);
        assert_eq!(again[0]["payload"], json!({"callback_query_id": "dup#1"}));
    });
}

#[test]
fn an_older_tap_on_the_same_button_waiting_its_turn_is_dropped() {
    ensure_seeds();
    on_bot_thread(async {
        let harness = with_menu().await;
        // The chat stays busy with the first tap's keyboard edit while two taps
        // on the same `menu_home` button of the same message arrive.
        harness
            .telegram
            .prepare(&json!({"files": {}, "hold": "editMessageReplyMarkup"}), 1787216400);
        let calls = harness
            .feed(&[
                tap(2, "s#1", 2, "main-menu/0/0//h0000"),
                tap(3, "s#2", 2, "menu_home"),
                tap(4, "s#3", 2, "menu_home"),
            ])
            .await
            .unwrap();
        assert_eq!(
            methods(&calls),
            [
                "answerCallbackQuery",
                "answerCallbackQuery",
                "answerCallbackQuery",
                "sendMessage",
                "editMessageReplyMarkup",
                "editMessageText"
            ]
        );
    });
}

#[test]
fn a_failing_tap_reads_as_the_error_the_typescript_bot_showed() {
    ensure_seeds();
    on_bot_thread(async {
        let harness = with_menu().await;
        let hash = tiny_hash("publishing:ru".chars().map(u32::from));
        let calls = harness
            .feed(&[tap(2, "e#1", 2, &format!("main-menu/zz/0//f{hash}"))])
            .await
            .unwrap();
        assert_eq!(
            texts(&calls),
            ["undefined is not an object (evaluating 'range[row][col]')"]
        );
        let calls = harness
            .feed(&[tap(3, "e#2", 2, &format!("main-menu/-1/0//f{hash}"))])
            .await
            .unwrap();
        assert_eq!(texts(&calls), ["Invalid button position '-1/0'"]);
        let calls = harness.feed(&[tap(4, "e#3", 2, "analytics_post")]).await.unwrap();
        assert_eq!(methods(&calls), ["answerCallbackQuery", "sendMessage"]);
        assert_eq!(texts(&calls), ["Неизвестное действие"]);
    });
}

#[test]
fn a_command_addressed_to_this_bot_runs() {
    ensure_seeds();
    on_bot_thread(async {
        let harness = with_menu().await;
        let mut start = text(2, 3, "/start@studio_test_bot");
        start["message"]["entities"] = json!([{"type": "bot_command", "offset": 0, "length": 22}]);
        let calls = harness.feed(&[start]).await.unwrap();
        assert_eq!(
            texts(&calls),
            ["Кнопка меню всегда останется внизу чата.", "✅ Очередь пуста"]
        );
    });
}
