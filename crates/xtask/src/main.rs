//! Developer and CI tooling, run as `cargo xtask <command>` (the alias is in
//! `.cargo/config.toml`). Nothing here is part of the Studio or its image.

use std::path::{Path, PathBuf};
use std::process::{ExitCode, ExitStatus};

mod check;
mod image_smoke;
mod ops_prod;

const USAGE: &str = "usage: cargo xtask <command>

  check [--jobs N] [STEP...]   the gate before every push, every step by default:
                               language, typescript, fmt, clippy, test, build
  ops-prod [--as alex|maru] <command> [arguments]
  ops-prod [--as alex|maru] logs [--since 6h] [--grep TEXT] [--lines N]
                               an operations command in a production Studio, over ssh
  image-smoke <image>          inspect a built Studio image";

fn main() -> ExitCode {
    let mut argv = std::env::args().skip(1);
    let command = argv.next();
    let rest: Vec<String> = argv.collect();
    let code = match command.as_deref() {
        Some("check") => check::main(rest),
        Some("ops-prod") => ops_prod::main(rest),
        Some("image-smoke") => image_smoke::main(rest),
        Some("help" | "--help" | "-h") => {
            println!("{USAGE}");
            0
        }
        _ => {
            eprintln!("{USAGE}");
            1
        }
    };
    ExitCode::from(code)
}

/// The repository root, whatever directory cargo was started from.
fn repo_root() -> PathBuf {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    manifest.ancestors().nth(2).unwrap_or(manifest).to_path_buf()
}

/// A child's status as this process's own exit code; a signal reads as 128 + its number, as in a shell.
fn exit_code(status: ExitStatus) -> u8 {
    use std::os::unix::process::ExitStatusExt;
    match (status.code(), status.signal()) {
        (Some(code), _) => u8::try_from(code).unwrap_or(1),
        (None, Some(signal)) => u8::try_from(128 + signal).unwrap_or(1),
        (None, None) => 1,
    }
}
