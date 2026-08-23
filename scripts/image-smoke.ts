import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RESPONSIVE_WIDTHS } from "../apps/backend/src/content/site-media-naming.ts";
import { responsiveWebpFfmpegArgs, sitePosterFfmpegArgs, siteVerticalFfmpegArgs } from "../apps/backend/src/delivery/site-media.js";
import { devFixture, seedSiteFixture } from "../apps/web/src/server/site-fixture.js";
import { storyFfmpegArgs } from "../deploy/media-processor/story-encode.js";

/**
 * Boots the built backend image against a throwaway seeded database and walks
 * the public SSR routes, the ops CLI and ffmpeg.
 *
 * This exists because the image ships a *pruned* node_modules (see the
 * prod-deps stage in apps/backend/Dockerfile). Astro leaves externals
 * unbundled in dist/server/chunks/*.mjs, so a new bare import in apps/web can
 * silently land on a package the prune removed. Nothing else catches that:
 *   - `bun run build` succeeds, the missing package is present on the runner;
 *   - apps/web/src/server/home.smoke.test.ts drives `astro dev` from the repo,
 *     not the image, so it resolves against the full node_modules;
 *   - the container starts fine and only fails per request, with every SSR
 *     route returning 500 while /healthz and static files still answer 200.
 * Hence: run the real image, and assert on rendered bodies rather than on
 * process liveness.
 *
 *   IMAGE=ghcr.io/...:tag bun scripts/image-smoke.ts
 */

const image = process.env.IMAGE;
if (!image) {
  console.error("IMAGE is required, e.g. IMAGE=ghcr.io/owner/solo-publisher:tag");
  process.exit(1);
}

const container = `image-smoke-${process.pid}`;
const volume = `image-smoke-${process.pid}`;
const backupVolume = `image-smoke-backup-${process.pid}`;
const port = 18000 + (process.pid % 20000);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "image-smoke-"));
const dataDir = path.join(root, "data");
const publicDir = path.join(dataDir, "site");
fs.mkdirSync(publicDir, { recursive: true });

/** Mirrors the fixture the dev server and the SSR smoke test use, so all three
 * look at one shape of data. Two images on the first post keep the gallery
 * path exercised. */
const { imagePaths } = seedSiteFixture({
  dbPath: path.join(dataDir, "pipeline.db"),
  publicDir,
  posts: devFixture(3, 2),
});

const failures: string[] = [];
const check = (ok: boolean, what: string, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(what);
};

async function run(command: string[]): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, out: out + err };
}

async function cleanup(): Promise<void> {
  await run(["docker", "rm", "-f", container]);
  await run(["docker", "volume", "rm", "-f", volume]);
  await run(["docker", "volume", "rm", "-f", backupVolume]);
  fs.rmSync(root, { recursive: true, force: true });
}

