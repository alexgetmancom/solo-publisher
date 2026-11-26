//! `cargo xtask deploy-release`: the production deployment CI's `deploy` job
//! runs, as steps over `ssh` and `curl` rather than a shell block.
//!
//! It lived inline in the workflow once, where the only thing that ever checked
//! it was `bash -n`. Four deployments broke in one afternoon on things a test
//! would have caught in a second: a file copied only when a diff happened to
//! name it, a path missing from the list that triggers a rebuild, an `awk …
//! exit` that killed docker through EPIPE and turned a finished push into a
//! failed job. Every side effect goes through a [`Runner`], so the sequence is
//! driven against a recorder in the tests.

use std::time::Instant;

use serde_json::Value;

/// Bytes, not text: the release archive travels through here, and decoding a
/// tar stream as UTF-8 corrupts it silently.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Command {
    pub argv: Vec<String>,
    pub stdin: Option<Vec<u8>>,
}

/// A command's status and standard output; its standard error goes to the job's log.
#[derive(Clone, Debug, Default)]
pub(crate) struct Outcome {
    pub code: i32,
    pub stdout: Vec<u8>,
}

pub(crate) trait Runner: Sync {
    /// `Err` when the command cannot start.
    fn run(&self, command: &Command) -> Result<Outcome, String>;
}

#[derive(Clone, Debug)]
pub(crate) struct Inputs {
    pub host: String,
    pub user: String,
    pub agent_token: String,
    pub image: String,
    pub media_processor_image: String,
    pub release: String,
    pub caddy_config_changed: bool,
    pub maru_deploy_enabled: bool,
    pub promote_maru: bool,
    pub public_ready_url: String,
    pub control_path: String,
}

const RUNTIME: &str = "/home/deploy/alexgetman-runtime";
const MARU_RUNTIME: &str = "/home/deploy/maru";
const CADDY_RUNTIME: &str = "/home/deploy/caddy";
const STATE_DIR: &str = "/var/lib/alexgetman-deploy";
const AGENT: &str = "http://127.0.0.1:9899";
/// Where the deploy agent's unit runs it from (`deploy/alexgetman-deploy-agent.service`).
const AGENT_BINARY: &str = "/home/deploy/bin/deploy-agent";
const MARU_READY_URL: &str = "http://127.0.0.1:8789/readyz";
const IMAGE_REPOSITORY: &str = "ghcr.io/alexgetmancom/solo-publisher";

/// Configuration travels with every deployment, never only when a diff named
/// it: a run that fails after the commit that changed it would otherwise leave
/// the host on a configuration the repository has moved past, and no later run
/// would ever mention those files again.
const ALWAYS_SHIPPED: [&str; 3] = ["deploy/studio.compose.yaml", "deploy/alex.env", "deploy/maru.env"];

pub(crate) fn main(argv: Vec<String>) -> u8 {
    if !argv.is_empty() {
        eprintln!("usage: cargo xtask deploy-release (configured by the environment CI's deploy job sets)");
        return 1;
    }
    let env = |name: &str| std::env::var(name).unwrap_or_default();
    let inputs = Inputs {
        host: env("DEPLOY_HOST"),
        user: env("DEPLOY_USER"),
        agent_token: env("DEPLOY_AGENT_TOKEN"),
        image: env("IMAGE"),
        media_processor_image: env("MEDIA_PROCESSOR_IMAGE"),
        release: env("RELEASE"),
        caddy_config_changed: env("CADDY_CONFIG_CHANGED") == "true",
        maru_deploy_enabled: env("MARU_DEPLOY_ENABLED") == "true",
        promote_maru: env("PROMOTE_MARU") == "true",
        public_ready_url: std::env::var("PUBLIC_READY_URL").unwrap_or_else(|_| "https://alexgetman.com/readyz".into()),
        control_path: format!(
            "{}/deploy-ssh-%C",
            std::env::var("RUNNER_TEMP").unwrap_or_else(|_| "/tmp".into())
        ),
    };
    match deploy_release(&inputs, &System, &mut |message| println!("{message}")) {
        Ok(()) => 0,
        Err(message) => {
            eprintln!("{message}");
            1
        }
    }
}

