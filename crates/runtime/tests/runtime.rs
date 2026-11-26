//! What the recorded fixtures cannot show: processes killed on time, timers,
//! the doorbells, the transport seam and the heartbeat loop over a database.

use std::cell::{Cell, RefCell};
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::time::Duration;

use db::BackendDb;
use foundation::config::load_config;
use providers::external::telegram_files::{MaterializeOptions, TelegramFileSource, materialize_telegram_file};
use runtime::data_dirs::{
    check_data_directories_writable, required_data_directories, resolve_unix_user, retained_supplementary_groups,
};
use runtime::ffmpeg::{run_ffmpeg, run_ffmpeg_capture};
use runtime::http::{
    ExternalError, Fut, HttpClient, HttpRequest, HttpResponse, ResponseBody, Transport, TransportFailure,
};
use runtime::job_heartbeat::with_job_heartbeat;
use runtime::scheduler::{LoopHooks, start_loop};
use runtime::timeout::{OperationTimeoutError, with_timeout};
use runtime::worker_signal::{WorkerQueue, ring_worker, ring_worker_after, set_worker_wake};
use runtime::worker_state::HeartbeatLoops;
use serde_json::Value;

/// This process's own directory under `_trash-rust/tmp/runtime-tests/`,
/// removed when the test is done with it.
struct Scratch(PathBuf);

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

impl std::ops::Deref for Scratch {
    type Target = Path;
    fn deref(&self) -> &Path {
        &self.0
    }
}

fn scratch(label: &str) -> Scratch {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../_trash-rust/tmp/runtime-tests")
        .join(format!("{}-{label}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    Scratch(dir.canonicalize().unwrap())
}

async fn settle() {
    for _ in 0..10 {
        tokio::task::yield_now().await;
    }
}

// ---- ffmpeg ----------------------------------------------------------------------

#[tokio::test]
async fn ffmpeg_outliving_its_timeout_is_killed() {
    let started = std::time::Instant::now();
    let error = run_ffmpeg(
        &["-re", "-f", "lavfi", "-i", "anullsrc", "-t", "30", "-f", "null", "-"],
        Duration::from_secs(1),
    )
    .await
    .unwrap_err();
    assert_eq!(error.0, "media_processing_timeout: ffmpeg exceeded 1s");
    assert!(started.elapsed() < Duration::from_secs(10));
}

#[tokio::test]
async fn ffmpeg_failures_and_captures() {
    let error = run_ffmpeg(
        &["-hide_banner", "-i", "/nonexistent/input.mp4"],
        Duration::from_secs(30),
    )
    .await
    .unwrap_err();
    assert!(
        error.0.starts_with("media_processing_failed: ffmpeg exit ") && error.0.contains("No such file or directory"),
        "{error}"
    );
    let pixels = run_ffmpeg_capture(
        &[
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=c=red:s=2x2",
            "-frames:v",
            "1",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "-",
        ],
        Duration::from_secs(30),
    )
    .await
    .unwrap();
    assert_eq!(pixels.len(), 2 * 2 * 3);
    assert!(
        pixels.chunks(3).all(|pixel| pixel[0] > 250 && pixel[1..] == [0, 0]),
        "{pixels:?}"
    );
}

// ---- timers ----------------------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn timeouts_and_job_heartbeats() {
    let slow = with_timeout(
        tokio::time::sleep(Duration::from_secs(5)),
        Duration::from_secs(1),
        "too slow",
    )
    .await;
    assert_eq!(slow, Err(OperationTimeoutError("too slow".into())));
    assert_eq!(with_timeout(async { 7 }, Duration::from_secs(1), "x").await, Ok(7));

    let beats = Cell::new(0);
    let outcome = with_job_heartbeat(
        Duration::from_secs(100),
        || {
            beats.set(beats.get() + 1);
            Err::<(), _>("a failed beat is dropped")
        },
        async {
            tokio::time::sleep(Duration::from_secs(250)).await;
            "done"
        },
    )
    .await;
    assert_eq!((outcome, beats.get()), ("done", 2));
}

#[tokio::test(start_paused = true)]
async fn doorbells_collapse_and_defer() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let wakes = Rc::new(Cell::new(0));
            let counted = Rc::clone(&wakes);
            set_worker_wake(
                WorkerQueue::Publish,
                Some(Rc::new(move || counted.set(counted.get() + 1))),
            );
            ring_worker(WorkerQueue::Publish);
            ring_worker(WorkerQueue::Publish);
            ring_worker(WorkerQueue::TelegramEvents);
            assert_eq!(wakes.get(), 0, "a ring never wakes in place");
            settle().await;
            assert_eq!(wakes.get(), 1);
            ring_worker_after(WorkerQueue::Publish, Duration::from_secs(30));
            tokio::time::sleep(Duration::from_secs(29)).await;
            assert_eq!(wakes.get(), 1);
            tokio::time::sleep(Duration::from_secs(2)).await;
            assert_eq!(wakes.get(), 2);
            set_worker_wake(WorkerQueue::Publish, None);
            ring_worker(WorkerQueue::Publish);
            settle().await;
            assert_eq!(wakes.get(), 2);
        })
        .await;
}

