//! `cargo xtask image-smoke <image>`: inspects a built Studio image the way
//! production reaches it, without a bot token and so without starting a Studio:
//!
//! - what the image carries: the three binaries, the deploy agent the
//!   deployment copies onto the host, the Story-card assets, ffmpeg, setpriv
//!   and the `studio` user (uid 1000) — and no Bun;
//! - the entrypoint as root: it fixes the data directory's ownership, drops to
//!   uid 1000 and starts the Studio, which then refuses for want of a token —
//!   proof that the fix, the drop and the probe all ran first;
//! - the deploy agent's configuration check (`studio-entrypoint --check-config`
//!   as the entrypoint), accepting a valid configuration and refusing an
//!   invalid one;
//! - the healthcheck (`studio-entrypoint --ready`), which with no Studio
//!   listening reports it not ready instead of starting one;
//! - the deploy agent itself, which runs (it is static) and refuses to start
//!   without its token;
//! - the operations CLI, both as `cargo xtask ops-prod` runs it (`/app/bin/ops`
//!   as uid 1000) and as a self-hosted Studio does (`ops` on PATH).

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
            "test -x /app/bin/deploy-agent",
            "test -f /app/assets/story-card/Manrope-Variable.ttf",
            "test -f /app/assets/story-card/NotoColorEmoji.ttf",
            "test -f /app/assets/story-card/strata-master-background.png",
            "ffmpeg -hide_banner -version | head -n 1",
            "ffprobe -hide_banner -version | head -n 1",
            "setpriv --version",
            "test \"$(id -u studio):$(id -g studio)\" = 1000:1000",
            // Not `! command -v bun`: `set -e` ignores a negated command.
            "if command -v bun; then exit 1; fi",
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

    let config_check = ["--entrypoint", "/app/bin/studio-entrypoint", "-e", "DATA_DIR=/tmp/data"];
    let valid = run(&[&config_check[..], &[image, "--check-config"]].concat());
    check(
        valid.code == 0 && valid.stdout.trim() == r#"{"ok":true}"#,
        "config check accepts a valid configuration",
        &valid.out,
    );
    let production = ["-e", "NODE_ENV=production"];
    let invalid = run(&[&config_check[..], &production, &[image, "--check-config"]].concat());
    check(
        invalid.code != 0 && invalid.out.contains("COMMAND_CENTER_TOKEN"),
        "config check refuses an invalid configuration",
        &invalid.out,
    );

    // The compose files' healthcheck: no Studio runs here, so it must answer
    // "not ready" — not start one, which would refuse for want of a token.
    let ready = run(&[&config_check[..], &[image, "--ready"]].concat());
    check(
        ready.code == 1 && ready.out.contains("studio is not ready") && !ready.out.contains(REFUSAL),
        "the healthcheck reports a Studio that is not listening as not ready",
        &ready.out,
    );

    let agent = run(&["--entrypoint", "/app/bin/deploy-agent", image]);
    check(
        agent.code == 1 && agent.out.contains("DEPLOY_AGENT_TOKEN is required"),
        "the deploy agent runs and refuses without its token",
        &agent.out,
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
    let on_path = run(&[
        "--entrypoint",
        "ops",
        "-e",
        "DATA_DIR=/tmp/data",
        "-u",
        "studio",
        image,
        "guide",
        "--json",
    ]);
    check(
        guide_answered(&on_path),
        "ops on PATH answers guide --json as studio",
        &on_path.out,
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