/// This machine's programs.
struct System;

impl Runner for System {
    fn run(&self, command: &Command) -> Result<Outcome, String> {
        use std::io::Write as _;
        use std::process::Stdio;
        let (program, args) = command.argv.split_first().ok_or("an empty command")?;
        let mut child = std::process::Command::new(program)
            .args(args)
            .stdin(if command.stdin.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|error| format!("cannot start {program}: {error}"))?;
        // Written from a thread of its own, so a child that writes before it
        // has read all of its input cannot deadlock against this one.
        let writer = command.stdin.clone().zip(child.stdin.take()).map(|(bytes, mut stdin)| {
            std::thread::spawn(move || {
                let _ = stdin.write_all(&bytes);
            })
        });
        let output = child.wait_with_output().map_err(|error| error.to_string())?;
        if let Some(writer) = writer {
            let _ = writer.join();
        }
        Ok(Outcome {
            code: i32::from(crate::exit_code(output.status)),
            stdout: output.stdout,
        })
    }
}

pub(crate) fn deploy_release(inputs: &Inputs, run: &dyn Runner, log: &mut dyn FnMut(&str)) -> Result<(), String> {
    for (name, value) in [
        ("DEPLOY_HOST", &inputs.host),
        ("DEPLOY_USER", &inputs.user),
        ("DEPLOY_AGENT_TOKEN", &inputs.agent_token),
        ("IMAGE", &inputs.image),
    ] {
        if value.is_empty() {
            return Err(format!("{name} is required"));
        }
    }
    // The image is written into shell scripts below; a digest reference has
    // nothing in it a shell would read.
    if !is_studio_image(&inputs.image) {
        return Err(format!("IMAGE must be {IMAGE_REPOSITORY}@sha256:<64 hex digits>"));
    }
    // Promoting into a runtime this run never configured would activate an
    // image against whatever compose file and env the host still carries.
    if inputs.promote_maru && !inputs.maru_deploy_enabled {
        return Err("PROMOTE_MARU requires MARU_DEPLOY_ENABLED".into());
    }

    let remote = format!("{}@{}", inputs.user, inputs.host);
    let ssh_argv = |script: &str| -> Vec<String> {
        [
            "ssh",
            "-o",
            "BatchMode=yes",
            "-o",
            "ControlMaster=auto",
            "-o",
            "ControlPersist=60",
            "-o",
            &format!("ControlPath={}", inputs.control_path),
            &remote,
            script,
        ]
        .map(str::to_owned)
        .to_vec()
    };
    let ssh_with = |script: &str, stdin: Option<Vec<u8>>| -> Result<Vec<u8>, String> {
        let outcome = run.run(&Command {
            argv: ssh_argv(script),
            stdin,
        })?;
        if outcome.code != 0 {
            let detail = String::from_utf8_lossy(&outcome.stdout);
            let detail = last_chars(detail.trim(), 4_000);
            let head: String = script.chars().take(120).collect();
            let detail = if detail.is_empty() {
                String::new()
            } else {
                format!("\n{detail}")
            };
            return Err(format!("remote command failed ({}): {head}{detail}", outcome.code));
        }
        Ok(outcome.stdout)
    };
    let ssh = |script: &str| ssh_with(script, None).map(drop);
    let mut phase_started = Instant::now();
    let mut phase = |name: &str| {
        log(&format!(
            "::notice::deploy timing: {name}={}s",
            phase_started.elapsed().as_secs_f64().round()
        ));
        phase_started = Instant::now();
    };
    let release_files = format!("{RUNTIME}/release-files/{}", inputs.release);

    ssh(&format!("install -d -m 0700 {STATE_DIR}"))?;
    let media_release = serde_json::json!({"release": inputs.release, "image": inputs.media_processor_image});
    ssh_with(
        &format!("umask 077; cat > {STATE_DIR}/media-processor-release.json"),
        Some(format!("{media_release}\n").into_bytes()),
    )?;
    // Scratch for this release only, removed again once the deployment is
    // green. A run that fails after this point never reaches that removal, so
    // the whole tree is pruned on the way in rather than only on the way out:
    // eleven directories from failed runs had collected here before it was.
    // Deployments are serialized by the `production-deploy` concurrency group,
    // so no other run owns a directory under it.
    ssh(&format!(
        "rm -rf {RUNTIME}/release-files; install -d -m 0700 '{release_files}'"
    ))?;

    let mut paths = ALWAYS_SHIPPED.to_vec();
    if inputs.caddy_config_changed {
        paths.extend(["deploy/caddy/Caddyfile", "deploy/caddy/compose.yaml"]);
    }
    let archive = run.run(&Command {
        argv: ["tar", "-cf", "-"]
            .iter()
            .chain(&paths)
            .map(|arg| (*arg).to_owned())
            .collect(),
        stdin: None,
    })?;
    if archive.code != 0 {
        return Err("could not archive the release files".into());
    }
    ssh_with(&format!("tar -xf - -C '{release_files}'"), Some(archive.stdout))?;

    let install_studio_config = |runtime: &str, deployment: &str| {
        ssh(&format!(
            "set -e; image=$(sed -n 's/^BACKEND_IMAGE=//p' {runtime}/deploy-image.env | tail -n 1); \
             printf '%s\\n' \"$image\" | grep -Eq '^{IMAGE_REPOSITORY}@sha256:[0-9a-fA-F]{{64}}$' || exit 1; \
             cat '{release_files}/deploy/{deployment}.env' > {runtime}/deploy-image.env.next; \
             printf 'BACKEND_IMAGE=%s\\n' \"$image\" >> {runtime}/deploy-image.env.next; \
             cp '{release_files}/deploy/studio.compose.yaml' {runtime}/compose.yaml.next; \
             docker compose --env-file {runtime}/deploy-image.env.next -f {runtime}/compose.yaml.next config --quiet; \
             mv {runtime}/deploy-image.env.next {runtime}/deploy-image.env; \
             mv {runtime}/compose.yaml.next {runtime}/compose.yaml"
        ))
    };
    install_studio_config(RUNTIME, "alex")?;
    // The agent ships in the image this run deploys (`/app/bin/deploy-agent`,
    // a static binary), so it is the one build of this commit, for this host's
    // architecture. Installed and restarted only when it differs: restarting
    // drops a rollback a button press may have under way. The unit decides
    // what the restart runs (deploy/README.md, "Switching the agent to the
    // Rust binary").
    ssh(&format!(
        "set -e; for attempt in 1 2 3; do docker pull --quiet '{image}' >/dev/null && break; test \"$attempt\" -lt 3; sleep 5; done; \
         container=$(docker create '{image}'); trap 'docker rm \"$container\" >/dev/null' EXIT; \
         install -d -m 0755 {bin_dir}; docker cp \"$container:/app/bin/deploy-agent\" {AGENT_BINARY}.next; chmod 0755 {AGENT_BINARY}.next; \
         if cmp -s {AGENT_BINARY}.next {AGENT_BINARY}; then rm {AGENT_BINARY}.next; exit 0; fi; \
         mv -f {AGENT_BINARY}.next {AGENT_BINARY}; sudo systemctl restart alexgetman-deploy-agent; \
         for attempt in 1 2 3 4 5; do curl --fail --silent {AGENT}/healthz && exit 0; sleep 1; done; exit 1",
        image = inputs.image,
        bin_dir = AGENT_BINARY.rsplit_once('/').map_or("/", |(directory, _)| directory),
    ))?;
    if inputs.maru_deploy_enabled {
        install_studio_config(MARU_RUNTIME, "maru")?;
    }
    phase("runtime-config");

    if inputs.caddy_config_changed {
        // `caddy validate` parses the file the container will read, so a typo
        // fails here instead of taking every domain down on reload. A reload
        // keeps connections; it does not restart the proxy.
        ssh(&format!(
            "set -e; cp '{release_files}/deploy/caddy/Caddyfile' {CADDY_RUNTIME}/Caddyfile.next; \
             cp '{release_files}/deploy/caddy/compose.yaml' {CADDY_RUNTIME}/compose.yaml.next; \
             docker compose -f {CADDY_RUNTIME}/compose.yaml.next config --quiet; \
             docker exec -i caddy caddy validate --adapter caddyfile --config - < {CADDY_RUNTIME}/Caddyfile.next; \
             cat {CADDY_RUNTIME}/Caddyfile.next > {CADDY_RUNTIME}/Caddyfile; rm {CADDY_RUNTIME}/Caddyfile.next; \
             mv {CADDY_RUNTIME}/compose.yaml.next {CADDY_RUNTIME}/compose.yaml; \
             docker exec caddy caddy reload --config /etc/caddy/Caddyfile"
        ))?;
        // The Caddyfile is bind-mounted into the container as a single file,
        // so the mount follows the inode, not the name: `mv` would replace the
        // name on the host and leave the container reading the old file
        // forever, and the reload would report success on config nothing
        // served. Hence `cat` over the existing inode above.
    }
    phase("caddy-config");

    let agent_call = |path: &str, payload: &Value| {
        ssh(&format!(
            "curl --fail-with-body --silent --show-error --max-time 180 -H 'Authorization: Bearer {}' \
             -H 'Content-Type: application/json' --data '{payload}' {AGENT}{path}",
            inputs.agent_token
        ))
    };
    agent_call(
        "/v1/deploy",
        &serde_json::json!({"image": inputs.image, "release": inputs.release}),
    )?;
    phase("backend-activation");

    // Both Studios, together: a slow one must not hide a broken one behind it.
    let public = Command {
        argv: [
            "curl",
            "--fail",
            "--silent",
            "--show-error",
            "--retry",
            "3",
            "--retry-all-errors",
            &inputs.public_ready_url,
        ]
        .map(str::to_owned)
        .to_vec(),
        stdin: None,
    };
    let maru = Command {
        argv: ssh_argv(&format!(
            "curl --fail --silent --show-error --retry 3 --retry-all-errors {MARU_READY_URL}"
        )),
        stdin: None,
    };
    let ready = std::thread::scope(|scope| {
        let public = scope.spawn(|| run.run(&public));
        let maru = scope.spawn(|| run.run(&maru));
        [public, maru].into_iter().all(|probe| {
            probe
                .join()
                .is_ok_and(|outcome| outcome.is_ok_and(|outcome| outcome.code == 0))
        })
    });
    if !ready {
        return Err("a Studio did not become ready after activation".into());
    }
    phase("readiness");

    // Promotion, not a second deployment: the agent activates on Maru the
    // exact image alex has just proved healthy, through the same endpoint the
    // notification button calls. Only after alex is ready, so a broken release
    // never reaches the second audience. The agent waits on Maru's own
    // /readyz and rolls back before it answers, so a failed promotion fails
    // this step.
    if inputs.promote_maru {
        agent_call("/v1/promote/maru", &serde_json::json!({"release": inputs.release}))?;
        phase("maru-promotion");
    }

    // Reconcile deploy-image.env with what is now actually running, so a
    // manual `docker compose up` starts the release that was just verified. It
    // reads each target's own state file, which is the one the agent writes,
    // and requires it to name this run's image rather than merely look like a
    // digest. Maru is reconciled only when this run promoted it; otherwise it
    // is running whatever an earlier button press left there, and rewriting
    // its env would assert something this workflow never performed.
    let reconcile = |runtime: &str, deployment: &str| -> Result<(), String> {
        let state = ssh_with(&format!("cat {STATE_DIR}/{deployment}.json"), None)?;
        let state: Value = serde_json::from_slice(&state).unwrap_or_default();
        let running = state["current"]["image"].as_str().unwrap_or_default();
        if running != inputs.image {
            return Err(format!(
                "{deployment} runs {running:?} by its state file, not this run's {}",
                inputs.image
            ));
        }
        let env = format!("{runtime}/deploy-image.env");
        ssh(&format!(
            "set -e; if ! grep -Eq '^BACKEND_IMAGE={running}$' {env}; then \
             {{ grep -v '^BACKEND_IMAGE=' {env} || true; printf 'BACKEND_IMAGE=%s\\n' '{running}'; }} > {env}.next; \
             mv {env}.next {env}; fi"
        ))
    };
    reconcile(RUNTIME, "alex")?;
    if inputs.promote_maru {
        reconcile(MARU_RUNTIME, "maru")?;
    }
    phase("image-reconciliation");

    ssh(&format!("rm -rf '{release_files}'"))?;
    phase("cleanup");
    let mut close = ssh_argv("");
    close.pop();
    close.insert(close.len() - 1, "-O".into());
    close.insert(close.len() - 1, "exit".into());
    run.run(&Command {
        argv: close,
        stdin: None,
    })?;
    Ok(())
}