#[tokio::test(start_paused = true)]
async fn a_loop_ticks_survives_a_panic_and_beats() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let events = Rc::new(RefCell::new(Vec::<String>::new()));
            let cycle = Rc::new(Cell::new(0));
            let task = {
                let cycle = Rc::clone(&cycle);
                move || {
                    cycle.set(cycle.get() + 1);
                    let number = cycle.get();
                    async move {
                        assert!(number != 2, "cycle two panics");
                        Ok::<(), String>(())
                    }
                }
            };
            let hooks = LoopHooks {
                on_heartbeat: Some(Box::new({
                    let events = Rc::clone(&events);
                    move || {
                        events.borrow_mut().push("beat".into());
                        Ok(())
                    }
                })),
                heartbeat_interval: Some(Duration::from_secs(60)),
                on_finish: Some(Box::new({
                    let events = Rc::clone(&events);
                    move |error: Option<&str>| {
                        events.borrow_mut().push(format!("finish {}", error.unwrap_or("ok")));
                        Ok(())
                    }
                })),
                ..LoopHooks::default()
            };
            let scheduled = start_loop("ticker", Duration::from_secs(25), task, hooks);
            tokio::time::sleep(Duration::from_secs(80)).await;
            scheduled.stop().await;
            tokio::time::sleep(Duration::from_secs(100)).await;
            assert_eq!(
                *events.borrow(),
                ["finish ok", "finish cycle two panics", "finish ok", "beat", "finish ok"]
            );
        })
        .await;
}

#[tokio::test(start_paused = true)]
async fn heartbeat_loops_report_through_the_database() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let db = Rc::new(BackendDb::open(":memory:").unwrap());
            let flushed = Rc::new(Cell::new(0));
            let loops = HeartbeatLoops::new(Rc::clone(&db), |db| db).on_heartbeat({
                let flushed = Rc::clone(&flushed);
                move |_| flushed.set(flushed.get() + 1)
            });
            let failing = Rc::new(Cell::new(true));
            let scheduled = loops.start("queue", Duration::from_secs(5), {
                let failing = Rc::clone(&failing);
                move || {
                    let fail = failing.get();
                    async move { if fail { Err("database is locked") } else { Ok(()) } }
                }
            });
            settle().await;
            let state = |db: &BackendDb| -> Value {
                let text: String = db::unsafe_db(db)
                    .query_row("SELECT state_json FROM worker_state WHERE name = 'queue'", [], |row| {
                        row.get(0)
                    })
                    .unwrap();
                serde_json::from_str(&text).unwrap()
            };
            assert_eq!(state(&db)["phase"], "failed");
            assert_eq!(state(&db)["scheduler_error"], "database is locked");
            failing.set(false);
            tokio::time::sleep(Duration::from_secs(6)).await;
            assert_eq!(state(&db)["phase"], "running");
            assert_eq!(state(&db)["scheduler_error"], Value::Null);
            assert_eq!(flushed.get(), 0);
            tokio::time::sleep(Duration::from_secs(60)).await;
            assert_eq!(flushed.get(), 1);
            assert_eq!(state(&db)["heartbeat_interval_ms"], 60_000);
            scheduled.stop().await;
        })
        .await;
}

// ---- the transport seam -------------------------------------------------------------

/// A body that breaks off after its first chunk.
struct Broken(bool);

impl ResponseBody for Broken {
    fn next_chunk(&mut self) -> Fut<'_, Result<Option<Vec<u8>>, TransportFailure>> {
        let first = std::mem::replace(&mut self.0, false);
        Box::pin(async move {
            if first {
                Ok(Some(b"{\"partial\":".to_vec()))
            } else {
                Err(TransportFailure {
                    message: "connection reset".into(),
                    timed_out: false,
                })
            }
        })
    }
}

