//! The agent over HTTP on an in-memory connection, with `docker` and the
//! network answered by a recorder and its files in a scratch directory.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use deploy_agent::{Agent, Config, Fut, Host, OutboundRequest, OutboundResponse, Output, serve_connection};
use http_body_util::{BodyExt as _, Full};
use hyper::Request;
use hyper::body::Bytes;
use hyper_util::rt::TokioIo;
use serde_json::{Value, json};
use tokio::sync::Semaphore;

const TOKEN: &str = "test-token";
const REPOSITORY: &str = "ghcr.io/example/backend";

fn image(digit: char) -> String {
    format!("{REPOSITORY}@sha256:{}", digit.to_string().repeat(64))
}

type DockerAnswer = Box<dyn Fn(&[String]) -> Output + Send + Sync>;
type HttpAnswer = Box<dyn Fn(&OutboundRequest) -> Result<OutboundResponse, String> + Send + Sync>;

/// `docker` and the network, answered by closures and recorded.
struct Fake {
    docker: DockerAnswer,
    http: HttpAnswer,
    /// Every `docker` argv, joined by spaces, as the shell stand-in logged it.
    commands: Mutex<Vec<String>>,
    requests: Mutex<Vec<OutboundRequest>>,
    /// When set, `docker compose … pull` waits for a permit.
    pull_gate: Option<Arc<Semaphore>>,
}

impl Fake {
    fn new(docker: DockerAnswer, http: HttpAnswer) -> Arc<Self> {
        Arc::new(Self {
            docker,
            http,
            commands: Mutex::default(),
            requests: Mutex::default(),
            pull_gate: None,
        })
    }

    fn commands(&self) -> Vec<String> {
        self.commands.lock().unwrap().clone()
    }

    fn requests_to(&self, suffix: &str) -> Vec<OutboundRequest> {
        let requests = self.requests.lock().unwrap();
        requests
            .iter()
            .filter(|request| request.url.ends_with(suffix))
            .cloned()
            .collect()
    }

    /// The bodies of every Telegram message sent.
    fn notifications(&self) -> Vec<Value> {
        self.requests_to("/sendMessage")
            .iter()
            .map(|request| serde_json::from_str(request.body.as_deref().unwrap()).unwrap())
            .collect()
    }
}

impl Host for Fake {
    fn docker(&self, args: Vec<String>) -> Fut<'_, std::io::Result<Output>> {
        Box::pin(async move {
            self.commands.lock().unwrap().push(args.join(" "));
            if let Some(gate) = &self.pull_gate
                && args.iter().any(|arg| arg == "pull")
            {
                gate.acquire().await.unwrap().forget();
            }
            Ok((self.docker)(&args))
        })
    }

    fn http(&self, request: OutboundRequest) -> Fut<'_, Result<OutboundResponse, String>> {
        Box::pin(async move {
            self.requests.lock().unwrap().push(request.clone());
            (self.http)(&request)
        })
    }
}

fn stdout(text: &str) -> Output {
    Output {
        stdout: format!("{text}\n"),
        ..Output::default()
    }
}

fn ok_json() -> Result<OutboundResponse, String> {
    Ok(OutboundResponse {
        status: 200,
        body: br#"{"ok":true}"#.to_vec(),
    })
}

/// A directory of its own under `_trash-rust/tmp`, removed with the test.
struct Scratch(PathBuf);

