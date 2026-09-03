import { timingSafeEqual } from "node:crypto";
import { mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { isTransientDeploymentError, withRetry } from "./retry.ts";

type Release = { image: string; revision: string; deployedAt: string };
type DeploymentState = {
  current?: Release;
  previous?: Release;
  lastFailure?: { revision: string; message: string; at: string };
};
type CommonTarget = {
  name: string;
  stateFile: string;
  /** First rollout has no trustworthy immutable image to roll back to. */
  allowInitialSeed?: boolean;
};
/** Deployed here, by driving Compose on this host. */
type ComposeTarget = CommonTarget & {
  kind: "compose";
  composeFile: string;
  imageEnvFile: string;
  healthUrl: string;
  container: string;
  service: string;
  imageEnvKey: string;
};
/** Deployed by handing the release to an agent on another host. */
type RemoteTarget = CommonTarget & {
  kind: "remote";
  remoteUrl: string;
  remoteToken: string;
  artifactFile: string;
  repository: string;
};
/** The two shapes share no deployment mechanics, so `kind` discriminates
 * them: narrowing on it is what lets the Compose paths below read composeFile
 * and container as the required strings deploymentTargets() already validated. */
type DeploymentTarget = ComposeTarget | RemoteTarget;

const config = {
  host: Bun.env.DEPLOY_AGENT_HOST ?? "172.17.0.1",
  port: Number(Bun.env.DEPLOY_AGENT_PORT ?? "9899"),
  token: required("DEPLOY_AGENT_TOKEN"),
  repository: Bun.env.DEPLOY_IMAGE_REPOSITORY ?? "ghcr.io/alexgetmancom/solo-publisher",
  /** The Studio CI deploys directly; every other target is promoted from its
   * notification, so this one carries the rollback and promotion buttons. */
  defaultTarget: "alex",
  notificationToken: Bun.env.DEPLOY_NOTIFICATION_BOT_TOKEN ?? Bun.env.CONTROLLER_BOT_TOKEN,
  notificationChatId: Bun.env.DEPLOY_NOTIFICATION_CHAT_ID,
  notificationApiBaseUrl: Bun.env.DEPLOY_NOTIFICATION_API_BASE_URL ?? "http://127.0.0.1:8081",
  retry: {
    attempts: integerEnv("DEPLOY_RETRY_ATTEMPTS", 3, 1),
    initialDelayMs: integerEnv("DEPLOY_RETRY_BACKOFF_MS", 5_000, 0),
    maxDelayMs: integerEnv("DEPLOY_RETRY_MAX_BACKOFF_MS", 30_000, 0),
  },
};

let deploying = false;

function required(name: string): string {
  const value = Bun.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function integerEnv(name: string, fallback: number, minimum: number): number {
  const value = Number(Bun.env[name]);
  return Number.isInteger(value) && value >= minimum ? value : fallback;
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function immutableImage(value: unknown, repository = config.repository): value is string {
  return (
    typeof value === "string" &&
    value.startsWith(`${repository}@sha256:`) &&
    /^[a-f0-9]{64}$/i.test(value.slice(value.lastIndexOf(":") + 1))
  );
}

function revision(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{7,40}$/i.test(value);
}

function deploymentTargets(): Map<string, DeploymentTarget> {
  const parsed = JSON.parse(required("DEPLOY_TARGETS_JSON")) as Record<string, Record<string, unknown>>;
  const targets = new Map<string, DeploymentTarget>();
  const text = (value: Record<string, unknown>, key: string): string | undefined => {
    const found = value[key];
    return typeof found === "string" && found.trim() ? found : undefined;
  };
  const requireText = (value: Record<string, unknown>, name: string, key: string): string => {
    const found = text(value, key);
    if (!found) throw new Error(`Deployment target ${name} is missing ${key}`);
    return found;
  };
  for (const [name, value] of Object.entries(parsed)) {
    if (!/^[a-z][a-z0-9_-]{0,6}$/.test(name)) throw new Error(`Invalid deployment target name: ${name}`);
    if (!value || typeof value !== "object") throw new Error(`Invalid deployment target: ${name}`);
    const common = {
      name,
      stateFile: requireText(value, name, "stateFile"),
      allowInitialSeed: value.allowInitialSeed === true,
    };
    if (value.remoteUrl != null) {
      targets.set(name, {
        ...common,
        kind: "remote",
        remoteUrl: requireText(value, name, "remoteUrl"),
        remoteToken: requireText(value, name, "remoteToken"),
        artifactFile: requireText(value, name, "artifactFile"),
        repository: requireText(value, name, "repository"),
      });
      continue;
    }
    targets.set(name, {
      ...common,
      kind: "compose",
      composeFile: requireText(value, name, "composeFile"),
      imageEnvFile: requireText(value, name, "imageEnvFile"),
      healthUrl: requireText(value, name, "healthUrl"),
      container: requireText(value, name, "container"),
      service: text(value, "service") ?? "backend",
      imageEnvKey: text(value, "imageEnvKey") ?? "BACKEND_IMAGE",
    });
  }
  if (targets.size === 0) throw new Error("DEPLOY_TARGETS_JSON must configure at least one target.");
  return targets;
}

const targets = deploymentTargets();

function target(name: string | undefined): DeploymentTarget {
  const selected = targets.get(name ?? config.defaultTarget);
  if (!selected) throw new HttpError(404, `Unknown deployment target: ${name ?? config.defaultTarget}`);
  return selected;
}

async function command(args: string[], allowFailure = false): Promise<string> {
  const child = Bun.spawn(["docker", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0 && !allowFailure) throw new Error(stderr.trim() || `docker ${args.join(" ")} exited with ${code}`);
  return stdout.trim();
}

function composeArgs(deploymentTarget: ComposeTarget, ...args: string[]): string[] {
  return ["compose", "--env-file", deploymentTarget.imageEnvFile, "-f", deploymentTarget.composeFile, ...args];
}

async function state(deploymentTarget: DeploymentTarget): Promise<DeploymentState> {
  const file = Bun.file(deploymentTarget.stateFile);
  if (!(await file.exists())) return {};
  const parsed = await file.json().catch(() => null);
  return parsed && typeof parsed === "object" ? (parsed as DeploymentState) : {};
}

async function writeState(deploymentTarget: DeploymentTarget, value: DeploymentState): Promise<void> {
  await mkdir(dirname(deploymentTarget.stateFile), { recursive: true });
  await Bun.write(deploymentTarget.stateFile, `${JSON.stringify(value, null, 2)}\n`);
}

async function currentImage(deploymentTarget: DeploymentTarget): Promise<string | undefined> {
  if (deploymentTarget.kind === "remote") return (await state(deploymentTarget)).current?.image;
  const env = await Bun.file(deploymentTarget.imageEnvFile)
    .text()
    .catch(() => "");
  const declared = env.match(new RegExp(`^${deploymentTarget.imageEnvKey}=(.+)$`, "m"))?.[1]?.trim();
  if (immutableImage(declared)) return declared;
  const repoDigest = await command(["image", "inspect", "--format", "{{index .RepoDigests 0}}", deploymentTarget.container], true);
  return immutableImage(repoDigest) ? repoDigest : undefined;
}

async function runningContainerImage(deploymentTarget: DeploymentTarget): Promise<string | undefined> {
  if (deploymentTarget.kind === "remote") return undefined;
  const repoDigest = await command(["image", "inspect", "--format", "{{index .RepoDigests 0}}", deploymentTarget.container], true);
  return immutableImage(repoDigest) ? repoDigest : undefined;
}

async function writeImage(deploymentTarget: ComposeTarget, image: string): Promise<void> {
  const temporary = `${deploymentTarget.imageEnvFile}.next`;
  const existing = await Bun.file(deploymentTarget.imageEnvFile)
    .text()
    .catch(() => "");
  const preserved = existing
    .split(/\r?\n/)
    .filter((line) => !line.startsWith(`${deploymentTarget.imageEnvKey}=`))
    .filter(Boolean);
  await Bun.write(temporary, [`${deploymentTarget.imageEnvKey}=${image}`, ...preserved, ""].join("\n"));
  await rename(temporary, deploymentTarget.imageEnvFile);
}

async function waitForHealthy(deploymentTarget: ComposeTarget): Promise<void> {
  const deadline = Date.now() + 90_000;
  let last = "container did not become ready";
  while (Date.now() < deadline) {
    const health = await command(
      ["inspect", "--format", "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}", deploymentTarget.container],
      true,
    );
    if (health === "unhealthy" || health === "exited" || health === "dead")
      throw new Error(`container state is ${health}\n${await containerDiagnostics(deploymentTarget)}`);
    try {
      const response = await fetch(deploymentTarget.healthUrl, {
        signal: AbortSignal.timeout(5_000),
      });
      if (response.ok) return;
      last = `readyz returned ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await Bun.sleep(2_000);
  }
  throw new Error(`health check timeout: ${last}\n${await containerDiagnostics(deploymentTarget)}`);
}

async function containerDiagnostics(deploymentTarget: ComposeTarget): Promise<string> {
  const [health, logs] = await Promise.all([
    diagnosticCommand(["inspect", "--format", "{{json .State.Health}}", deploymentTarget.container]),
    diagnosticCommand(["logs", "--tail", "40", deploymentTarget.container]),
  ]);
  return [`health: ${health || "unavailable"}`, `logs:\n${logs || "unavailable"}`].join("\n").slice(0, 6_000);
}

async function diagnosticCommand(args: string[]): Promise<string> {
  const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
}

async function retryDeployment<T>(operation: string, run: () => Promise<T>, shouldRetry = isTransientDeploymentError): Promise<T> {
  return withRetry(run, {
    ...config.retry,
    shouldRetry,
    onRetry: (error, failedAttempt, delayMs) =>
      console.error(
        JSON.stringify({
          level: "warn",
          message: "deployment operation failed; retrying",
          operation,
          failedAttempt,
          nextAttempt: failedAttempt + 1,
          maxAttempts: config.retry.attempts,
          delayMs,
          error: String(error).slice(0, 400),
        }),
      ),
  });
}

class RemoteDeployError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function shouldRetryRemoteDeploy(error: unknown): boolean {
  if (error instanceof RemoteDeployError) return [408, 425, 429, 502, 503, 504].includes(error.status);
  return isTransientDeploymentError(error);
}

async function activate(deploymentTarget: DeploymentTarget, image: string, release: string, validateConfig = false): Promise<void> {
  if (deploymentTarget.kind === "remote") {
    await retryDeployment(
      `remote deploy ${deploymentTarget.name}`,
      async () => {
        const response = await fetch(`${deploymentTarget.remoteUrl.replace(/\/$/, "")}/v1/deploy`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${deploymentTarget.remoteToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ image, release }),
          signal: AbortSignal.timeout(150_000),
        });
        if (!response.ok)
          throw new RemoteDeployError(
            response.status,
            `remote deploy failed (${response.status}): ${(await response.text()).slice(0, 400)}`,
          );
      },
      shouldRetryRemoteDeploy,
    );
    return;
  }
  await writeImage(deploymentTarget, image);
  await retryDeployment(`image pull ${deploymentTarget.name}`, () =>
    command(composeArgs(deploymentTarget, "pull", deploymentTarget.service)),
  );
  if (validateConfig)
    await command(
      composeArgs(
        deploymentTarget,
        "run",
        "--rm",
        "--no-deps",
        "--entrypoint",
        "bun",
        deploymentTarget.service,
        "/app/entrypoint/config-check.js",
      ),
    );
  // The service has a stable container name. Removing it explicitly makes a
  // compose-project rename the same operation as every later replacement;
  // otherwise Docker refuses to create the new owner before Compose can act.
  await command(["rm", "-f", deploymentTarget.container], true);
  await command(composeArgs(deploymentTarget, "up", "-d", "--no-deps", "--force-recreate", deploymentTarget.service));
  await waitForHealthy(deploymentTarget);
}

async function notify(text: string, deploymentTarget: DeploymentTarget, release?: string, offerPromoteTo?: string[]): Promise<void> {
  if (!config.notificationToken || !config.notificationChatId) return;
  const buttons: { text: string; callback_data: string }[][] = [];
  // The bot asks for confirmation before actually acting, so these point at
  // the short "_ask" callbacks rather than the ones that execute directly.
  if (release)
    buttons.push([
      {
        text: `Откатить ${deploymentTarget.name}`,
        callback_data: `deploy_rb_ask:${deploymentTarget.name}:${release}`,
      },
    ]);
  if (release)
    for (const promoteTarget of offerPromoteTo ?? [])
      buttons.push([
        {
          text: `Раскатить ${promoteTarget}`,
          callback_data: `deploy_pr_ask:${promoteTarget}:${release}`,
        },
      ]);
  const reply_markup = buttons.length > 0 ? { inline_keyboard: buttons } : undefined;
  await fetch(`${config.notificationApiBaseUrl.replace(/\/$/, "")}/bot${config.notificationToken}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: config.notificationChatId,
      text,
      ...(reply_markup ? { reply_markup } : {}),
    }),
    signal: AbortSignal.timeout(10_000),
  }).catch((error) =>
    console.error(
      JSON.stringify({
        level: "error",
        message: "deploy notify failed",
        error: String(error),
      }),
    ),
  );
}

async function withDeploymentLock<T>(operation: () => Promise<T>): Promise<T> {
  if (deploying) throw new HttpError(409, "A deployment is already running.");
  deploying = true;
  try {
    return await operation();
  } finally {
    deploying = false;
  }
}

async function deploy(deploymentTarget: DeploymentTarget, image: string, release: string): Promise<DeploymentState> {
  return withDeploymentLock(async () => {
    const previousState = await state(deploymentTarget);
    let previousImage = await currentImage(deploymentTarget);
    // A failed first attempt may already have written the desired digest into
    // the env file. That is not a deployed rollback release.
    if (deploymentTarget.allowInitialSeed && !previousState.current) previousImage = await runningContainerImage(deploymentTarget);
    if (!previousImage && !deploymentTarget.allowInitialSeed)
      throw new HttpError(409, "Current release is not an immutable GHCR digest; seed the target's imageEnvFile before deploying.");
    const displaced: Release | undefined = previousImage
      ? (previousState.current ?? {
          image: previousImage,
          revision: previousImage.slice(-12),
          deployedAt: new Date().toISOString(),
        })
      : undefined;
    // Redeploying the release that is already current must not record it as its
    // own predecessor: the rollback would re-activate the image it is rolling
    // back from and report success, while the release actually worth returning
    // to is gone from the state. A same-release deploy keeps the predecessor it
    // already had.
    const previous = previousState.current?.revision === release ? previousState.previous : displaced;
    try {
      await activate(deploymentTarget, image, release, true);
      const next = {
        current: {
          image,
          revision: release,
          deployedAt: new Date().toISOString(),
        },
        ...(previous ? { previous } : {}),
      };
      await writeState(deploymentTarget, next);
      await notify(
        `Deploy ${deploymentTarget.name} ${release.slice(0, 12)} successful and healthy.`,
        deploymentTarget,
        release,
        promotionCandidate(deploymentTarget),
      );
      return next;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!previous) {
        const next = {
          ...previousState,
          lastFailure: {
            revision: release,
            message,
            at: new Date().toISOString(),
          },
        };
        await writeState(deploymentTarget, next);
        throw new HttpError(502, `Initial deploy failed and has no prior immutable image to roll back to: ${message}`);
      }
      try {
        await activate(deploymentTarget, previous.image, previous.revision);
      } catch (rollbackError) {
        throw new HttpError(500, `Deploy failed (${message}); automatic rollback also failed: ${String(rollbackError)}`);
      }
      const next = {
        ...previousState,
        current: previous,
        lastFailure: {
          revision: release,
          message,
          at: new Date().toISOString(),
        },
      };
      await writeState(deploymentTarget, next);
      await notify(
        `Deploy ${deploymentTarget.name} ${release.slice(0, 12)} failed; automatic rollback to ${previous.revision.slice(0, 12)} succeeded.\n\n${message}`.slice(
          0,
          4_000,
        ),
        deploymentTarget,
      );
      throw new HttpError(502, `Deploy failed and was rolled back: ${message}`);
    }
  });
}

/** Only "alex" is ever auto-deployed by CI; every other configured target is
 * deployed manually, by promoting the exact image alex just proved healthy. */
function promotionCandidate(deploymentTarget: DeploymentTarget): string[] {
  if (deploymentTarget.name !== config.defaultTarget) return [];
  return [...targets.keys()].filter((name) => name !== config.defaultTarget);
}

async function promote(sourceTarget: DeploymentTarget, destTarget: DeploymentTarget, release: string): Promise<DeploymentState> {
  const sourceState = await state(sourceTarget);
  if (sourceState.current?.revision !== release) throw new HttpError(409, "This button belongs to an older source release.");
  if (destTarget.kind === "compose") return deploy(destTarget, sourceState.current.image, release);
  const artifact = (await Bun.file(destTarget.artifactFile)
    .json()
    .catch(() => null)) as { image?: unknown; release?: unknown } | null;
  if (!artifact || artifact.release !== release || !immutableImage(artifact.image, destTarget.repository))
    throw new HttpError(409, `No immutable remote artifact is registered for ${release}.`);
  return deploy(destTarget, artifact.image, release);
}

async function rollback(deploymentTarget: DeploymentTarget, release: string): Promise<DeploymentState> {
  return withDeploymentLock(async () => {
    const before = await state(deploymentTarget);
    if (!before.current || !before.previous) throw new HttpError(409, "No rollback release is available.");
    if (before.current.revision !== release) throw new HttpError(409, "This rollback button belongs to an older release.");
    try {
      await activate(deploymentTarget, before.previous.image, before.previous.revision);
    } catch (error) {
      throw new HttpError(502, `Rollback failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const next = {
      current: { ...before.previous, deployedAt: new Date().toISOString() },
      previous: before.current,
    };
    await writeState(deploymentTarget, next);
    await notify(
      `Manual rollback of ${deploymentTarget.name} to ${next.current.revision.slice(0, 12)} successful and healthy.`,
      deploymentTarget,
      next.current.revision,
    );
    return next;
  });
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

async function requestHandler(request: Request): Promise<Response> {
  if (request.method === "GET" && new URL(request.url).pathname === "/healthz") return json({ ok: true, deploying });
  const received = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!constantTimeEqual(received, config.token)) return json({ ok: false, message: "forbidden" }, 403);
  try {
    const url = new URL(request.url);
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const [, , action, requestedTarget] = url.pathname.split("/");
    // Reading what is deployed, for every target this agent drives. The three
    // actions below are the only way anything learned a revision, so the
    // question "what is actually running, and what would a rollback go back
    // to" could be answered by deploying -- and by nothing else.
    if (request.method === "GET" && action === "releases") {
      return json({
        ok: true,
        deploying,
        targets: await Promise.all(
          [...targets.values()].map(async (deploymentTarget) => ({
            target: deploymentTarget.name,
            kind: deploymentTarget.kind,
            ...(await state(deploymentTarget)),
          })),
        ),
      });
    }
    const deploymentTarget = target(requestedTarget);
    if (request.method === "POST" && action === "deploy") {
      if (!immutableImage(body?.image) || !revision(body?.release))
        throw new HttpError(400, "image must be an immutable configured GHCR digest and release must be a Git SHA.");
      const next = await deploy(deploymentTarget, body.image, body.release);
      return json({
        ok: true,
        target: deploymentTarget.name,
        release: next.current?.revision,
        currentRevision: next.current?.revision,
      });
    }
    if (request.method === "POST" && action === "rollback") {
      if (!revision(body?.release)) throw new HttpError(400, "release must be a Git SHA.");
      const next = await rollback(deploymentTarget, body.release);
      return json({
        ok: true,
        target: deploymentTarget.name,
        release: next.current?.revision,
        currentRevision: next.current?.revision,
      });
    }
    if (request.method === "POST" && action === "promote") {
      if (!revision(body?.release)) throw new HttpError(400, "release must be a Git SHA.");
      const next = await promote(target(config.defaultTarget), deploymentTarget, body.release);
      return json({
        ok: true,
        target: deploymentTarget.name,
        release: next.current?.revision,
        currentRevision: next.current?.revision,
      });
    }
    return json({ ok: false, message: "not found" }, 404);
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const message = error instanceof Error ? error.message : String(error);
    return json({ ok: false, message }, status);
  }
}

function serve(hostname: string): void {
  Bun.serve({ hostname, port: config.port, fetch: requestHandler });
  console.log(
    JSON.stringify({
      level: "info",
      message: "deploy agent listening",
      host: hostname,
      port: config.port,
    }),
  );
}

serve("127.0.0.1");
// Also on the Docker bridge by default: the agent drives Compose on the host,
// so it cannot live inside the container that CI can reach — CI's runner calls
// it through the bridge address instead. That exposes the port to every
// container on this host, which is why the bearer token is required, compared
// in constant time, and checked before the body is even parsed. Set
// DEPLOY_AGENT_HOST=127.0.0.1 to bind loopback only where CI reaches the host
// some other way (e.g. over SSH).
if (config.host !== "127.0.0.1") serve(config.host);
