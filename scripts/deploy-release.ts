/**
 * The production deployment, as steps rather than as a shell block.
 *
 * It lived inline in the workflow, where the only thing that ever checked it
 * was `bash -n`. Four deployments broke in one afternoon on things a test would
 * have caught in a second: a file copied only when a diff happened to name it,
 * a path missing from the list that triggers a rebuild, an `awk … exit` that
 * killed docker through EPIPE and turned a finished push into a failed job.
 *
 * Every side effect goes through `run`, so the sequence can be driven against a
 * recorder and asserted. The workflow passes the real one.
 */

/** Bytes, not text: the release archive travels through here, and decoding a
 * tar stream as UTF-8 corrupts it silently. */
export type Command = { argv: string[]; stdin?: Uint8Array };
export type CommandResult = { code: number; stdout: Uint8Array };
export type Runner = (command: Command) => Promise<CommandResult>;

export type DeployInputs = {
  host: string;
  user: string;
  agentToken: string;
  image: string;
  mediaProcessorImage: string;
  release: string;
  deployAgentChanged: boolean;
  caddyConfigChanged: boolean;
  maruDeployEnabled: boolean;
  promoteMaru: boolean;
  publicReadyUrl: string;
  controlPath: string;
};

const RUNTIME = "/home/deploy/alexgetman-runtime";
const MARU_RUNTIME = "/home/deploy/maru";
const CADDY_RUNTIME = "/home/deploy/caddy";
const STATE_DIR = "/var/lib/alexgetman-deploy";
const AGENT = "http://127.0.0.1:9899";
const MARU_READY_URL = "http://127.0.0.1:8789/readyz";
const IMAGE_PATTERN = "^ghcr.io/alexgetmancom/solo-publisher@sha256:[0-9a-fA-F]{64}$";

/** Configuration travels with every deployment, never only when a diff named
 * it: a run that fails after the commit that changed it would otherwise leave
 * the host on a configuration the repository has moved past, and no later run
 * would ever mention those files again. */
const ALWAYS_SHIPPED = ["deploy/studio.compose.yaml", "deploy/alex.env", "deploy/maru.env"];

