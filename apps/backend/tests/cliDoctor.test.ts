import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

let fixtureDir: string | null = null;

afterEach(() => {
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
  fixtureDir = null;
});

function fixture(): { dir: string; dataDir: string } {
  if (fixtureDir) return { dir: fixtureDir, dataDir: path.join(fixtureDir, "data") };
  fixtureDir = mkdtempSync(path.join(tmpdir(), "solo-publisher-doctor-"));
  const dataDir = path.join(fixtureDir, "data");
  mkdirSync(path.join(dataDir, "video-media"), { recursive: true });
  writeFileSync(path.join(dataDir, "video-media", "clip.mp4"), "video bytes");
  return { dir: fixtureDir, dataDir };
}

async function runCli(argv: string[], overrides: (fixture: string) => Record<string, string> = () => ({})) {
  const { dir, dataDir } = fixture();
  const child = Bun.spawn(
    ["bun", fileURLToPath(new URL("../src/cli.ts", import.meta.url)), ...argv, "--db", path.join(dir, "pipeline.db")],
    {
      env: {
        ...process.env,
        NODE_ENV: "development",
        DEPLOYMENT_ENV: "development",
        COMMAND_CENTER_TOKEN: "command-center",
        DATA_DIR: dataDir,
        ...overrides(dir),
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).bytes(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout: new TextDecoder().decode(stdout), bytes: stdout, stderr };
}

describe("doctor CLI", () => {
  it("succeeds once the backup host has pulled this Studio's media", async () => {
    const exported = await runCli(["backup-stream", "--what", "media"]);
    expect(exported.exitCode).toBe(0);
    // Bytes, and only bytes: a JSON summary printed after the archive would
    // corrupt whatever the backup host wrote it into.
    expect(exported.bytes.slice(0, 2)).toEqual(new Uint8Array([0x1f, 0x8b]));

    const result = await runCli(["doctor"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain('"ok": true');
  });

  it("fails a deployment whose media has never been pulled off it", async () => {
    const result = await runCli(["doctor"]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('"mediaBackedUp": false');
  });

  it("exits nonzero when its report is not ok", async () => {
    const result = await runCli(["doctor"], () => ({ CONTROLLER_BOT_TOKEN: "half-configured" }));
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('"ok": false');
    expect(result.stdout).toContain("CONTROLLER_ADMIN_IDS");
  });
});