/// Answers `ok` for `getFile`, then whatever `download` says.
struct Telegram {
    download: Box<dyn Fn() -> Result<HttpResponse, TransportFailure>>,
}

impl Transport for Telegram {
    fn send(&self, request: HttpRequest) -> Fut<'_, Result<HttpResponse, TransportFailure>> {
        let answer = if request.url.ends_with("/getFile") {
            Ok(HttpResponse::buffered(
                200,
                vec![],
                r#"{"ok":true,"result":{"file_path":"videos/a.mp4"}}"#,
            ))
        } else if request.url.contains("/broken?") {
            Ok(HttpResponse {
                status: 200,
                headers: Default::default(),
                body: Box::new(Broken(true)),
            })
        } else {
            (self.download)()
        };
        Box::pin(async move { answer })
    }
}

#[tokio::test]
async fn lost_bodies_are_transport_errors_and_downloads_land_on_disk() {
    let ok = || Ok(HttpResponse::buffered(200, vec![], "bytes"));
    let client = HttpClient::new(Rc::new(Telegram { download: Box::new(ok) }));
    let error = client
        .request_json(HttpRequest::get("https://api.example/broken?token=fixture"))
        .await
        .unwrap_err();
    let ExternalError::Transport(error) = error else {
        panic!("{error:?}")
    };
    assert_eq!(
        error.message,
        "GET https://api.example/broken?token=%5BREDACTED%5D failed while reading the HTTP response"
    );
    assert_eq!(error.cause, "connection reset");

    let dir = scratch("telegram-download");
    let config = load_config([
        ("DATA_DIR", dir.to_str().unwrap()),
        ("CONTROLLER_BOT_TOKEN", "123456789:fixture"),
    ])
    .unwrap();
    let placed = materialize_telegram_file(
        &client,
        &config,
        TelegramFileSource::FileId("F"),
        MaterializeOptions::default(),
    )
    .await
    .unwrap();
    assert!(placed.temporary);
    assert!(placed.path.starts_with(dir.join("video-media/.incoming")), "{placed:?}");
    assert_eq!(placed.path.extension().unwrap(), "mp4");
    assert_eq!(std::fs::read(&placed.path).unwrap(), b"bytes");

    let timed_out = HttpClient::new(Rc::new(Telegram {
        download: Box::new(|| {
            Err(TransportFailure {
                message: "operation timed out".into(),
                timed_out: true,
            })
        }),
    }));
    let error = materialize_telegram_file(
        &timed_out,
        &config,
        TelegramFileSource::FilePath("videos/a.mp4"),
        MaterializeOptions::default(),
    )
    .await
    .unwrap_err();
    assert_eq!(error.to_string(), "Telegram file download timed out after 300s.");
}

// ---- data directories and identity --------------------------------------------------

#[test]
fn data_directories_are_listed_once_and_probed() {
    let dir = scratch("data-dirs");
    let mut config = load_config([("DATA_DIR", dir.to_str().unwrap())]).unwrap();
    config.media_cache_dir = dir.join("video-media/../video-media/");
    let directories = required_data_directories(&config);
    let names: Vec<&str> = directories.iter().map(|directory| directory.name).collect();
    assert_eq!(
        names,
        [
            "DATA_DIR",
            "STUDIO_MEDIA_DIR",
            "STORY_CARD_DIR",
            "REMOTE_MEDIA_PATH",
            "SITE_PUBLIC_DIR"
        ]
    );
    let checks = check_data_directories_writable(&directories);
    assert!(
        checks.iter().all(|check| check.writable && check.error.is_none()),
        "{checks:?}"
    );
    assert_eq!(std::fs::read_dir(&*dir).unwrap().count(), 4, "probes are removed");

    let passwd = dir.join("passwd");
    std::fs::write(
        &passwd,
        "root:x:0:0::/root:/bin/sh\nstudio:x:1000:1000::/home/studio:/bin/sh\nodd:x:a:1\n",
    )
    .unwrap();
    assert_eq!(resolve_unix_user("studio", &passwd), Ok((1000, 1000)));
    assert_eq!(
        resolve_unix_user("odd", &passwd),
        Err(format!("Unix user not found in {}: odd", passwd.display()))
    );
    assert_eq!(
        retained_supplementary_groups(1000, &[0, 1, 1000, 991, 1]),
        [1000, 1, 991]
    );
    assert!(runtime::git::git_revision(Path::new(env!("CARGO_MANIFEST_DIR"))).is_some());
}
