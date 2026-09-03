import { afterEach, describe, expect, it } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe("deploy agent executable", () => {
  it("runs candidate preflight and preserves container diagnostics through automatic rollback", async () => {
    const directory = await mkdtemp(join(tmpdir(), "deploy-agent-test-"));
    temporaryDirectories.push(directory);
    const docker = join(directory, "docker");
    const commandLog = join(directory, "docker-commands.log");
    const imageEnv = join(directory, "image.env");
    const stateFile = join(directory, "state.json");
    const oldRevision = "a".repeat(40);
    const nextRevision = "b".repeat(40);
    const repository = "ghcr.io/example/backend";
    const oldImage = `${repository}@sha256:${"1".repeat(64)}`;
    const nextImage = `${repository}@sha256:${"2".repeat(64)}`;
    await Bun.write(imageEnv, `BACKEND_IMAGE=${oldImage}\n`);
    await Bun.write(
      stateFile,
      `${JSON.stringify({ current: { image: oldImage, revision: oldRevision, deployedAt: "2026-01-01T00:00:00.000Z" } })}\n`,
    );
    await Bun.write(
      docker,
      `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$1 $2" in
  "image inspect") printf '%s\\n' '${oldImage}' ;;
  "inspect --format")
    case "$3" in
      *json*) printf '%s\\n' '{"Status":"unhealthy","FailingStreak":1,"Log":[{"Output":"invalid production config"}]}' ;;
      *)
        if grep -q '${nextImage}' "$FAKE_IMAGE_ENV"; then printf '%s\\n' unhealthy; else printf '%s\\n' running; fi
        ;;
    esac
    ;;
  "logs --tail") printf '%s\\n' 'Config validation failed: CONTROLLER_ADMIN_IDS is required' >&2 ;;
esac
`,
    );
    await chmod(docker, 0o755);

    const notifications: Array<Record<string, unknown>> = [];
    const supportServer = Bun.serve({
      port: 0,
      async fetch(request) {
        if (new URL(request.url).pathname === "/readyz") return new Response("ok");
        notifications.push((await request.json()) as Record<string, unknown>);
        return Response.json({ ok: true });
      },
    });
    const supportPort = supportServer.port;
    if (supportPort === undefined) throw new Error("Test support server did not bind a port.");
    const agentPort = supportPort + 1;
    const agent = Bun.spawn([process.execPath, join(import.meta.dir, "deploy-agent.ts")], {
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH ?? ""}`,
        FAKE_DOCKER_LOG: commandLog,
        FAKE_IMAGE_ENV: imageEnv,
        DEPLOY_AGENT_HOST: "127.0.0.1",
        DEPLOY_AGENT_PORT: String(agentPort),
        DEPLOY_AGENT_TOKEN: "test-token",
        DEPLOY_IMAGE_REPOSITORY: repository,
        DEPLOY_TARGETS_JSON: JSON.stringify({
          alex: {
            composeFile: join(directory, "compose.yaml"),
            imageEnvFile: imageEnv,
            stateFile,
            healthUrl: `http://127.0.0.1:${supportPort}/readyz`,
            container: "backend",
          },
        }),
        DEPLOY_NOTIFICATION_BOT_TOKEN: "bot-token",
        DEPLOY_NOTIFICATION_CHAT_ID: "1",
        DEPLOY_NOTIFICATION_API_BASE_URL: `http://127.0.0.1:${supportPort}`,
        DEPLOY_RETRY_ATTEMPTS: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      let response: Response | undefined;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        response = await fetch(`http://127.0.0.1:${agentPort}/healthz`).catch(() => undefined);
        if (response?.ok) break;
        await Bun.sleep(20);
      }
      expect(response?.ok).toBe(true);

      // Reading what is deployed, without deploying to find out. Behind the
      // same bearer token as every action: the state names images and
      // revisions, and the port is on the Docker bridge.
      expect((await fetch(`http://127.0.0.1:${agentPort}/v1/releases`)).status).toBe(403);
      const releases = await fetch(`http://127.0.0.1:${agentPort}/v1/releases`, {
        headers: { authorization: "Bearer test-token" },
      });
      expect(releases.ok).toBe(true);
      expect(await releases.json()).toMatchObject({
        ok: true,
        deploying: false,
        targets: [{ target: "alex", kind: "compose", current: { image: oldImage, revision: oldRevision } }],
      });

      const deployed = await fetch(`http://127.0.0.1:${agentPort}/v1/deploy/alex`, {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({ image: nextImage, release: nextRevision }),
      });
      expect(deployed.status).toBe(502);

      const state = (await Bun.file(stateFile).json()) as { current: { image: string }; lastFailure: { message: string } };
      expect(state.current.image).toBe(oldImage);
      expect(state.lastFailure.message).toContain("invalid production config");
      expect(state.lastFailure.message).toContain("CONTROLLER_ADMIN_IDS is required");
      const commands = await Bun.file(commandLog).text();
      expect(commands).toContain("run --rm --no-deps --entrypoint bun backend /app/entrypoint/config-check.js");
      expect(commands).toContain("rm -f backend");
      expect(notifications.at(-1)?.text).toContain("CONTROLLER_ADMIN_IDS is required");
    } finally {
      agent.kill();
      await agent.exited;
      supportServer.stop(true);
    }
  });
});