export async function deployRelease(inputs: DeployInputs, run: Runner, log: (message: string) => void = console.log): Promise<void> {
  for (const [name, value] of [
    ["DEPLOY_HOST", inputs.host],
    ["DEPLOY_USER", inputs.user],
    ["DEPLOY_AGENT_TOKEN", inputs.agentToken],
    ["IMAGE", inputs.image],
  ] as const)
    if (!value) throw new Error(`${name} is required`);
  // Promoting into a runtime this run never configured would activate an image
  // against whatever compose file and env the host happens to still carry.
  if (inputs.promoteMaru && !inputs.maruDeployEnabled) throw new Error("PROMOTE_MARU requires MARU_DEPLOY_ENABLED");

  const remote = `${inputs.user}@${inputs.host}`;
  const sshOptions = [
    "-o",
    "BatchMode=yes",
    "-o",
    "ControlMaster=auto",
    "-o",
    "ControlPersist=60",
    "-o",
    `ControlPath=${inputs.controlPath}`,
  ];
  const releaseFiles = `${RUNTIME}/release-files/${inputs.release}`;
  let phaseStarted = Date.now();
  const phase = (name: string) => {
    log(`::notice::deploy timing: ${name}=${Math.round((Date.now() - phaseStarted) / 1000)}s`);
    phaseStarted = Date.now();
  };

  const ssh = async (script: string, stdin?: Uint8Array): Promise<void> => {
    const result = await run({
      argv: ["ssh", ...sshOptions, remote, script],
      ...(stdin === undefined ? {} : { stdin }),
    });
    if (result.code !== 0) {
      const detail = new TextDecoder().decode(result.stdout).trim().slice(-4_000);
      throw new Error(`remote command failed (${result.code}): ${script.slice(0, 120)}${detail ? `\n${detail}` : ""}`);
    }
  };

  const mediaRelease = JSON.stringify({
    release: inputs.release,
    image: inputs.mediaProcessorImage,
  });
  await ssh(`install -d -m 0700 ${STATE_DIR}`);
  await ssh(`umask 077; cat > ${STATE_DIR}/media-processor-release.json`, new TextEncoder().encode(`${mediaRelease}\n`));
  // Scratch for this release only, removed again once the deployment is green.
  // A run that fails after this point never reaches that removal, so the whole
  // tree is pruned on the way in rather than only on the way out: eleven
  // directories from failed runs had collected here before it was. Deployments
  // are serialized by the `production-deploy` concurrency group, so no other
  // run owns a directory under it.
  await ssh(`rm -rf ${RUNTIME}/release-files; install -d -m 0700 '${releaseFiles}'`);

  const paths = [...ALWAYS_SHIPPED];
  if (inputs.deployAgentChanged) paths.push("deploy/deploy-agent.ts", "deploy/retry.ts");
  if (inputs.caddyConfigChanged) paths.push("deploy/caddy/Caddyfile", "deploy/caddy/compose.yaml");
  const archive = await run({ argv: ["tar", "-cf", "-", ...paths] });
  if (archive.code !== 0) throw new Error("could not archive the release files");
  await ssh(`tar -xf - -C '${releaseFiles}'`, archive.stdout);

  const installStudioConfig = async (runtime: string, deployment: "alex" | "maru"): Promise<void> =>
    ssh(
      `set -e; image=$(sed -n 's/^BACKEND_IMAGE=//p' ${runtime}/deploy-image.env | tail -n 1); ` +
        `printf '%s\n' "$image" | grep -Eq '${IMAGE_PATTERN}' || exit 1; ` +
        `cat '${releaseFiles}/deploy/${deployment}.env' > ${runtime}/deploy-image.env.next; ` +
        `printf 'BACKEND_IMAGE=%s\n' "$image" >> ${runtime}/deploy-image.env.next; ` +
        `cp '${releaseFiles}/deploy/studio.compose.yaml' ${runtime}/compose.yaml.next; ` +
        `docker compose --env-file ${runtime}/deploy-image.env.next -f ${runtime}/compose.yaml.next config --quiet; ` +
        `mv ${runtime}/deploy-image.env.next ${runtime}/deploy-image.env; ` +
        `mv ${runtime}/compose.yaml.next ${runtime}/compose.yaml`,
    );

  await installStudioConfig(RUNTIME, "alex");
  if (inputs.deployAgentChanged)
    await ssh(
      `set -e; install -m 0644 '${releaseFiles}/deploy/deploy-agent.ts' /home/deploy/repos/alexgetman.com/deploy/deploy-agent.ts; ` +
        `install -m 0644 '${releaseFiles}/deploy/retry.ts' /home/deploy/repos/alexgetman.com/deploy/retry.ts; ` +
        `sudo systemctl restart alexgetman-deploy-agent; ` +
        `for attempt in 1 2 3 4 5; do curl --fail --silent ${AGENT}/healthz && exit 0; sleep 1; done; exit 1`,
    );
  if (inputs.maruDeployEnabled) await installStudioConfig(MARU_RUNTIME, "maru");
  phase("runtime-config");

  if (inputs.caddyConfigChanged)
    // `caddy validate` parses the file the container will read, so a typo fails
    // here instead of taking every domain down on reload. A reload keeps
    // connections; it does not restart the proxy.
    await ssh(
      `set -e; cp '${releaseFiles}/deploy/caddy/Caddyfile' ${CADDY_RUNTIME}/Caddyfile.next; ` +
        `cp '${releaseFiles}/deploy/caddy/compose.yaml' ${CADDY_RUNTIME}/compose.yaml.next; ` +
        `docker compose -f ${CADDY_RUNTIME}/compose.yaml.next config --quiet; ` +
        `docker exec -i caddy caddy validate --adapter caddyfile --config - < ${CADDY_RUNTIME}/Caddyfile.next; ` +
        // The Caddyfile is bind-mounted into the container as a single file, so
        // the mount follows the inode, not the name: `mv` would replace the name
        // on the host and leave the container reading the old file forever, and
        // the reload right after would report success on config nothing served.
        // Overwrite the existing inode in place instead.
        `cat ${CADDY_RUNTIME}/Caddyfile.next > ${CADDY_RUNTIME}/Caddyfile; rm ${CADDY_RUNTIME}/Caddyfile.next; ` +
        `mv ${CADDY_RUNTIME}/compose.yaml.next ${CADDY_RUNTIME}/compose.yaml; ` +
        `docker exec caddy caddy reload --config /etc/caddy/Caddyfile`,
    );
  phase("caddy-config");

  const payload = JSON.stringify({
    image: inputs.image,
    release: inputs.release,
  });
  await ssh(
    `curl --fail-with-body --silent --show-error --max-time 180 -H 'Authorization: Bearer ${inputs.agentToken}' ` +
      `-H 'Content-Type: application/json' --data '${payload}' ${AGENT}/v1/deploy`,
  );
  phase("backend-activation");

  // Both Studios, together: a slow one must not hide a broken one behind it.
  const readiness = await Promise.all([
    run({
      argv: ["curl", "--fail", "--silent", "--show-error", "--retry", "3", "--retry-all-errors", inputs.publicReadyUrl],
    }),
    run({
      argv: ["ssh", ...sshOptions, remote, `curl --fail --silent --show-error --retry 3 --retry-all-errors ${MARU_READY_URL}`],
    }),
  ]);
  if (readiness.some((result) => result.code !== 0)) throw new Error("a Studio did not become ready after activation");
  phase("readiness");

  // Promotion, not a second deployment: the agent activates on Maru the exact
  // image alex has just proved healthy, through the same endpoint the
  // notification button calls. Only after alex is ready, so a broken release
  // never reaches the second audience. The agent waits on Maru's own /readyz
  // and rolls back before it answers, so a failed promotion fails this step.
  if (inputs.promoteMaru) {
    await ssh(
      `curl --fail-with-body --silent --show-error --max-time 180 -H 'Authorization: Bearer ${inputs.agentToken}' ` +
        `-H 'Content-Type: application/json' --data '${JSON.stringify({ release: inputs.release })}' ${AGENT}/v1/promote/maru`,
    );
    phase("maru-promotion");
  }

  // Reconcile deploy-image.env with what is now actually running, so a manual
  // `docker compose up` starts the release that was just verified. It reads each
  // target's own state file, which is the one the agent writes, and requires it
  // to name this run's image rather than merely look like a digest. Maru is
  // reconciled only when this run promoted it; otherwise it is running whatever
  // an earlier button press left there, and rewriting its env would assert
  // something this workflow never performed.
  const reconcile = async (runtime: string, deployment: "alex" | "maru"): Promise<void> =>
    ssh(
      `set -e; image=$(bun -e 'const state=JSON.parse(await Bun.file("${STATE_DIR}/${deployment}.json").text()); process.stdout.write(state.current?.image ?? "")'); ` +
        `printf '%s\\n' "$image" | grep -Eq '${IMAGE_PATTERN}' || exit 1; ` +
        `test "$image" = '${inputs.image}'; ` +
        `if ! grep -Eq "^BACKEND_IMAGE=$image\\$" "${runtime}/deploy-image.env"; then ` +
        `tmp="${runtime}/deploy-image.env.next"; ` +
        `{ grep -v '^BACKEND_IMAGE=' "${runtime}/deploy-image.env" || true; printf 'BACKEND_IMAGE=%s\\n' "$image"; } > "$tmp"; ` +
        `mv "$tmp" "${runtime}/deploy-image.env"; fi`,
    );
  await reconcile(RUNTIME, "alex");
  if (inputs.promoteMaru) await reconcile(MARU_RUNTIME, "maru");
  phase("image-reconciliation");

  await ssh(`rm -rf '${releaseFiles}'`);
  phase("cleanup");
  await run({ argv: ["ssh", ...sshOptions, "-O", "exit", remote] });
}

