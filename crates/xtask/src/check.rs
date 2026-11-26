//! `cargo xtask check`: the steps CI runs one by one, and the subset the
//! pre-push hook runs (`.githooks/pre-push`). Steps run in order and stop at the
//! first failure.

use std::ffi::OsString;
use std::path::Path;
use std::process::Command;

const STEPS: [&str; 5] = ["language", "fmt", "clippy", "test", "build"];

/// What the images are built from, in release as the Dockerfiles build them
/// (the deploy agent for this host's target; the image builds it for musl).
const RELEASE_PACKAGES: [&str; 5] = ["app", "entrypoint", "ops", "media_processor", "deploy_agent"];

pub fn main(argv: Vec<String>) -> u8 {
    let mut jobs = None;
    let mut selected = Vec::new();
    let mut argv = argv.into_iter();
    while let Some(arg) = argv.next() {
        match arg.strip_prefix("--jobs=") {
            Some(value) => jobs = Some(value.to_owned()),
            None if arg == "--jobs" => jobs = argv.next(),
            None if STEPS.contains(&arg.as_str()) => selected.push(arg),
            None => {
                eprintln!(
                    "usage: cargo xtask check [--jobs N] [STEP...]; steps: {}",
                    STEPS.join(", ")
                );
                return 1;
            }
        }
    }
    if jobs.as_deref().is_some_and(|jobs| jobs.parse::<u16>().is_err()) {
        eprintln!("--jobs takes a number");
        return 1;
    }
    let root = crate::repo_root();
    for step in STEPS
        .into_iter()
        .filter(|step| selected.is_empty() || selected.iter().any(|name| name == step))
    {
        eprintln!("==> {step}");
        if let Err(message) = run_step(step, &root, jobs.as_deref()) {
            eprintln!("{step} failed: {message}");
            return 1;
        }
    }
    0
}

fn run_step(step: &str, root: &Path, jobs: Option<&str>) -> Result<(), String> {
    let cargo = |args: &[&str]| {
        let mut command = Command::new(std::env::var_os("CARGO").unwrap_or_else(|| OsString::from("cargo")));
        command.args(args);
        command
    };
    let jobs: Vec<&str> = jobs.map(|jobs| vec!["-j", jobs]).unwrap_or_default();
    match step {
        "language" => language_gate(root).map(|checked| println!("Language gate passed: {checked} sources allowed.")),
        "fmt" => run(&mut cargo(&["fmt", "--all", "--check"]), root),
        "clippy" => run(
            &mut cargo(
                &[
                    &["clippy", "--workspace", "--all-targets", "--locked"],
                    &jobs[..],
                    &["--", "-D", "warnings"],
                ]
                .concat(),
            ),
            root,
        ),
        "test" => {
            // The tests write their scratch files under _trash-rust/tmp.
            std::fs::create_dir_all(root.join("_trash-rust/tmp")).map_err(|error| error.to_string())?;
            run(
                &mut cargo(&[&["test", "--workspace", "--locked"], &jobs[..]].concat()),
                root,
            )
        }
        "build" => {
            let packages = RELEASE_PACKAGES.iter().flat_map(|package| ["-p", package]);
            let args: Vec<&str> = ["build", "--release", "--locked"]
                .into_iter()
                .chain(jobs)
                .chain(packages)
                .collect();
            run(&mut cargo(&args), root)
        }
        _ => unreachable!("{step} is one of STEPS"),
    }
}

fn run(command: &mut Command, root: &Path) -> Result<(), String> {
    let status = command
        .current_dir(root)
        .status()
        .map_err(|error| format!("cannot start {command:?}: {error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("{command:?} exited with {status}"))
    }
}

/// The repository is Rust; anything in TypeScript, JavaScript, Python or a
/// shell script outside these is a second language creeping back in.
const ALLOWED: [&str; 3] = [
    // It runs on a bare host through `curl … | sh`, before Docker has pulled anything.
    "install.sh",
    // Git runs hooks as executables; each one hands off to gitleaks or `cargo xtask`.
    ".githooks/pre-commit",
    ".githooks/pre-push",
];
const SCRIPT_EXTENSIONS: [&str; 10] = ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "py", "pyi"];
const IGNORED_DIRECTORIES: [&str; 6] = [".git", "node_modules", "target", "_trash-rust", "dist", "coverage"];

