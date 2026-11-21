//! The Telegram loops as `start_telegram_workers` starts them: every loop the
//! readiness report expects, each recording its heartbeat, and the event loop
//! rung by a journalled event instead of waiting out its poll.

#[allow(dead_code)]
mod support;

use std::rc::Rc;
use std::time::Duration;

use db::BackendDb;
use domain::application::ports::{DomainEventInput, Severity};
use domain::repositories::{record_event, set_event_bell};
use runtime::worker_signal::{WorkerQueue, set_worker_wake};
use runtime::worker_state::{HeartbeatLoops, TELEGRAM_WORKER_NAMES};
use serde_json::json;
use support::{Harness, Scratch, on_bot_thread};

#[test]
fn the_loops_start_and_a_journalled_event_wakes_the_event_loop() {
    on_bot_thread(async {
        let db = BackendDb::open(":memory:").unwrap();
        let now = foundation::time::parse_iso_instant("2026-08-20T09:00:00.000Z").unwrap();
        let harness = Harness::new(Scratch::new("workers"), db, &json!({}), now)
            .await
            .unwrap();
        let bot = harness.bot.clone();
        let loops = HeartbeatLoops::new(Rc::new(bot.clone()), |bot: &bot::Bot| &bot.deps().db);
        let started = bot::workers::start_telegram_workers(&bot, harness.http.clone(), &loops);

        let names: Vec<&str> = started.iter().map(|started| started.name()).collect();
        assert_eq!(
            names,
            [
                "telegram-translations",
                "telegram-albums",
                "telegram-events",
                "telegram-alerts",
                "telegram-daily-backup"
            ],
            "the order startTelegramWorkers returns them in"
        );
        let mut expected = TELEGRAM_WORKER_NAMES.to_vec();
        expected.sort_unstable();
        tokio::time::sleep(Duration::from_millis(50)).await;
        let sqlite = db::unsafe_db(&bot.deps().db);
        let recorded: Vec<String> = sqlite
            .prepare("select name from worker_state order by name")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(recorded, expected, "every loop announces itself in worker_state");
        // The first cycles (the daily backup among them) have run; what follows is the ring alone.
        harness.telegram.take_calls();

        let details = json!({"actor_id": 1001, "title": "Пост", "targets": ["telegram"], "minutes": 5});
        record_event(
            sqlite,
            &*bot.deps().clock,
            &DomainEventInput {
                publication_ref: Some("post:7".into()),
                event_type: "studio.notification.reminder.due".into(),
                severity: Severity::Info,
                target: None,
                message: "Publication reminder: Пост".into(),
                details: details.as_object().cloned(),
                cooldown_seconds: None,
            },
        )
        .unwrap();
        // Well inside the five-second poll.
        tokio::time::sleep(Duration::from_millis(200)).await;
        bot.settled().await;
        let calls = harness.telegram.take_calls();
        let texts: Vec<&str> = calls
            .iter()
            .filter(|call| call["method"] == "sendMessage")
            .filter_map(|call| call["payload"]["text"].as_str())
            .collect();
        assert_eq!(
            texts,
            ["⏰ Через 5 мин. публикация:\n\n🎬 Пост\n\n• Telegram"],
            "the ring delivered the reminder before the poll: {calls:?}"
        );

        set_event_bell(None);
        set_worker_wake(WorkerQueue::TelegramEvents, None);
        for started in &started {
            started.stop().await;
        }
    });
}