async function main(): Promise<void> {
  const env = Bun.env;
  const runner: Runner = async ({ argv, stdin }) => {
    const proc = Bun.spawn(argv, {
      stdin: stdin ?? "ignore",
      stdout: "pipe",
      stderr: "inherit",
    });
    const stdout = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
    return { code: await proc.exited, stdout };
  };
  await deployRelease(
    {
      host: env.DEPLOY_HOST ?? "",
      user: env.DEPLOY_USER ?? "",
      agentToken: env.DEPLOY_AGENT_TOKEN ?? "",
      image: env.IMAGE ?? "",
      mediaProcessorImage: env.MEDIA_PROCESSOR_IMAGE ?? "",
      release: env.RELEASE ?? "",
      deployAgentChanged: env.DEPLOY_AGENT_CHANGED === "true",
      caddyConfigChanged: env.CADDY_CONFIG_CHANGED === "true",
      maruDeployEnabled: env.MARU_DEPLOY_ENABLED === "true",
      promoteMaru: env.PROMOTE_MARU === "true",
      publicReadyUrl: env.PUBLIC_READY_URL ?? "https://alexgetman.com/readyz",
      controlPath: `${env.RUNNER_TEMP ?? "/tmp"}/deploy-ssh-%C`,
    },
    runner,
  );
}

if (import.meta.main) await main();
