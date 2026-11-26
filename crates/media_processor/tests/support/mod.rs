//! A stand-in for ffprobe and ffmpeg, and a work directory per test.

#![allow(dead_code)]

use std::ops::{Deref, DerefMut};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use media_processor::{Commands, Finished, Options, Processor, Running};
use tokio::sync::Semaphore;

pub(crate) const TOKEN: &str = "media-processor-token";
pub(crate) const KEY: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

/// A work directory, removed with the test.
pub(crate) struct Work(Options);

impl Deref for Work {
    type Target = Options;
    fn deref(&self) -> &Options {
        &self.0
    }
}

impl DerefMut for Work {
    fn deref_mut(&mut self) -> &mut Options {
        &mut self.0
    }
}

impl Drop for Work {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0.work_dir);
    }
}

pub(crate) fn work(name: &str) -> Work {
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    let work_dir: PathBuf = std::env::temp_dir().join(format!(
        "media-processor-{name}-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = std::fs::remove_dir_all(&work_dir);
    Work(Options {
        token: TOKEN.into(),
        work_dir,
        max_bytes: 1 << 30,
        timeout_seconds: 900,
        cache_ttl_seconds: 86_400,
        retry_after_seconds: 60,
        revision: "abc123".into(),
        vaapi_device: PathBuf::from("/definitely/missing"),
    })
}

/// ffprobe's answer for a 9:16 video of `duration` seconds.
pub(crate) fn vertical_probe(duration: f64) -> String {
    format!(
        r#"{{"format":{{"duration":"{duration}"}},"streams":[{{"codec_type":"video","width":1080,"height":1920}}]}}"#
    )
}

/// ffprobe answers `probe` with `probe_exit`; ffmpeg writes 64 bytes to every
/// argument naming a `.part` file (unless `write_outputs` is off) and exits
/// with `ffmpeg_exit`, after the hold is released if one was set.
#[derive(Clone)]
pub(crate) struct Fake {
    pub probe: String,
    pub probe_exit: i32,
    pub ffmpeg_exit: i32,
    pub ffmpeg_stderr: String,
    pub write_outputs: bool,
    /// What it was asked to do; fresh in every `Fake::default()`.
    pub seen: Arc<Seen>,
}

#[derive(Default)]
pub(crate) struct Seen {
    commands: Mutex<Vec<Vec<String>>>,
    sources: Mutex<Vec<Vec<u8>>>,
    hold: Mutex<Option<Arc<Semaphore>>>,
    running: AtomicUsize,
    peak: AtomicUsize,
}

impl Default for Fake {
    fn default() -> Self {
        Self {
            probe: "{}".into(),
            probe_exit: 0,
            ffmpeg_exit: 0,
            ffmpeg_stderr: String::new(),
            write_outputs: true,
            seen: Arc::default(),
        }
    }
}

impl Fake {
    pub(crate) fn processor(&self, name: &str) -> (Processor, Work) {
        let work = work(name);
        (Processor::new(work.clone(), self.clone()).unwrap(), work)
    }

    /// Every command run so far, program first.
    pub(crate) fn commands(&self) -> Vec<Vec<String>> {
        self.seen.commands.lock().unwrap().clone()
    }

    /// The source file ffmpeg was given, read when it started.
    pub(crate) fn sources(&self) -> Vec<Vec<u8>> {
        self.seen.sources.lock().unwrap().clone()
    }

    pub(crate) fn ffmpeg_args(&self) -> Vec<String> {
        self.commands()
            .into_iter()
            .find(|command| command[0] == "ffmpeg")
            .unwrap_or_default()
    }

    pub(crate) fn ffmpeg_count(&self) -> usize {
        self.commands().iter().filter(|command| command[0] == "ffmpeg").count()
    }

    pub(crate) fn peak_ffmpeg(&self) -> usize {
        self.seen.peak.load(Ordering::SeqCst)
    }

    /// ffmpeg runs until [`Fake::release_ffmpeg`].
    pub(crate) fn hold_ffmpeg(&self) {
        *self.seen.hold.lock().unwrap() = Some(Arc::new(Semaphore::new(0)));
    }

    pub(crate) fn release_ffmpeg(&self) {
        if let Some(hold) = self.seen.hold.lock().unwrap().as_ref() {
            hold.add_permits(Semaphore::MAX_PERMITS);
        }
    }

    pub(crate) async fn wait_for_ffmpeg(&self, count: usize) {
        for _ in 0..2000 {
            if self.ffmpeg_count() >= count {
                return;
            }
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
        panic!("ffmpeg never started");
    }
}

impl Commands for Fake {
    fn run(&self, program: &'static str, args: Vec<String>) -> Running {
        let mut command = vec![program.to_owned()];
        command.extend(args.iter().cloned());
        self.seen.commands.lock().unwrap().push(command);
        if program == "ffprobe" {
            let finished = Finished {
                code: self.probe_exit,
                stdout: self.probe.clone().into_bytes(),
                stderr: Vec::new(),
            };
            return Box::pin(async move { Ok(finished) });
        }
        if let Some(input) = args.iter().position(|arg| arg == "-i").map(|at| &args[at + 1]) {
            self.seen.sources.lock().unwrap().push(std::fs::read(input).unwrap());
        }
        let seen = Arc::clone(&self.seen);
        let hold = seen.hold.lock().unwrap().clone();
        let running = seen.running.fetch_add(1, Ordering::SeqCst) + 1;
        seen.peak.fetch_max(running, Ordering::SeqCst);
        let finished = Finished {
            code: self.ffmpeg_exit,
            stdout: Vec::new(),
            stderr: self.ffmpeg_stderr.clone().into_bytes(),
        };
        let outputs: Vec<String> = if self.write_outputs {
            args.iter().filter(|arg| arg.contains(".part")).cloned().collect()
        } else {
            Vec::new()
        };
        Box::pin(async move {
            /// Counts the render as finished however it ends, a timeout included.
            struct Running(Arc<Seen>);
            impl Drop for Running {
                fn drop(&mut self) {
                    self.0.running.fetch_sub(1, Ordering::SeqCst);
                }
            }
            let _running = Running(seen);
            if let Some(hold) = hold {
                hold.acquire().await.unwrap().forget();
            }
            for output in outputs {
                std::fs::write(output, [1u8; 64])?;
            }
            Ok(finished)
        })
    }
}
