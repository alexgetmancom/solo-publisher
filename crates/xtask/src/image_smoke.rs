//! `cargo xtask image-smoke <image>`: inspects a built Studio image the way
//! production reaches it, without a bot token and so without starting a Studio:
//!
//! - what the image carries: the three binaries, the Story-card assets, the two
//!   Bun shims, ffmpeg, Bun and setpriv;
//! - the entrypoint as root: it fixes the data directory's ownership, drops to
//!   uid 1000 and starts the Studio, which then refuses for want of a token —
//!   proof that the fix, the drop and the probe all ran first;
//! - the deploy agent's configuration check (`bun /app/entrypoint/config-check.js`),
//!   accepting a valid configuration and refusing an invalid one;
//! - the operations CLI, both as `cargo xtask ops-prod` runs it (`/app/bin/ops`
//!   as uid 1000) and as a self-hosted Studio does (`bun /app/ops/cli.js`).

use std::process::Command;

const REFUSAL: &str = "Telegram bot token is not configured";

pub fn main(argv: Vec<String>) -> u8 {
    let [image] = argv.as_slice() else {
        eprintln!("usage: cargo xtask image-smoke <image>, e.g. ghcr.io/owner/solo-publisher@sha256:...");
        return 1;
    };
    let image = image.as_str();
    let mut failures = Vec::new();
    let mut check = |ok: bool, what: &str, detail: &str| {
        if ok {
            println!("ok   {what}");
        } else {
            println!(
                "FAIL {what}{}",
                if detail.is_empty() {
                    String::new()
                } else {
                    format!("\n{detail}")
                }
            );
            failures.push(what.to_owned());
        }
    };

    let contents = run(&[
        "--entrypoint",
        "sh",
        image,
        "-c",
        &[
            "set -e",
            "test -x /app/bin/solo-publisher",
            "test -x /app/bin/studio-entrypoint",
            "test -x /app/bin/ops",
            "test -f /app/assets/story-card/Manrope-Variable.ttf",
            "test -f /app/assets/story-card/NotoColorEmoji.ttf",
            "test -f /app/assets/story-card/strata-master-background.png",
            "test -f /app/ops/cli.js && test -f /app/entrypoint/config-check.js",
            "ffmpeg -hide_banner -version | head -n 1",
            "ffprobe -hide_banner -version | head -n 1",
            "bun --version",
            "setpriv --version",
            "id bun",
        ]
        .join("\n"),
    ]);
    check(contents.code == 0, "image contents", &contents.out);

    let studio = run(&[
        "--entrypoint",
        "/app/bin/solo-publisher",
        "-e",
        "DATA_DIR=/tmp/data",
        image,
    ]);
    check(
        studio.code != 0 && studio.out.contains(REFUSAL),
        "the Studio refuses without a bot token",
        &studio.out,
    );

    let started = run(&["-e", "DATA_DIR=/data", image]);
    check(
        started
            .out
            .contains("fixed data directory ownership before dropping privileges")
            && started.out.contains(REFUSAL)
            && !started.out.contains("cannot drop privileges")
            && !started.out.contains("remain unwritable"),
        "entrypoint fixes ownership, drops privileges, then starts the Studio",
        &started.out,
    );

    let config_check = ["--entrypoint", "bun", "-e", "DATA_DIR=/tmp/data"];
    let valid = run(&[&config_check[..], &[image, "/app/entrypoint/config-check.js"]].concat());
    check(
        valid.code == 0 && valid.stdout.trim() == r#"{"ok":true}"#,
        "config check accepts a valid configuration",
        &valid.out,
    );
    let production = ["-e", "NODE_ENV=production", "-e", "DEPLOYMENT_ENV=production"];
    let invalid = run(&[
        &config_check[..],
        &production,
        &[image, "/app/entrypoint/config-check.js"],
    ]
    .concat());
    check(
        invalid.code != 0 && invalid.out.contains("COMMAND_CENTER_TOKEN"),
        "config check refuses an invalid configuration",
        &invalid.out,
    );

    let ops = run(&[
        "--entrypoint",
        "/app/bin/ops",
        "-e",
        "DATA_DIR=/tmp/data",
        "-u",
        "1000",
        image,
        "guide",
        "--json",
    ]);
    check(
        guide_answered(&ops),
        "ops CLI answers guide --json as uid 1000",
        &ops.out,
    );
    let shim = run(&[
        "--entrypoint",
        "bun",
        "-e",
        "DATA_DIR=/tmp/data",
        "-u",
        "bun",
        image,
        "/app/ops/cli.js",
        "guide",
        "--json",
    ]);
    check(
        guide_answered(&shim),
        "bun /app/ops/cli.js answers guide --json",
        &shim.out,
    );

    if !failures.is_empty() {
        eprintln!("{} image check(s) failed: {}", failures.len(), failures.join(", "));
        return 1;
    }
    println!("Image smoke test passed.");
    0
}

struct Output {
    code: i32,
    /// stdout then stderr.
    out: String,
    stdout: String,
}

/// `docker run --rm <args>`; a docker that cannot start reads as a failed run.
fn run(args: &[&str]) -> Output {
    match Command::new("docker").args(["run", "--rm"]).args(args).output() {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
            Output {
                code: output.status.code().unwrap_or(-1),
                out: format!("{stdout}{}", String::from_utf8_lossy(&output.stderr)),
                stdout,
            }
        }
        Err(error) => Output {
            code: -1,
            out: format!("cannot run docker: {error}"),
            stdout: String::new(),
        },
    }
}

fn guide_answered(run: &Output) -> bool {
    run.code == 0
        && serde_json::from_str::<serde_json::Value>(&run.stdout)
            .is_ok_and(|guide| guide["local"]["state"] == "missing")
}
