import { describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "../../..");

type Environment = Record<string, string>;
type FakeSshCall = { args: string[]; input: string };

function inheritedEnvironment(): Environment {
  return Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

async function runLauncher(
  args: string[],
  overrides: Record<string, string | undefined>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const environment = inheritedEnvironment();
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete environment[name];
    else environment[name] = value;
  }
  const child = Bun.spawn(["bun", "scripts/ops-prod.ts", ...args], {
    cwd: repositoryRoot,
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, stdout, stderr };
}

async function runWithFakeSsh(
  args: string[],
  overrides: Record<string, string | undefined>,
): Promise<{ result: { code: number; stdout: string; stderr: string }; calls: FakeSshCall[] }> {
  const directory = mkdtempSync(join(tmpdir(), "alexgetman-ops-prod-"));
  const executable = join(directory, "ssh");
  const log = join(directory, "calls.jsonl");
  writeFileSync(log, "");
  await Bun.write(
    executable,
    `#!/usr/bin/env bun
import fs from "node:fs";
const input = fs.readFileSync(0, "utf8");
fs.appendFileSync(process.env.OPS_FAKE_SSH_LOG, JSON.stringify({ args: process.argv.slice(2), input }) + "\\n");
process.exit(Number(process.env.OPS_FAKE_SSH_EXIT ?? "0"));
`,
  );
  chmodSync(executable, 0o755);

  try {
    const result = await runLauncher(args, {
      ...overrides,
      OPS_FAKE_SSH_LOG: log,
      PATH: `${directory}:${process.env.PATH ?? ""}`,
    });
    const calls = readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as FakeSshCall);
    return { result, calls };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("production operations launcher", () => {
  it("fails before SSH when the target is not configured", async () => {
    const result = await runLauncher(["audit"], { OPS_SSH_TARGET: undefined });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("OPS_SSH_TARGET is required");
  });

  it("defaults to the alex deployment and ships local files", async () => {
    const directory = mkdtempSync(join(tmpdir(), "alexgetman-ops-file-"));
    const localFile = join(directory, "analytics.csv");
    writeFileSync(localFile, "csv contents");

    try {
      const { result, calls } = await runWithFakeSsh(["import-x-analytics", "--file", localFile, "--sampled-at", "2026-08-11T00:00:00Z"], {
        OPS_SSH_TARGET: "deploy@example.test",
      });

      expect(result.code).toBe(0);
      expect(calls).toHaveLength(3);
      expect(calls[0]?.input).toBe("csv contents");
      expect(calls[0]?.args[0]).toBe("deploy@example.test");
      expect(calls[0]?.args[1]).toContain("'alexgetman-backend'");
      expect(calls[0]?.args[1]).toContain("cat >");
      expect(calls[0]?.args[1]).toContain(`/tmp/${basename(localFile)}`);
      expect(calls[1]?.args[1]).toContain("'/tmp/analytics.csv'");
      expect(calls[1]?.args[1]).toContain("'docker' 'exec' '-i'");
      expect(calls[2]?.args[1]).toContain("'rm'");
      expect(calls[2]?.args[1]).toContain("'/tmp/analytics.csv'");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("routes --as to the named deployment's container", async () => {
    const { result, calls } = await runWithFakeSsh(["--as", "maru", "audit"], {
      OPS_SSH_TARGET: "deploy@example.test",
    });

    expect(result.code).toBe(0);
    expect(result.stderr).toContain("ops:prod → maru (maru-backend)");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args[1]).toContain("'maru-backend'");
    expect(calls[0]?.args[1]).not.toContain("alexgetman-backend");
    // The launcher's own flag is not an operation argument: it reaches the
    // container as the invocation it should quote back, never as argv.
    expect(calls[0]?.args[1]).toContain("'OPS_INVOCATION=bun run ops:prod --as maru'");
    expect(calls[0]?.args[1]?.split("'/app/ops/cli.js'")[1]?.trim()).toBe("'audit'");
  });

  it("refuses an unknown deployment before SSH", async () => {
    const { result, calls } = await runWithFakeSsh(["--as", "nobody", "audit"], {
      OPS_SSH_TARGET: "deploy@example.test",
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("alex, maru");
    expect(calls).toHaveLength(0);
  });
});
