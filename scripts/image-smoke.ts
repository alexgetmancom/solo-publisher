/**
 * Inspects a built Studio image the way production reaches it, without a bot
 * token and so without starting a Studio:
 *
 * - what the image carries: the three binaries, the Stories sidecar bundle
 *   with mtcute's WASM, the Story-card assets, ffmpeg, Bun and setpriv;
 * - the entrypoint as root: it fixes the data directory's ownership, drops to
 *   uid 1000 and starts the Studio, which then refuses for want of a token —
 *   proof that the fix, the drop and the probe all ran first;
 * - the deploy agent's configuration check (`bun /app/entrypoint/config-check.js`),
 *   accepting a valid configuration and refusing an invalid one;
 * - the operations route `bun /app/ops/cli.js` (scripts/ops-prod.ts).
 *
 *   IMAGE=ghcr.io/...@sha256:... bun scripts/image-smoke.ts
 */

const image = process.env.IMAGE;
if (!image) {
  console.error("IMAGE is required, e.g. IMAGE=ghcr.io/owner/solo-publisher@sha256:...");
  process.exit(1);
}

const failures: string[] = [];
const check = (ok: boolean, what: string, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${ok || !detail ? "" : `\n${detail}`}`);
  if (!ok) failures.push(what);
};

async function run(args: string[]): Promise<{ code: number; out: string; stdout: string }> {
  const proc = Bun.spawn(["docker", "run", "--rm", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, out: stdout + stderr, stdout };
}

const contents = await run([
  "--entrypoint",
  "sh",
  image,
  "-c",
  [
    "set -e",
    "test -x /app/bin/solo-publisher",
    "test -x /app/bin/studio-entrypoint",
    "test -x /app/bin/ops",
    "test -f /app/sidecar/main.js && test -f /app/sidecar/login.js",
    "ls /app/sidecar/*.wasm",
    "test -f /app/assets/story-card/Manrope-Variable.ttf",
    "test -f /app/assets/story-card/NotoColorEmoji.ttf",
    "test -f /app/assets/story-card/strata-master-background.png",
    "test -f /app/ops/cli.js && test -f /app/entrypoint/config-check.js",
    "ffmpeg -hide_banner -version | head -n 1",
    "ffprobe -hide_banner -version | head -n 1",
    "bun --version",
    "setpriv --version",
    "id bun",
  ].join("\n"),
]);
check(contents.code === 0, "image contents", contents.out);

const refusal = "Telegram bot token is not configured";
const studio = await run(["--entrypoint", "/app/bin/solo-publisher", "-e", "DATA_DIR=/tmp/data", image]);
check(studio.code !== 0 && studio.out.includes(refusal), "the Studio refuses without a bot token", studio.out);

const started = await run(["-e", "DATA_DIR=/data", image]);
check(
  started.out.includes("fixed data directory ownership before dropping privileges") &&
    started.out.includes(refusal) &&
    !/cannot drop privileges|remain unwritable/.test(started.out),
  "entrypoint fixes ownership, drops privileges, then starts the Studio",
  started.out,
);

const valid = await run(["--entrypoint", "bun", "-e", "DATA_DIR=/tmp/data", image, "/app/entrypoint/config-check.js"]);
check(valid.code === 0 && valid.stdout.trim() === '{"ok":true}', "config check accepts a valid configuration", valid.out);
const invalid = await run([
  "--entrypoint",
  "bun",
  "-e",
  "DATA_DIR=/tmp/data",
  "-e",
  "NODE_ENV=production",
  "-e",
  "DEPLOYMENT_ENV=production",
  image,
  "/app/entrypoint/config-check.js",
]);
check(invalid.code !== 0 && invalid.out.includes("COMMAND_CENTER_TOKEN"), "config check refuses an invalid configuration", invalid.out);

const guide = await run(["--entrypoint", "bun", "-e", "DATA_DIR=/tmp/data", "-u", "bun", image, "/app/ops/cli.js", "guide", "--json"]);
let guideOk = false;
try {
  const parsed = JSON.parse(guide.stdout) as { local?: { state?: string } };
  guideOk = guide.code === 0 && parsed.local?.state === "missing";
} catch {}
check(guideOk, "ops CLI answers guide --json", guide.out);

if (failures.length > 0) {
  console.error(`${failures.length} image check(s) failed: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("Image smoke test passed.");