/// Fails on every script source outside [`ALLOWED`]. Returns how many allowed
/// sources it saw.
fn language_gate(root: &Path) -> Result<usize, String> {
    let mut violations = Vec::new();
    let mut allowed = 0;
    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        let entries = std::fs::read_dir(&directory).map_err(|error| format!("{}: {error}", directory.display()))?;
        for entry in entries {
            let entry = entry.map_err(|error| error.to_string())?;
            let path = entry.path();
            let kind = entry.file_type().map_err(|error| error.to_string())?;
            if kind.is_dir() {
                if !IGNORED_DIRECTORIES.contains(&entry.file_name().to_string_lossy().as_ref()) {
                    pending.push(path);
                }
                continue;
            }
            if !kind.is_file() {
                continue;
            }
            let relative = path.strip_prefix(root).unwrap_or(&path).to_string_lossy().into_owned();
            if ALLOWED.contains(&relative.as_str()) {
                allowed += 1;
            } else if is_script(&path)? {
                violations.push(relative);
            }
        }
    }
    if violations.is_empty() {
        return Ok(allowed);
    }
    violations.sort();
    Err(format!(
        "script sources outside the allow-list in crates/xtask/src/check.rs:\n{}",
        violations
            .iter()
            .map(|path| format!("- {path}"))
            .collect::<Vec<_>>()
            .join("\n")
    ))
}

fn is_script(path: &Path) -> Result<bool, String> {
    match path.extension().and_then(|extension| extension.to_str()) {
        Some(extension) if SCRIPT_EXTENSIONS.contains(&extension) => Ok(true),
        None | Some("sh") => Ok(shell_shebang(path)?),
        Some(_) => Ok(false),
    }
}

fn shell_shebang(path: &Path) -> Result<bool, String> {
    use std::io::Read;
    let mut head = [0u8; 256];
    let read = std::fs::File::open(path)
        .and_then(|mut file| file.read(&mut head))
        .map_err(|error| format!("{}: {error}", path.display()))?;
    let first_line = String::from_utf8_lossy(&head[..read])
        .lines()
        .next()
        .unwrap_or_default()
        .to_owned();
    Ok(first_line.starts_with("#!") && ["sh", "bash", "zsh"].iter().any(|shell| first_line.contains(shell)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_repository_passes_its_own_language_gate() {
        assert_eq!(language_gate(&crate::repo_root()), Ok(ALLOWED.len()));
    }

    #[test]
    fn script_sources_and_shell_scripts_are_refused() {
        let root = crate::repo_root().join("_trash-rust/tmp/xtask-language-gate");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("tools/node_modules")).unwrap();
        std::fs::create_dir_all(root.join("deploy")).unwrap();
        std::fs::write(root.join("tools/helper.mjs"), "").unwrap();
        std::fs::write(root.join("tools/node_modules/ignored.js"), "").unwrap();
        std::fs::write(root.join("tools/run"), "#!/usr/bin/env bash\n").unwrap();
        std::fs::write(root.join("tools/notes"), "plain text\n").unwrap();
        std::fs::write(root.join("deploy/retry.ts"), "export {};\n").unwrap();
        std::fs::write(root.join("install.sh"), "#!/bin/sh\n").unwrap();
        let refused = language_gate(&root).unwrap_err();
        assert!(
            refused.ends_with(":\n- deploy/retry.ts\n- tools/helper.mjs\n- tools/run"),
            "{refused}"
        );
        std::fs::remove_dir_all(&root).unwrap();
    }
}