try {
  const available = await run(["docker", "image", "inspect", image]);
  if (available.code !== 0) {
    const pulled = await run(["docker", "pull", image]);
    if (pulled.code !== 0) {
      throw new Error(`Docker image is not available locally and pull failed: ${image}\n${pulled.out}`);
    }
  }

  const configCheck = await run(["docker", "run", "--rm", "--entrypoint", "bun", image, "/app/entrypoint/config-check.js"]);
  check(configCheck.code === 0, "production config preflight", configCheck.out.trim());
  if (configCheck.code !== 0) throw new Error("production config preflight failed");

  /**
   * The fixture goes into a docker volume rather than a bind mount, and the
   * container is created, filled and only then started.
   *
   * A bind mount looks fine on macOS and breaks on Linux. Docker Desktop and
   * OrbStack virtualise bind-mount ownership; a real Linux host does not. The
   * entrypoint chowns /data itself and drops to uid 1000, but
   * fixDataDirectoriesOwnership is deliberately non-recursive (see
   * foundation/runtime/data-dirs.ts), so a seeded pipeline.db keeps the uid of
   * whoever ran this script and the server dies on its first write with
   * SQLITE_READONLY. The mirror image bites on the way out: files the
   * container leaves behind as uid 1000 are not deletable by that same user.
   *
   * Inside a volume the chown is real on every platform, and teardown is
   * `docker volume rm`, so no host uid is ever involved.
   */
  const created = await run([
    "docker",
    "create",
    "--pull",
    "never",
    "--name",
    container,
    "-p",
    `127.0.0.1:${port}:8788`,
    "-v",
    `${volume}:/data`,
    "-v",
    `${backupVolume}:/backups`,
    "-e",
    "DATA_DIR=/data",
    "-e",
    "PIPELINE_DB=/data/pipeline.db",
    "-e",
    "SITE_PUBLIC_DIR=/data/site",
    "-e",
    "MEDIA_CACHE_DIR=/data/media-cache",
    "-e",
    "VIDEO_MEDIA_DIR=/data/video-media",
    "-e",
    "-e",
    "BIND_HOST=0.0.0.0",
    "-e",
    "PORT=8788",
    "-e",
    "TELEGRAM_CHANNEL_USERNAME=smoke-channel",
    image,
  ]);
  if (created.code !== 0) throw new Error(`docker create failed: ${created.out}`);

  const copied = await run(["docker", "cp", `${dataDir}/.`, `${container}:/data`]);
  if (copied.code !== 0) throw new Error(`docker cp failed: ${copied.out}`);

  // `docker cp` writes as root; hand the whole tree to the runtime user before
  // the entrypoint drops privileges.
  const owned = await run([
    "docker",
    "run",
    "--rm",
    "--user",
    "0",
    "--entrypoint",
    "sh",
    "-v",
    `${volume}:/data`,
    "-v",
    `${backupVolume}:/backups`,
    image,
    "-c",
    "chown -R 1000:1000 /data /backups && printf smoke > /backups/media-smoke.tar.gz && chown 1000:1000 /backups/media-smoke.tar.gz",
  ]);
  if (owned.code !== 0) throw new Error(`smoke volume preparation failed: ${owned.out}`);

  const started = await run(["docker", "start", container]);
  if (started.code !== 0) throw new Error(`docker start failed: ${started.out}`);

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  let ready = false;
  while (Date.now() < deadline) {
    const response = await fetch(`${base}/readyz`).catch(() => undefined);
    if (response?.ok) {
      ready = true;
      break;
    }
    await Bun.sleep(500);
  }
  check(ready, "container becomes ready");
  if (!ready) throw new Error("never became ready");

  /** The routes below are the public SSR site, which a fresh install does not
   * serve. Turning it on through `ops` against the running container is also
   * the assertion that a Studio setting reaches the next request: nothing here
   * restarts anything between this call and the walk. */
  const siteOn = await run(["docker", "exec", "-u", "bun", container, "bun", "/app/ops/cli.js", "studio-profile-set", "--site-enabled"]);
  check(siteOn.code === 0, "public site enabled through ops", siteOn.out.trim());
  if (siteOn.code !== 0) throw new Error("could not enable the public site");

  /** Minimum body size per route. A missing runtime dependency renders as a
   * 500 with an empty body, so both the status and the length matter. */
  const routes: [string, number][] = [
    ["/", 5_000],
    ["/ru/", 5_000],
    ["/1/dev-post-1/", 5_000],
    ["/1/dev-post-1.md", 100],
    ["/feed.xml", 500],
    ["/ru/feed.xml", 500],
    ["/feed-ai.json", 500],
    ["/sitemap.xml", 300],
    ["/robots.txt", 50],
    // Discovery documents live under a dotfile directory, which is exactly the
    // kind of path a build or artifact step drops without failing. They reached
    // production as 404s once already.
    ["/.well-known/api-catalog", 100],
    ["/.well-known/mcp/server-card.json", 50],
    ["/.well-known/oauth-protected-resource", 50],
    ["/.well-known/agent-skills/index.json", 50],
  ];
  const probed = await Promise.all(
    routes.map(async ([route, minimumBytes]) => {
      const response = await fetch(base + route);
      const body = await response.text();
      return { route, minimumBytes, status: response.status, body };
    }),
  );
  for (const { route, minimumBytes, status, body } of probed) {
    check(status === 200 && body.length >= minimumBytes, `GET ${route}`, `${status}, ${body.length}b (min ${minimumBytes})`);
  }
  const home = probed.find((entry) => entry.route === "/")?.body ?? "";

  // The read model must link the vertical composite the media worker produces,
  // and that file must actually be served off the mounted public dir.
  const [firstImage] = imagePaths;
  check(home.includes(firstImage), "home links the fixture image", firstImage);
  const media = await fetch(`${base}/${firstImage}`);
  check(media.status === 200, `GET /${firstImage}`, String(media.status));

  // In parallel: each of these spawns a fresh bun in the container, and this
  // step sits on the critical path between the image build and the deploy.
  const opsCommands = ["doctor", "status", "audit", "format-support"];
  const opsResults = await Promise.all(
    opsCommands.map((command) => run(["docker", "exec", "-u", "bun", container, "bun", "/app/ops/cli.js", command])),
  );
  for (const [index, result] of opsResults.entries()) {
    check(result.code === 0, `ops ${opsCommands[index]}`, `exit ${result.code}`);
  }

  /**
   * The ffmpeg work the backend container really does, driven by the very
   * argument builders production calls — not by a hand-written command that
   * would drift from them.
   *
   * `-version` is not enough and neither is a plain h264 encode: these recipes
   * reach for specific encoders and filters (libwebp above all) that a bump of
   * the pinned mwader/static-ffmpeg image could quietly drop. The story recipe
   * is the local executor's, the one maru falls back to when
   * MEDIA_PROCESSOR_PROVIDER is unset; VM-106's VAAPI path cannot run on a
   * runner and is covered by `ops media-diagnose` instead.
   */
  const inContainer = (args: string[]) => run(["docker", "exec", "-u", "bun", container, ...args]);
  const dimensions = async (file: string): Promise<string> => {
    const probe = await inContainer([
      "ffprobe",
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height",
      "-of",
      "csv=p=0:s=x",
      file,
    ]);
    return probe.out.trim();
  };

  // Exercise the isolated renderer exactly as the durable worker does. This
  // catches missing Sharp native bindings, omitted brand assets and broken
  // font discovery in the pruned production image before deployment.
  const storyCard = await inContainer([
    "sh",
    "-c",
    `printf '%s' '<?xml version="1.0"?><fontconfig><dir>/app/apps/backend/assets/story-card</dir><cachedir>/tmp/story-card-font-cache</cachedir></fontconfig>' > /tmp/story-card-fontconfig.xml && printf '%s' '${JSON.stringify(
      {
        backgroundPath: "/app/apps/backend/assets/story-card/strata-master-background.png",
        assetsDir: "/app/apps/backend/assets/story-card",
        outputPath: "/tmp/text-story-card.jpg",
        copy: {
          headline: "ChatGPT reached one billion weekly active users.",
          emoji: "⚡",
          lines: ["ChatGPT reached one billion", "weekly active users."],
          boldLineCount: 1,
          templateVersion: "strata-v3",
        },
      },
    )}' | FONTCONFIG_FILE=/tmp/story-card-fontconfig.xml bun /app/story-renderer/renderer-process.js`,
  ]);
  check(storyCard.code === 0, "text Story card renderer", storyCard.out.trim().slice(0, 200));
  if (storyCard.code === 0) {
    const storyCardSize = await dimensions("/tmp/text-story-card.jpg");
    check(storyCardSize === "1080x1920", "text Story card dimensions", storyCardSize);
  }

  const sources = await inContainer([
    "sh",
    "-c",
    "ffmpeg -hide_banner -loglevel error -f lavfi -i testsrc=size=640x480:rate=5 -t 0.8 -pix_fmt yuv420p -y /tmp/src.mp4 " +
      "&& ffmpeg -hide_banner -loglevel error -i /tmp/src.mp4 -frames:v 1 -y /tmp/src.jpg",
  ]);
  check(sources.code === 0, "ffmpeg builds the smoke sources", sources.out.trim().slice(0, 200));

  /** Each entry runs prod's real arguments and states what the output must be. */
  const encodes: {
    name: string;
    args: string[];
    output: string;
    expect?: string;
  }[] = [
    {
      name: "story video (local executor)",
      args: storyFfmpegArgs("/tmp/src.mp4", "/tmp/story.mp4", "video"),
      output: "/tmp/story.mp4",
      expect: "1080x1920",
    },
    {
      name: "story image (local executor)",
      args: storyFfmpegArgs("/tmp/src.jpg", "/tmp/story.jpg", "image"),
      output: "/tmp/story.jpg",
      expect: "1080x1920",
    },
    {
      name: "site vertical composite",
      args: siteVerticalFfmpegArgs("/tmp/src.mp4", "/tmp/vertical.mp4", "video"),
      output: "/tmp/vertical.mp4",
      expect: "1080x1920",
    },
    {
      name: "site poster frame",
      args: sitePosterFfmpegArgs("/tmp/vertical.mp4", "/tmp/poster.jpg"),
      output: "/tmp/poster.jpg",
      expect: "1080x1920",
    },
    // libwebp is the encoder most likely to go missing in a rebuilt static
    // ffmpeg, and every responsive image on the site depends on it.
    {
      name: `responsive webp ${RESPONSIVE_WIDTHS[0]}px`,
      args: responsiveWebpFfmpegArgs("/tmp/src.jpg", `/tmp/responsive-${RESPONSIVE_WIDTHS[0]}.webp`, RESPONSIVE_WIDTHS[0]),
      output: `/tmp/responsive-${RESPONSIVE_WIDTHS[0]}.webp`,
      expect: `${RESPONSIVE_WIDTHS[0]}x270`,
    },
  ];
  for (const { name, args, output, expect } of encodes) {
    const encoded = await inContainer(["ffmpeg", "-hide_banner", "-loglevel", "error", ...args]);
    if (encoded.code !== 0) {
      check(false, `ffmpeg: ${name}`, `exit ${encoded.code}: ${encoded.out.trim().slice(0, 200)}`);
      continue;
    }
    const size = await dimensions(output);
    check(size === expect, `ffmpeg: ${name}`, `${size} (expected ${expect})`);
  }

  const logs = await run(["docker", "logs", container]);
  const errors = logs.out.split("\n").filter((line) => line.includes('"level":"error"') || line.includes("Cannot find module"));
  check(errors.length === 0, "no errors in container logs", errors.slice(0, 3).join(" | "));
} catch (error) {
  const logs = await run(["docker", "logs", container]);
  console.error(String(error));
  console.error(logs.out.split("\n").slice(-40).join("\n"));
  failures.push("smoke run threw");
} finally {
  await cleanup();
}

if (failures.length > 0) {
  console.error(`\n${failures.length} smoke check(s) failed: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("\nimage smoke passed");
