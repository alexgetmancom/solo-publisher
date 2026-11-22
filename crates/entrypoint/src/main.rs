//! `studio-entrypoint`: the container's process under `tini -g`, which runs
//! the Studio and the Stories sidecar.
//!
//! As root it hands the data directories to the runtime user — a bind mount
//! Docker created is owned by root, and the first write to it would fail days
//! later — then drops privileges for good by re-executing itself through
//! `setpriv` (the workspace forbids `unsafe`, and with it a direct
//! `setgroups`/`setgid`/`setuid`). The supplementary groups compose granted
//! (`group_add`, the Bot API download directory) are kept, group 0 is not.
//!
//! As the runtime user it probes the directories with a real write and runs
//! two children: the Studio, whose exit is the container's, and the Stories
//! sidecar (`sidecars/stories`, Bun + mtcute) on loopback, restarted if it
//! dies. The sidecar's bearer token is drawn here for each start and handed to
//! both. Signals reach all three through `tini -g`; this process only waits.

use std::os::unix::process::{CommandExt as _, ExitStatusExt as _};
use std::path::Path;
use std::process::{ExitCode, ExitStatus};
use std::time::{Duration, Instant};

use foundation::config::load_config;
use foundation::logger::{LogLevel, configure_logging, log};
use runtime::data_dirs::{
    check_data_directories_writable, fix_data_directories_ownership, required_data_directories, resolve_unix_user,
    retained_supplementary_groups,
};
use serde_json::json;
use tokio::process::{Child, Command};
use tokio::signal::unix::{SignalKind, signal};

/// uid 1000 in the Bun base image, as in the TypeScript image: the data
/// volumes production already has are owned by it.
const RUNTIME_USER: &str = "bun";
const STUDIO_BINARY: &str = "/app/bin/solo-publisher";
/// The bundle and mtcute's WASM files, which it resolves from the working
/// directory.
const SIDECAR_DIR: &str = "/app/sidecar";
const SIDECAR_PORT: u16 = 8790;
const RESTART_DELAY_MAX: Duration = Duration::from_secs(30);
/// A sidecar that stayed up this long starts its next restart delay over.
const SIDECAR_STABLE: Duration = Duration::from_secs(60);

fn main() -> ExitCode {
    let vars =
        std::env::vars_os().filter_map(|(key, value)| Some((key.into_string().ok()?, value.into_string().ok()?)));
    let config = match load_config(vars) {
        Ok(config) => config,
        Err(error) => {
            log(LogLevel::Error, &error.to_string(), None);
            return ExitCode::FAILURE;
        }
    };
    // `bun /app/entrypoint/config-check.js` (image/config-check.js): the
    // deploy agent's check of a new image's configuration before it replaces
    // the running container. Nothing else runs.
    if std::env::args().nth(1).as_deref() == Some("--check-config") {
        println!("{}", json!({"ok": true}));
        return ExitCode::SUCCESS;
    }
    configure_logging(config.log_level);
    let directories = required_data_directories(&config);
    match status_ids("Uid:") {
        Some(ids) if ids.get(1) == Some(&0) => {
            let error = drop_privileges(&directories);
            log(LogLevel::Error, "cannot drop privileges", Some(json!({"error": error})));
            return ExitCode::FAILURE;
        }
        Some(_) => {}
        None => {
            log(
                LogLevel::Error,
                "cannot read this process's credentials from /proc/self/status",
                None,
            );
            return ExitCode::FAILURE;
        }
    }
    // Probed after the drop: as root every write succeeds.
    let unwritable: Vec<_> = check_data_directories_writable(&directories)
        .into_iter()
        .filter(|check| !check.writable)
        .map(|check| json!({"name": check.name, "path": check.path, "writable": false, "error": check.error}))
        .collect();
    if !unwritable.is_empty() {
        log(
            LogLevel::Error,
            "data directories remain unwritable; check the host bind mount",
            Some(json!({"directories": unwritable})),
        );
    }
    let runtime = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
        Ok(runtime) => runtime,
        Err(error) => {
            log(
                LogLevel::Error,
                "runtime could not start",
                Some(json!({"error": error.to_string()})),
            );
            return ExitCode::FAILURE;
        }
    };
    runtime.block_on(run())
}

