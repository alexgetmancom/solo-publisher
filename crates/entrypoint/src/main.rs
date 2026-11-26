//! `studio-entrypoint`: the container's process under `tini -g`, which runs
//! the Studio.
//!
//! As root it hands the data directories to the runtime user — a bind mount
//! Docker created is owned by root, and the first write to it would fail days
//! later — then drops privileges for good by re-executing itself through
//! `setpriv` (the workspace forbids `unsafe`, and with it a direct
//! `setgroups`/`setgid`/`setuid`). The supplementary groups compose granted
//! (`group_add`, the Bot API download directory) are kept, group 0 is not.
//!
//! As the runtime user it probes the directories with a real write and
//! replaces itself with the Studio, which then receives the container's
//! signals from `tini -g` directly.
//!
//! Two arguments run something else instead, and nothing more: the deploy
//! agent's `--check-config` and the compose healthcheck's `--ready`.

use std::io::{BufRead as _, BufReader, Write as _};
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::os::unix::process::CommandExt as _;
use std::path::Path;
use std::process::ExitCode;
use std::time::Duration;

use foundation::config::{load_config, process_env};
use foundation::logger::{LogLevel, configure_logging, log};
use runtime::data_dirs::{
    check_data_directories_writable, fix_data_directories_ownership, required_data_directories, resolve_unix_user,
    retained_supplementary_groups,
};
use serde_json::json;

/// uid 1000, which the image creates: the data volumes production already
/// has are owned by it.
const RUNTIME_USER: &str = "studio";
const STUDIO_BINARY: &str = "/app/bin/solo-publisher";
/// Under the healthcheck's own 5 s, so a Studio that hangs fails with a reason.
const READY_TIMEOUT: Duration = Duration::from_secs(4);

fn main() -> ExitCode {
    let config = match load_config(process_env()) {
        Ok(config) => config,
        Err(error) => {
            log(LogLevel::Error, &error.to_string(), None);
            return ExitCode::FAILURE;
        }
    };
    match std::env::args().nth(1).as_deref() {
        None => {}
        // The deploy agent's check of a new image's configuration before it
        // replaces the running container (`--entrypoint
        // /app/bin/studio-entrypoint … --check-config`).
        Some("--check-config") => {
            println!("{}", json!({"ok": true}));
            return ExitCode::SUCCESS;
        }
        // The compose healthcheck, inside the running container.
        Some("--ready") => {
            return match probe_ready(config.port) {
                Ok(()) => ExitCode::SUCCESS,
                Err(error) => {
                    log(LogLevel::Error, "studio is not ready", Some(json!({"error": error})));
                    ExitCode::FAILURE
                }
            };
        }
        // Refused rather than ignored: as root, ignoring it would start a
        // second Studio beside the running one.
        Some(other) => {
            log(LogLevel::Error, "unknown argument", Some(json!({"argument": other})));
            return ExitCode::FAILURE;
        }
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
    let error = std::process::Command::new(STUDIO_BINARY).exec();
    log(
        LogLevel::Error,
        "studio could not start",
        Some(json!({"error": error.to_string()})),
    );
    ExitCode::FAILURE
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

/// `GET /readyz` from the Studio on `port` over loopback, ready on a 2xx. It
/// listens on every address (`BIND_HOST=0.0.0.0` in both compose files), so
/// loopback reaches it.
fn probe_ready(port: u64) -> Result<(), String> {
    let port = u16::try_from(port).map_err(|_| format!("PORT {port} is not a TCP port"))?;
    let address = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let failed = |error: std::io::Error| format!("{address}: {error}");
    let mut stream = TcpStream::connect_timeout(&address, READY_TIMEOUT).map_err(failed)?;
    stream.set_read_timeout(Some(READY_TIMEOUT)).map_err(failed)?;
    stream.set_write_timeout(Some(READY_TIMEOUT)).map_err(failed)?;
    write!(
        stream,
        "GET /readyz HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n\r\n"
    )
    .map_err(failed)?;
    let mut status_line = String::new();
    BufReader::new(stream).read_line(&mut status_line).map_err(failed)?;
    ready_status(&status_line)
}

/// The verdict on a response's status line: ready on a 2xx.
fn ready_status(status_line: &str) -> Result<(), String> {
    match status_line.split(' ').nth(1).map(str::parse::<u16>) {
        Some(Ok(status)) if (200..300).contains(&status) => Ok(()),
        Some(Ok(status)) => Err(format!("/readyz answered {status}")),
        _ => Err(format!("/readyz answered {:?}", status_line.trim_end())),
    }
}

/// A numeric line of `/proc/self/status`: `Uid:` is real, effective, saved,
/// filesystem; `Groups:` the supplementary list.
fn status_ids(field: &str) -> Option<Vec<u32>> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    let line = status.lines().find_map(|line| line.strip_prefix(field))?;
    line.split_whitespace().map(|id| id.parse().ok()).collect()
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::MetadataExt as _;

    use super::*;

    #[test]
    fn ready_is_a_2xx() {
        assert_eq!(ready_status("HTTP/1.1 200 OK\r\n"), Ok(()));
        assert_eq!(ready_status("HTTP/1.1 204 No Content\r\n"), Ok(()));
        assert_eq!(
            ready_status("HTTP/1.1 503 Service Unavailable\r\n"),
            Err("/readyz answered 503".into())
        );
        assert_eq!(ready_status(""), Err("/readyz answered \"\"".into()));
    }

    #[test]
    fn the_status_file_names_this_process() {
        let uid = status_ids("Uid:").unwrap();
        assert_eq!(uid.len(), 4);
        let me = std::fs::metadata("/proc/self").unwrap().uid();
        assert_eq!(uid[1], me);
        assert!(status_ids("Groups:").is_some());
    }
}