impl Scratch {
    fn new(name: &str) -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../_trash-rust/tmp");
        let path = root.join(format!(
            "deploy-agent-{name}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    fn path(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }

    fn text(&self, name: &str) -> String {
        std::fs::read_to_string(self.path(name)).unwrap()
    }

    fn json(&self, name: &str) -> Value {
        serde_json::from_str(&self.text(name)).unwrap()
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn compose_target(scratch: &Scratch, state: &str, container: &str) -> Value {
    json!({
        "composeFile": scratch.path("compose.yaml"),
        "imageEnvFile": scratch.path("image.env"),
        "stateFile": scratch.path(state),
        "healthUrl": "http://127.0.0.1:8788/readyz",
        "container": container,
    })
}

fn agent(targets: &Value, notifications: bool, host: Arc<Fake>) -> Arc<Agent> {
    let mut env = vec![
        ("DEPLOY_AGENT_TOKEN", TOKEN.to_owned()),
        ("DEPLOY_AGENT_HOST", "127.0.0.1".to_owned()),
        ("DEPLOY_IMAGE_REPOSITORY", REPOSITORY.to_owned()),
        ("DEPLOY_TARGETS_JSON", targets.to_string()),
        ("DEPLOY_RETRY_ATTEMPTS", "3".to_owned()),
        ("DEPLOY_RETRY_BACKOFF_MS", "0".to_owned()),
    ];
    if notifications {
        env.push(("DEPLOY_NOTIFICATION_BOT_TOKEN", "bot-token".to_owned()));
        env.push(("DEPLOY_NOTIFICATION_CHAT_ID", "1".to_owned()));
        env.push(("DEPLOY_NOTIFICATION_API_BASE_URL", "http://127.0.0.1:8081/".to_owned()));
    }
    let config = Config::from_env(env.into_iter().map(|(key, value)| (key.to_owned(), value))).unwrap();
    Agent::new(config, host)
}

/// One request on a connection of its own: the status and the JSON answer.
async fn call(agent: &Arc<Agent>, method: &str, path: &str, token: Option<&str>, body: Option<Value>) -> (u16, Value) {
    let (client, server) = tokio::io::duplex(1 << 16);
    tokio::spawn(serve_connection(server, Arc::clone(agent)));
    let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(client))
        .await
        .unwrap();
    tokio::spawn(connection);
    let mut request = Request::builder().method(method).uri(path).header("host", "agent");
    if let Some(token) = token {
        request = request.header("authorization", format!("Bearer {token}"));
    }
    let body = body.map(|body| body.to_string()).unwrap_or_default();
    let response = sender
        .send_request(request.body(Full::new(Bytes::from(body))).unwrap())
        .await
        .unwrap();
    let status = response.status().as_u16();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap())
}

fn seed(scratch: &Scratch, state_file: &str, image: &str, revision: &str) {
    std::fs::write(
        scratch.path(state_file),
        format!(
            "{}\n",
            json!({"current": {"image": image, "revision": revision, "deployedAt": "2026-01-01T00:00:00.000Z"}})
        ),
    )
    .unwrap();
}

#[tokio::test]
async fn a_failing_candidate_is_checked_rolled_back_and_reported_with_its_diagnostics() {
    let scratch = Scratch::new("rollback");
    let (old_revision, next_revision) = ("a".repeat(40), "b".repeat(40));
    let (old_image, next_image) = (image('1'), image('2'));
    std::fs::write(
        scratch.path("image.env"),
        format!("BACKEND_IMAGE={old_image}\nKEPT=1\n"),
    )
    .unwrap();
    seed(&scratch, "state.json", &old_image, &old_revision);
    let image_env = scratch.path("image.env");
    let (old, next) = (old_image.clone(), next_image.clone());
    let fake = Fake::new(
        Box::new(move |args| match (args[0].as_str(), args.get(1).map(String::as_str)) {
            ("image", Some("inspect")) => stdout(&old),
            ("inspect", Some("--format")) if args[2].contains("json") => {
                stdout(r#"{"Status":"unhealthy","FailingStreak":1,"Log":[{"Output":"invalid production config"}]}"#)
            }
            ("inspect", Some("--format")) => {
                let candidate = std::fs::read_to_string(&image_env).unwrap().contains(&next);
                stdout(if candidate { "unhealthy" } else { "running" })
            }
            ("logs", Some("--tail")) => Output {
                stderr: "Config validation failed: CONTROLLER_ADMIN_IDS is required\n".into(),
                ..Output::default()
            },
            _ => Output::default(),
        }),
        Box::new(|_| ok_json()),
    );
    let agent = agent(
        &json!({"alex": compose_target(&scratch, "state.json", "backend")}),
        true,
        Arc::clone(&fake),
    );

    assert_eq!(
        call(&agent, "GET", "/healthz", None, None).await,
        (200, json!({"ok": true, "deploying": false}))
    );
    // Reading what is deployed is behind the same token as every action: the
    // state names images and revisions, and the port is on the Docker bridge.
    assert_eq!(
        call(&agent, "GET", "/v1/releases", None, None).await,
        (403, json!({"ok": false, "message": "forbidden"}))
    );
    assert_eq!(
        call(&agent, "GET", "/v1/releases", Some("wrong-token"), None).await.0,
        403
    );
    let (status, releases) = call(&agent, "GET", "/v1/releases", Some(TOKEN), None).await;
    assert_eq!(status, 200);
    assert_eq!(
        releases,
        json!({"ok": true, "deploying": false, "targets": [{
            "target": "alex",
            "kind": "compose",
            "current": {"image": old_image, "revision": old_revision, "deployedAt": "2026-01-01T00:00:00.000Z"},
        }]})
    );

    let (status, answer) = call(
        &agent,
        "POST",
        "/v1/deploy/alex",
        Some(TOKEN),
        Some(json!({"image": next_image, "release": next_revision})),
    )
    .await;
    assert_eq!(status, 502, "{answer}");
    assert_eq!(answer["ok"], false);
    assert!(
        answer["message"]
            .as_str()
            .unwrap()
            .starts_with("Deploy failed and was rolled back: container state is unhealthy\n")
    );

    let state = scratch.json("state.json");
    assert_eq!(state["current"]["image"], old_image.as_str());
    assert_eq!(state["lastFailure"]["revision"], next_revision.as_str());
    let failure = state["lastFailure"]["message"].as_str().unwrap();
    assert!(failure.contains("invalid production config"), "{failure}");
    assert!(failure.contains("CONTROLLER_ADMIN_IDS is required"), "{failure}");
    // The rollback put the old digest back, keeping the rest of the env file.
    assert_eq!(
        scratch.text("image.env"),
        format!("BACKEND_IMAGE={old_image}\nKEPT=1\n")
    );

    let commands = fake.commands();
    let compose = format!(
        "compose --env-file {} -f {}",
        scratch.path("image.env").display(),
        scratch.path("compose.yaml").display()
    );
    let check = format!("{compose} run --rm --no-deps --entrypoint /app/bin/studio-entrypoint backend --check-config");
    assert_eq!(
        commands.iter().filter(|command| **command == check).count(),
        1,
        "{commands:#?}"
    );
    assert!(commands.contains(&"rm -f backend".to_owned()));
    assert!(commands.contains(&format!("{compose} up -d --no-deps --force-recreate backend")));

    let notifications = fake.notifications();
    let last = notifications.last().unwrap();
    let text = last["text"].as_str().unwrap();
    assert!(text.starts_with(&format!(
        "Deploy alex {} failed; automatic rollback to {} succeeded.\n\n",
        &next_revision[..12],
        &old_revision[..12]
    )));
    assert!(text.contains("CONTROLLER_ADMIN_IDS is required"));
    assert_eq!(last["chat_id"], "1");
    assert!(last.get("reply_markup").is_none());
    assert!(fake.requests_to("/sendMessage")[0].url == "http://127.0.0.1:8081/botbot-token/sendMessage");
}

#[tokio::test]
async fn the_last_three_images_are_kept_and_the_running_one_is_left_alone() {
    let scratch = Scratch::new("prune");
    std::fs::write(scratch.path("image.env"), format!("BACKEND_IMAGE={}\n", image('1'))).unwrap();
    seed(&scratch, "state.json", &image('1'), &"a".repeat(40));
    // Five images on the host, newest first. Three survive, and the fourth is
    // the one the container is running: a rollback put an older digest back,
    // so age alone would have removed what production is serving.
    let identifiers: Vec<String> = ['5', '4', '3', '2', '1']
        .iter()
        .map(|digit| format!("sha256:{}", digit.to_string().repeat(64)))
        .collect();
    let running = identifiers[3].clone();
    let listing = identifiers
        .iter()
        .enumerate()
        .map(|(index, identifier)| format!("2026-09-0{} 10:00:00 +0000 UTC\t{identifier}", 5 - index))
        .collect::<Vec<_>>()
        .join("\n");
    let (old, current) = (image('1'), running.clone());
    let fake = Fake::new(
        Box::new(move |args| match (args[0].as_str(), args.get(1).map(String::as_str)) {
            ("images", Some("--no-trunc")) => stdout(&listing),
            ("image", Some("inspect")) if args[3].contains("Id") => stdout(&current),
            ("image", Some("inspect")) => stdout(&old),
            ("inspect", Some("--format")) => stdout("healthy"),
            _ => Output::default(),
        }),
        Box::new(|_| ok_json()),
    );
    let agent = agent(
        &json!({"alex": compose_target(&scratch, "state.json", "backend")}),
        false,
        Arc::clone(&fake),
    );

    let next_revision = "b".repeat(40);
    let (status, answer) = call(
        &agent,
        "POST",
        "/v1/deploy/alex",
        Some(TOKEN),
        Some(json!({"image": image('2'), "release": next_revision})),
    )
    .await;
    assert_eq!(
        (status, answer),
        (
            200,
            json!({"ok": true, "target": "alex", "release": next_revision, "currentRevision": next_revision})
        )
    );
    let removed: Vec<String> = fake
        .commands()
        .iter()
        .filter_map(|command| command.strip_prefix("image rm ").map(str::to_owned))
        .collect();
    assert_eq!(removed, [identifiers[4].clone()]);
    assert!(!removed.contains(&running));

    let state = scratch.json("state.json");
    assert_eq!(state["current"]["image"], image('2').as_str());
    assert_eq!(state["previous"]["revision"], "a".repeat(40).as_str());
    assert!(state.get("lastFailure").is_none());
    // `toISOString()`: milliseconds, in UTC.
    let deployed_at = state["current"]["deployedAt"].as_str().unwrap();
    assert!(
        deployed_at.len() == 24 && deployed_at.ends_with('Z') && &deployed_at[19..20] == ".",
        "{deployed_at}"
    );
}

/// The media processor's host: one target, an image without
/// `studio-entrypoint`, and a caller that names no target.
#[tokio::test]
async fn a_target_without_a_config_check_is_deployed_without_one() {
    let scratch = Scratch::new("media");
    let media = "ghcr.io/example/media-processor";
    let (old_image, next_image) = (
        format!("{media}@sha256:{}", "1".repeat(64)),
        format!("{media}@sha256:{}", "2".repeat(64)),
    );
    std::fs::write(
        scratch.path("image.env"),
        format!("MEDIA_PROCESSOR_TOKEN=secret\nMEDIA_PROCESSOR_IMAGE={old_image}\n"),
    )
    .unwrap();
    let fake = Fake::new(
        Box::new(|args| match args[0].as_str() {
            "inspect" => stdout("healthy"),
            _ => Output::default(),
        }),
        Box::new(|_| ok_json()),
    );
    let target = json!({"media": {
        "composeFile": scratch.path("compose.yml"),
        "imageEnvFile": scratch.path("image.env"),
        "stateFile": scratch.path("state.json"),
        "healthUrl": "http://127.0.0.1:9087/health",
        "container": "studio-media-processor",
        "service": "media-processor",
        "imageEnvKey": "MEDIA_PROCESSOR_IMAGE",
        "configCheck": false,
    }});
    let config = Config::from_env(
        [
            ("DEPLOY_AGENT_TOKEN", TOKEN),
            ("DEPLOY_IMAGE_REPOSITORY", media),
            ("DEPLOY_TARGETS_JSON", &target.to_string()),
        ]
        .map(|(key, value)| (key.to_owned(), value.to_owned())),
    )
    .unwrap();
    let agent = Agent::new(config, Arc::clone(&fake) as Arc<dyn Host>);

    let release = "c".repeat(40);
    let (status, answer) = call(
        &agent,
        "POST",
        "/v1/deploy",
        Some(TOKEN),
        Some(json!({"image": next_image, "release": release})),
    )
    .await;
    assert_eq!(status, 200, "{answer}");
    assert_eq!(answer["target"], "media");
    let commands = fake.commands();
    assert!(
        !commands.iter().any(|command| command.contains("--check-config")),
        "{commands:#?}"
    );
    assert!(commands.iter().any(|command| command.ends_with("pull media-processor")));
    assert!(commands.contains(&"rm -f studio-media-processor".to_owned()));
    assert_eq!(
        scratch.text("image.env"),
        format!("MEDIA_PROCESSOR_IMAGE={next_image}\nMEDIA_PROCESSOR_TOKEN=secret\n")
    );
    assert_eq!(fake.requests_to("/health").len(), 1);
    let state = scratch.json("state.json");
    assert_eq!(state["current"]["image"], next_image.as_str());
    // There was no state, so the predecessor is the digest the env file declared.
    assert_eq!(state["previous"]["image"], old_image.as_str());
    assert_eq!(state["previous"]["revision"], "111111111111");
}

#[tokio::test]
async fn a_second_deployment_is_refused_while_one_runs() {
    let scratch = Scratch::new("lock");
    std::fs::write(scratch.path("image.env"), format!("BACKEND_IMAGE={}\n", image('1'))).unwrap();
    seed(&scratch, "state.json", &image('1'), &"a".repeat(40));
    let gate = Arc::new(Semaphore::new(0));
    let fake = Arc::new(Fake {
        pull_gate: Some(Arc::clone(&gate)),
        ..Arc::into_inner(Fake::new(
            Box::new(|args| match args[0].as_str() {
                "inspect" => stdout("healthy"),
                _ => Output::default(),
            }),
            Box::new(|_| ok_json()),
        ))
        .unwrap()
    });
    let agent = agent(
        &json!({"alex": compose_target(&scratch, "state.json", "backend")}),
        false,
        Arc::clone(&fake),
    );

    let first = tokio::spawn({
        let agent = Arc::clone(&agent);
        async move {
            call(
                &agent,
                "POST",
                "/v1/deploy",
                Some(TOKEN),
                Some(json!({"image": image('2'), "release": "b".repeat(40)})),
            )
            .await
        }
    });
    while !fake.commands().iter().any(|command| command.contains(" pull ")) {
        tokio::task::yield_now().await;
    }
    assert_eq!(
        call(&agent, "GET", "/healthz", None, None).await,
        (200, json!({"ok": true, "deploying": true}))
    );
    assert_eq!(
        call(
            &agent,
            "POST",
            "/v1/rollback/alex",
            Some(TOKEN),
            Some(json!({"release": "a".repeat(40)}))
        )
        .await,
        (409, json!({"ok": false, "message": "A deployment is already running."}))
    );
    gate.add_permits(1);
    assert_eq!(first.await.unwrap().0, 200);
    assert_eq!(call(&agent, "GET", "/healthz", None, None).await.1["deploying"], false);
}

#[tokio::test]
async fn alex_offers_its_release_to_the_other_targets_and_a_remote_one_gets_the_registered_artifact() {
    let scratch = Scratch::new("promote");
    std::fs::write(scratch.path("image.env"), format!("BACKEND_IMAGE={}\n", image('1'))).unwrap();
    seed(&scratch, "alex.json", &image('1'), &"a".repeat(40));
    let worker = "ghcr.io/example/worker";
    let worker_image = format!("{worker}@sha256:{}", "9".repeat(64));
    let release = "b".repeat(40);
    std::fs::write(
        scratch.path("artifact.json"),
        json!({"release": release, "image": worker_image}).to_string(),
    )
    .unwrap();
    let remote_calls = AtomicUsize::new(0);
    let fake = Fake::new(
        Box::new(|args| match args[0].as_str() {
            "inspect" => stdout("healthy"),
            _ => Output::default(),
        }),
        Box::new(move |request| {
            if !request.url.starts_with("http://127.0.0.1:9098/") {
                return ok_json();
            }
            // The remote agent is busy once, then deploys.
            if remote_calls.fetch_add(1, Ordering::SeqCst) == 0 {
                Ok(OutboundResponse {
                    status: 503,
                    body: b"busy".to_vec(),
                })
            } else {
                ok_json()
            }
        }),
    );
    let targets = json!({
        "alex": compose_target(&scratch, "alex.json", "alexgetman-backend"),
        "worker": {
            "stateFile": scratch.path("worker.json"),
            "remoteUrl": "http://127.0.0.1:9098/",
            "remoteToken": "worker-token",
            "artifactFile": scratch.path("artifact.json"),
            "repository": worker,
            "allowInitialSeed": true,
        },
    });
    let agent = agent(&targets, true, Arc::clone(&fake));

    let (status, answer) = call(
        &agent,
        "POST",
        "/v1/deploy",
        Some(TOKEN),
        Some(json!({"image": image('2'), "release": release})),
    )
    .await;
    assert_eq!(status, 200, "{answer}");
    // The bot's confirmation callbacks (`bot::deployment`), one row each.
    assert_eq!(
        fake.notifications()[0],
        json!({
            "chat_id": "1",
            "text": format!("Deploy alex {} successful and healthy.", &release[..12]),
            "reply_markup": {"inline_keyboard": [
                [{"text": "Откатить alex", "callback_data": format!("deploy_rb_ask:alex:{release}")}],
                [{"text": "Раскатить worker", "callback_data": format!("deploy_pr_ask:worker:{release}")}],
            ]},
        })
    );

    assert_eq!(
        call(
            &agent,
            "POST",
            "/v1/promote/worker",
            Some(TOKEN),
            Some(json!({"release": "c".repeat(40)}))
        )
        .await,
        (
            409,
            json!({"ok": false, "message": "This button belongs to an older source release."})
        )
    );
    let (status, answer) = call(
        &agent,
        "POST",
        "/v1/promote/worker",
        Some(TOKEN),
        Some(json!({"release": release})),
    )
    .await;
    assert_eq!(
        (status, answer),
        (
            200,
            json!({"ok": true, "target": "worker", "release": release, "currentRevision": release})
        )
    );
    let remote = fake.requests_to("/v1/deploy");
    assert_eq!(remote.len(), 2, "a 503 is retried");
    assert_eq!(remote[1].url, "http://127.0.0.1:9098/v1/deploy");
    assert!(
        remote[1]
            .headers
            .contains(&("authorization", "Bearer worker-token".to_owned()))
    );
    assert_eq!(
        serde_json::from_str::<Value>(remote[1].body.as_deref().unwrap()).unwrap(),
        json!({"image": worker_image, "release": release})
    );
    assert_eq!(scratch.json("worker.json")["current"]["image"], worker_image.as_str());
    let worker_notice = fake.notifications().last().unwrap().clone();
    assert_eq!(
        worker_notice["reply_markup"]["inline_keyboard"],
        json!([[{"text": "Откатить worker", "callback_data": format!("deploy_rb_ask:worker:{release}")}]])
    );

    // A release that alex runs but no artifact was registered for.
    seed(&scratch, "alex.json", &image('3'), &"d".repeat(40));
    assert_eq!(
        call(
            &agent,
            "POST",
            "/v1/promote/worker",
            Some(TOKEN),
            Some(json!({"release": "d".repeat(40)}))
        )
        .await,
        (
            409,
            json!({"ok": false, "message": format!("No immutable remote artifact is registered for {}.", "d".repeat(40))})
        )
    );
}

#[tokio::test]
async fn requests_are_validated_before_anything_runs() {
    let scratch = Scratch::new("validation");
    let fake = Fake::new(Box::new(|_| Output::default()), Box::new(|_| ok_json()));
    let agent = agent(
        &json!({"alex": compose_target(&scratch, "state.json", "backend")}),
        false,
        Arc::clone(&fake),
    );
    let deploy = |image: String| json!({"image": image, "release": "a".repeat(40)});
    assert_eq!(
        call(
            &agent,
            "POST",
            "/v1/deploy",
            Some(TOKEN),
            Some(deploy("ghcr.io/other/backend:latest".into()))
        )
        .await,
        (
            400,
            json!({"ok": false, "message": "image must be an immutable configured GHCR digest and release must be a Git SHA."})
        )
    );
    assert_eq!(
        call(&agent, "POST", "/v1/deploy/maru", Some(TOKEN), Some(deploy(image('2')))).await,
        (404, json!({"ok": false, "message": "Unknown deployment target: maru"}))
    );
    assert_eq!(
        call(
            &agent,
            "POST",
            "/v1/rollback/alex",
            Some(TOKEN),
            Some(json!({"release": "main"}))
        )
        .await,
        (400, json!({"ok": false, "message": "release must be a Git SHA."}))
    );
    assert_eq!(
        call(
            &agent,
            "POST",
            "/v1/rollback/alex",
            Some(TOKEN),
            Some(json!({"release": "a".repeat(40)}))
        )
        .await,
        (
            409,
            json!({"ok": false, "message": "No rollback release is available."})
        )
    );
    assert_eq!(
        call(&agent, "GET", "/v1/deploy", Some(TOKEN), None).await,
        (404, json!({"ok": false, "message": "not found"}))
    );
    // No digest anywhere to roll back to, and no permission to seed one.
    assert_eq!(
        call(&agent, "POST", "/v1/deploy", Some(TOKEN), Some(deploy(image('2')))).await,
        (
            409,
            json!({"ok": false, "message": "Current release is not an immutable GHCR digest; seed the target's imageEnvFile before deploying."})
        )
    );
    assert!(!fake.commands().iter().any(|command| command.contains("pull")));
}

#[test]
fn the_configuration_is_refused_whole_rather_than_half_used() {
    let refused = |targets: &str| {
        Config::from_env(
            [("DEPLOY_AGENT_TOKEN", "token"), ("DEPLOY_TARGETS_JSON", targets)]
                .map(|(key, value)| (key.to_owned(), value.to_owned())),
        )
        .unwrap_err()
    };
    let compose = r#""composeFile":"c","imageEnvFile":"e","stateFile":"s","container":"x""#;
    assert_eq!(refused("{}"), "DEPLOY_TARGETS_JSON must configure at least one target.");
    assert_eq!(
        refused(&format!(r#"{{"toolongname":{{{compose},"healthUrl":"http://a/"}}}}"#)),
        "Invalid deployment target name: toolongname"
    );
    assert_eq!(
        refused(r#"{"alex":{"stateFile":"s","composeFile":"c"}}"#),
        "Deployment target alex is missing imageEnvFile"
    );
    assert_eq!(
        refused(&format!(r#"{{"alex":{{{compose},"healthUrl":"https://a/readyz"}}}}"#)),
        r#"Deployment target alex's healthUrl must be an http:// URL, got "https://a/readyz""#
    );
    assert_eq!(
        refused(&format!(
            r#"{{"alex":{{{compose},"healthUrl":"http://a/","configCheck":"no"}}}}"#
        )),
        "Deployment target alex's configCheck must be true or false"
    );
    assert_eq!(
        Config::from_env([("DEPLOY_TARGETS_JSON".to_owned(), "{}".to_owned())]).unwrap_err(),
        "DEPLOY_AGENT_TOKEN is required"
    );
}