/// Fixes ownership, then replaces this process with itself under the runtime
/// user. Returns only on failure.
fn drop_privileges(directories: &[runtime::data_dirs::DataDirectory]) -> String {
    let (uid, gid) = match resolve_unix_user(RUNTIME_USER, Path::new("/etc/passwd")) {
        Ok(ids) => ids,
        Err(error) => return error,
    };
    let applied: Vec<_> = fix_data_directories_ownership(directories, uid, gid)
        .into_iter()
        .filter(|fix| fix.changed || fix.error.is_some())
        .map(|fix| json!({"name": fix.name, "path": fix.path, "changed": fix.changed, "error": fix.error}))
        .collect();
    if !applied.is_empty() {
        log(
            LogLevel::Info,
            "fixed data directory ownership before dropping privileges",
            Some(json!({"fixes": applied})),
        );
    }
    let Some(current) = status_ids("Groups:") else {
        return "cannot read supplementary groups from /proc/self/status".into();
    };
    let groups: Vec<String> = retained_supplementary_groups(gid, &current)
        .iter()
        .map(u32::to_string)
        .collect();
    let me = match std::env::current_exe() {
        Ok(path) => path,
        Err(error) => return format!("cannot locate this executable: {error}"),
    };
    // setpriv sets the real and effective ids; the exec that follows copies
    // them into the saved ids and clears root's capabilities, so the drop
    // cannot be undone.
    let error = std::process::Command::new("setpriv")
        .arg(format!("--reuid={uid}"))
        .arg(format!("--regid={gid}"))
        .arg(format!("--groups={}", groups.join(",")))
        .arg("--")
        .arg(me)
        .exec();
    format!("setpriv: {error}")
}

/// A numeric line of `/proc/self/status`: `Uid:` is real, effective, saved,
/// filesystem; `Groups:` the supplementary list.
fn status_ids(field: &str) -> Option<Vec<u32>> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    let line = status.lines().find_map(|line| line.strip_prefix(field))?;
    line.split_whitespace().map(|id| id.parse().ok()).collect()
}

/// 32 bytes from the kernel, hex: the sidecar's bearer token for this start.
fn sidecar_token() -> Result<String, getrandom::Error> {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes)?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// Starts the sidecar; a failure is logged and retried by the loop.
fn start_sidecar(sidecar: &dyn Fn() -> Command) -> Option<(Child, Instant)> {
    // Without tini, a Studio that exits must not leave the sidecar behind.
    match sidecar().kill_on_drop(true).spawn() {
        Ok(child) => Some((child, Instant::now())),
        Err(error) => {
            log(
                LogLevel::Error,
                "stories sidecar could not start",
                Some(json!({"error": error.to_string()})),
            );
            None
        }
    }
}

/// The shell's convention: a child killed by a signal reads as 128 + signal.
fn exit_code(status: ExitStatus) -> u8 {
    status
        .code()
        .or_else(|| status.signal().map(|signal| 128 + signal))
        .map_or(1, |code| u8::try_from(code).unwrap_or(1))
}

/// A sidecar that exited 0 or on SIGTERM/SIGINT was told to stop.
fn stopped_on_request(status: ExitStatus) -> bool {
    status.code() == Some(0) || matches!(status.signal(), Some(2 | 15))
}

/// Draws the token and runs the two processes of this image.
async fn run() -> ExitCode {
    let token = match sidecar_token() {
        Ok(token) => token,
        Err(error) => {
            log(
                LogLevel::Error,
                "cannot draw the sidecar token",
                Some(json!({"error": error.to_string()})),
            );
            return ExitCode::FAILURE;
        }
    };
    let mut studio = Command::new(STUDIO_BINARY);
    studio
        .env("STORIES_SIDECAR_URL", format!("http://127.0.0.1:{SIDECAR_PORT}"))
        .env("STORIES_SIDECAR_TOKEN", &token);
    let sidecar = || {
        let mut sidecar = Command::new("bun");
        sidecar
            .arg("main.js")
            .current_dir(SIDECAR_DIR)
            .env("STORIES_SIDECAR_TOKEN", &token)
            .env("STORIES_SIDECAR_HOST", "127.0.0.1")
            .env("STORIES_SIDECAR_PORT", SIDECAR_PORT.to_string());
        sidecar
    };
    ExitCode::from(supervise(studio, &sidecar, Duration::from_secs(1)).await)
}

