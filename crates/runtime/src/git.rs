//! The revision the process runs.

use std::path::Path;
use std::process::{Command, Stdio};

use foundation::js;

/// The revision this process runs: `GIT_REVISION` when the build injected one,
/// else what git says about `cwd`.
pub fn git_revision(cwd: &Path) -> Option<String> {
    let injected = std::env::var("GIT_REVISION").unwrap_or_default();
    let injected = js::trim(&injected);
    if !injected.is_empty() && injected != "unknown" {
        return Some(injected.to_owned());
    }
    let output = Command::new("git")
        .args(["rev-parse", "--short", "HEAD"])
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| js::trim(&String::from_utf8_lossy(&output.stdout)).to_owned())
}