fn is_studio_image(image: &str) -> bool {
    image
        .strip_prefix(IMAGE_REPOSITORY)
        .and_then(|rest| rest.strip_prefix("@sha256:"))
        .is_some_and(|digest| digest.len() == 64 && digest.bytes().all(|byte| byte.is_ascii_hexdigit()))
}

fn last_chars(text: &str, count: usize) -> &str {
    let total = text.chars().count();
    text.char_indices()
        .nth(total.saturating_sub(count))
        .map_or(text, |(start, _)| &text[start..])
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    fn inputs() -> Inputs {
        Inputs {
            host: "host.example".into(),
            user: "deploy".into(),
            agent_token: "t".repeat(16),
            image: format!("{IMAGE_REPOSITORY}@sha256:{}", "a".repeat(64)),
            media_processor_image: format!(
                "ghcr.io/alexgetmancom/alexgetman-media-processor@sha256:{}",
                "b".repeat(64)
            ),
            release: "abc1234".into(),
            caddy_config_changed: false,
            maru_deploy_enabled: false,
            promote_maru: false,
            public_ready_url: "https://studio.example/readyz".into(),
            control_path: "/tmp/deploy-ssh-%C".into(),
        }
    }

    /// Records every command; the scripts it is told to fail exit 1 with
    /// `failure_output`, and a state file read names this run's image.
    struct Recorder {
        commands: Mutex<Vec<Command>>,
        fail: fn(&str) -> bool,
        failure_output: &'static str,
        image: String,
    }

    impl Recorder {
        fn new() -> Self {
            Self::failing(|_| false, "")
        }

        fn failing(fail: fn(&str) -> bool, failure_output: &'static str) -> Self {
            Self {
                commands: Mutex::default(),
                fail,
                failure_output,
                image: inputs().image,
            }
        }

        fn scripts(&self) -> Vec<String> {
            self.commands
                .lock()
                .unwrap()
                .iter()
                .map(|command| command.argv.join(" "))
                .collect()
        }

        fn at(&self, needle: &str) -> usize {
            let scripts = self.scripts();
            scripts
                .iter()
                .position(|script| script.contains(needle))
                .unwrap_or_else(|| panic!("no command contains {needle:?}:\n{scripts:#?}"))
        }

        fn ran(&self, needle: &str) -> bool {
            self.scripts().iter().any(|script| script.contains(needle))
        }
    }

    impl Runner for Recorder {
        fn run(&self, command: &Command) -> Result<Outcome, String> {
            self.commands.lock().unwrap().push(command.clone());
            let script = command.argv.join(" ");
            if (self.fail)(&script) {
                return Ok(Outcome {
                    code: 1,
                    stdout: self.failure_output.as_bytes().to_vec(),
                });
            }
            let stdout = if script.contains(&format!("cat {STATE_DIR}/")) && script.ends_with(".json") {
                serde_json::json!({"current": {"image": self.image, "revision": "abc1234"}})
                    .to_string()
                    .into_bytes()
            } else {
                Vec::new()
            };
            Ok(Outcome { code: 0, stdout })
        }
    }

    fn deploy(inputs: &Inputs, recorder: &Recorder) -> Result<(), String> {
        deploy_release(inputs, recorder, &mut |_| {})
    }

    #[test]
    fn the_studio_configuration_ships_on_every_deployment() {
        // Copying only when a diff named these files lost the change for good
        // when a run failed after the commit that made it, and the site went
        // on serving a configuration the repository had moved past.
        let recorder = Recorder::new();
        deploy(&inputs(), &recorder).unwrap();
        let archive = &recorder.scripts()[recorder.at("tar -cf -")];
        assert_eq!(
            archive,
            "tar -cf - deploy/studio.compose.yaml deploy/alex.env deploy/maru.env"
        );
        assert!(recorder.ran("cp '/home/deploy/alexgetman-runtime/release-files/abc1234/deploy/studio.compose.yaml'"));
        assert!(recorder.ran("deploy/alex.env' > /home/deploy/alexgetman-runtime/deploy-image.env.next"));
        let extract = recorder.at("tar -xf -");
        assert!(recorder.commands.lock().unwrap()[extract].stdin.is_some());
    }

    #[test]
    fn maru_is_left_alone_unless_the_release_asked_to_be_promoted() {
        let recorder = Recorder::new();
        deploy(
            &Inputs {
                maru_deploy_enabled: true,
                ..inputs()
            },
            &recorder,
        )
        .unwrap();
        assert!(!recorder.ran("/v1/promote/maru"));
        // Maru is running whatever an earlier promotion left there; reconciling
        // its env against this run's image would claim an activation that never happened.
        assert!(!recorder.ran("cat /var/lib/alexgetman-deploy/maru.json"));
        assert!(recorder.ran("deploy/maru.env' > /home/deploy/maru/deploy-image.env.next"));
        assert!(recorder.ran("-f /home/deploy/maru/compose.yaml.next config --quiet"));
    }

    #[test]
    fn maru_gets_the_image_alex_proved_healthy_and_only_after_it_did() {
        // A `Deploy-Maru:` trailer reaches the second audience through the same
        // agent endpoint the notification button calls, never through a second
        // deployment of its own.
        let recorder = Recorder::new();
        let promoting = Inputs {
            maru_deploy_enabled: true,
            promote_maru: true,
            ..inputs()
        };
        deploy(&promoting, &recorder).unwrap();
        let promote = recorder.at("/v1/promote/maru");
        assert!(promote > recorder.at(&promoting.public_ready_url));
        assert!(recorder.scripts()[promote].contains(r#"--data '{"release":"abc1234"}'"#));
        assert!(recorder.at("cat /var/lib/alexgetman-deploy/maru.json") > promote);
    }

    #[test]
    fn nothing_runs_before_the_inputs_are_complete() {
        let recorder = Recorder::new();
        let refused = |inputs: Inputs| deploy(&inputs, &recorder).unwrap_err();
        assert_eq!(
            refused(Inputs {
                promote_maru: true,
                ..inputs()
            }),
            "PROMOTE_MARU requires MARU_DEPLOY_ENABLED"
        );
        assert_eq!(
            refused(Inputs {
                image: String::new(),
                ..inputs()
            }),
            "IMAGE is required"
        );
        assert_eq!(
            refused(Inputs {
                host: String::new(),
                ..inputs()
            }),
            "DEPLOY_HOST is required"
        );
        assert!(
            refused(Inputs {
                image: "ghcr.io/alexgetmancom/solo-publisher:latest".into(),
                ..inputs()
            })
            .starts_with("IMAGE must be ")
        );
        assert!(recorder.scripts().is_empty());
    }

    #[test]
    fn activation_follows_the_configuration_and_verification_follows_activation() {
        // The order is the whole safety property: a container recreated before
        // its configuration arrives runs the previous one, and a reconciliation
        // that runs before activation describes the release that came before.
        let recorder = Recorder::new();
        deploy(&inputs(), &recorder).unwrap();
        let order = [
            "rm -rf /home/deploy/alexgetman-runtime/release-files;",
            "tar -cf -",
            "compose.yaml.next",
            "docker cp \"$container:/app/bin/deploy-agent\"",
            "/v1/deploy",
            "readyz",
            "cat /var/lib/alexgetman-deploy/alex.json",
            "grep -v '^BACKEND_IMAGE='",
            "rm -rf '/home/deploy/alexgetman-runtime/release-files/abc1234'",
            "-O exit",
        ];
        let positions: Vec<usize> = order.iter().map(|needle| recorder.at(needle)).collect();
        assert!(
            positions.is_sorted(),
            "{:#?}",
            order.iter().zip(&positions).collect::<Vec<_>>()
        );
    }

    #[test]
    fn the_agent_comes_from_the_deployed_image_and_restarts_only_when_it_changed() {
        let recorder = Recorder::new();
        let inputs = inputs();
        deploy(&inputs, &recorder).unwrap();
        let install = &recorder.scripts()[recorder.at("/app/bin/deploy-agent")];
        assert!(install.contains(&format!("docker create '{}'", inputs.image)));
        assert!(install.contains(
            "if cmp -s /home/deploy/bin/deploy-agent.next /home/deploy/bin/deploy-agent; then rm /home/deploy/bin/deploy-agent.next; exit 0; fi"
        ));
        assert!(install.contains("mv -f /home/deploy/bin/deploy-agent.next /home/deploy/bin/deploy-agent; sudo systemctl restart alexgetman-deploy-agent"));
        assert!(install.contains("curl --fail --silent http://127.0.0.1:9899/healthz"));
    }

    #[test]
    fn the_proxy_is_left_alone_unless_it_changed() {
        let untouched = Recorder::new();
        deploy(&inputs(), &untouched).unwrap();
        assert!(!untouched.ran("caddy reload"));
        assert!(!untouched.ran("deploy/caddy"));

        let changed = Recorder::new();
        deploy(
            &Inputs {
                caddy_config_changed: true,
                ..inputs()
            },
            &changed,
        )
        .unwrap();
        assert!(changed.ran("tar -cf - deploy/studio.compose.yaml deploy/alex.env deploy/maru.env deploy/caddy/Caddyfile deploy/caddy/compose.yaml"));
        let caddy = &changed.scripts()[changed.at("caddy reload")];
        assert!(caddy.find("caddy validate") < caddy.find("caddy reload"));
        assert!(changed.at("caddy reload") < changed.at("/v1/deploy"));
    }

    #[test]
    fn a_studio_that_does_not_come_back_ends_the_deployment() {
        // Readiness failing has to end the deployment, not be reported and
        // passed: the reconciliation after it would otherwise record a release
        // nobody proved was serving.
        let recorder = Recorder::failing(|script| script.contains("readyz"), "");
        assert_eq!(
            deploy(&inputs(), &recorder).unwrap_err(),
            "a Studio did not become ready after activation"
        );
        assert!(!recorder.ran("cat /var/lib/alexgetman-deploy/alex.json"));
    }

    #[test]
    fn a_refused_step_stops_the_run_and_says_what_the_host_said() {
        let recorder = Recorder::failing(|script| script.contains("/v1/deploy"), "container preflight failed");
        let refused = deploy(&inputs(), &recorder).unwrap_err();
        assert!(
            refused.starts_with("remote command failed (1): curl --fail-with-body"),
            "{refused}"
        );
        assert!(refused.ends_with("\ncontainer preflight failed"), "{refused}");
        assert!(!recorder.ran("readyz"));
    }

    #[test]
    fn a_state_file_naming_another_image_is_not_reconciled() {
        let recorder = Recorder {
            image: format!("{IMAGE_REPOSITORY}@sha256:{}", "c".repeat(64)),
            ..Recorder::new()
        };
        let refused = deploy(&inputs(), &recorder).unwrap_err();
        assert!(
            refused.starts_with("alex runs \"ghcr.io/alexgetmancom/solo-publisher@sha256:ccc"),
            "{refused}"
        );
        assert!(!recorder.ran("grep -v '^BACKEND_IMAGE='"));
    }
}