/// Runs the Studio until it exits and returns its exit code; keeps the
/// sidecar up meanwhile, restarting it `first_delay` after a crash, doubling
/// to 30 s.
async fn supervise(mut studio: Command, sidecar: &dyn Fn() -> Command, first_delay: Duration) -> u8 {
    // Installing the handlers is what keeps SIGTERM from killing this process
    // before the Studio has shut down; tini -g delivers it to the children too.
    let (Ok(mut terminate), Ok(mut interrupt)) = (signal(SignalKind::terminate()), signal(SignalKind::interrupt()))
    else {
        log(LogLevel::Error, "cannot install signal handlers", None);
        return 1;
    };
    let mut studio = match studio.spawn() {
        Ok(child) => child,
        Err(error) => {
            log(
                LogLevel::Error,
                "studio could not start",
                Some(json!({"error": error.to_string()})),
            );
            return 1;
        }
    };
    let mut stopping = false;
    let mut delay = first_delay;
    let mut sidecar_child = start_sidecar(sidecar);
    loop {
        tokio::select! {
            biased;
            _ = terminate.recv() => stopping = true,
            _ = interrupt.recv() => stopping = true,
            status = studio.wait() => return status.map_or(1, exit_code),
            status = async { sidecar_child.as_mut().map(|(child, _)| child).unwrap().wait().await }, if sidecar_child.is_some() => {
                let lived = sidecar_child.take().map_or(Duration::ZERO, |(_, started)| started.elapsed());
                if stopping || status.as_ref().is_ok_and(|status| stopped_on_request(*status)) {
                    // Nothing to restart; the Studio's exit is the container's.
                    return studio.wait().await.map_or(1, exit_code);
                }
                if lived >= SIDECAR_STABLE {
                    delay = first_delay;
                }
                let status = status.map_or_else(|error| error.to_string(), |status| status.to_string());
                log(
                    LogLevel::Warn,
                    "stories sidecar exited; restarting",
                    Some(json!({"status": status, "restartInMs": delay.as_millis() as u64})),
                );
            }
            _ = tokio::time::sleep(delay), if sidecar_child.is_none() && !stopping => {
                delay = (delay * 2).min(RESTART_DELAY_MAX);
                sidecar_child = start_sidecar(sidecar);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::MetadataExt as _;

    use super::*;

    #[test]
    fn a_signalled_child_reads_as_128_plus_the_signal() {
        assert_eq!(exit_code(ExitStatus::from_raw(15)), 143);
        assert_eq!(exit_code(ExitStatus::from_raw(3 << 8)), 3);
        assert!(stopped_on_request(ExitStatus::from_raw(15)));
        assert!(stopped_on_request(ExitStatus::from_raw(0)));
        assert!(!stopped_on_request(ExitStatus::from_raw(1 << 8)));
        assert!(!stopped_on_request(ExitStatus::from_raw(9)));
    }

    #[test]
    fn the_status_file_names_this_process() {
        let uid = status_ids("Uid:").unwrap();
        assert_eq!(uid.len(), 4);
        let me = std::fs::metadata("/proc/self").unwrap().uid();
        assert_eq!(uid[1], me);
        assert!(status_ids("Groups:").is_some());
    }

    fn sh(script: &str) -> Command {
        let mut command = Command::new("sh");
        command.arg("-c").arg(script);
        command
    }

    fn block_on<T>(work: impl Future<Output = T>) -> T {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(work)
    }

    #[test]
    fn the_studio_exit_is_the_containers_and_a_crashed_sidecar_comes_back() {
        let starts = std::cell::Cell::new(0);
        let sidecar = || {
            starts.set(starts.get() + 1);
            sh("exit 1")
        };
        let code = block_on(supervise(sh("sleep 1; exit 3"), &sidecar, Duration::from_millis(50)));
        assert_eq!(code, 3);
        assert!(starts.get() >= 3, "sidecar started {} times", starts.get());
    }

    #[test]
    fn a_sidecar_that_stopped_on_request_is_not_restarted() {
        let starts = std::cell::Cell::new(0);
        let sidecar = || {
            starts.set(starts.get() + 1);
            sh("exit 0")
        };
        let code = block_on(supervise(
            sh("sleep 0.5; kill -TERM $$"),
            &sidecar,
            Duration::from_millis(10),
        ));
        assert_eq!(code, 143);
        assert_eq!(starts.get(), 1);
    }

    #[test]
    fn the_sidecar_token_is_64_hex_characters() {
        let token = sidecar_token().unwrap();
        assert_eq!(token.len(), 64);
        assert!(token.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(token, sidecar_token().unwrap());
    }
}
