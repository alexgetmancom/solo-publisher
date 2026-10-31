import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildOperationsGuide, formatOperationsGuide } from "../src/operations/guide.js";
import { operationCatalog } from "../src/operations/registry.js";

/** A bare prefix makes mkdtemp resolve against the working directory, so these
 * two tests used to leave a directory each in the repo root on every run. */
const directories: string[] = [];
function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "alexgetman-guide-"));
  directories.push(directory);
  return directory;
}

afterAll(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("operations guide", () => {
  it("runs through the CLI without opening an unavailable database", async () => {
    const databasePath = join(temporaryDirectory(), "missing", "pipeline.db");
    const child = Bun.spawn(["bun", "apps/backend/src/cli.ts", "guide", "--db", databasePath, "--json"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    expect(await child.exited).toBe(0);
    expect(stderr).toBe("");
    const guide = JSON.parse(stdout);
    expect(guide.local.state).toBe("missing");
    expect(guide.route).toBe("production");
    expect(guide.sections).toHaveLength(6);
    expect(guide).not.toHaveProperty("commands");
  });
  it("routes an unavailable local database to production", () => {
    const previousTarget = process.env.OPS_SSH_TARGET;
    process.env.OPS_SSH_TARGET = "";
    const guide = buildOperationsGuide(join(temporaryDirectory(), "missing.db"), operationCatalog());
    if (previousTarget === undefined) delete process.env.OPS_SSH_TARGET;
    else process.env.OPS_SSH_TARGET = previousTarget;

    expect(guide.local.state).toBe("missing");
    expect(guide.route).toBe("production");
    expect(guide.next.command).toBe("bun run ops:prod <command>");
    expect(guide.production.configured).toBe(false);
    expect(formatOperationsGuide(guide)).toContain("do not repair local /data");
    expect(formatOperationsGuide(guide)).toContain("Production launcher: not configured");
    // The container runs its last deployed revision, so this build's catalog is
    // a claim about the local tree, not about the route being recommended.
    expect(guide.catalog.authoritative).toBe(false);
    expect(guide.catalog.command).toBe("bun run ops:prod guide --json");
    expect(formatOperationsGuide(guide)).toContain("not the deployed one");
  });

  it("reports a configured production launcher without exposing its route", () => {
    const previousTarget = process.env.OPS_SSH_TARGET;
    process.env.OPS_SSH_TARGET = "deploy@example.test";
    const guide = buildOperationsGuide(join(temporaryDirectory(), "missing.db"), operationCatalog());
    if (previousTarget === undefined) delete process.env.OPS_SSH_TARGET;
    else process.env.OPS_SSH_TARGET = previousTarget;

    expect(guide.production.configured).toBe(true);
    expect(JSON.stringify(guide)).not.toContain("deploy@example.test");
    expect(formatOperationsGuide(guide)).not.toContain("deploy@example.test");
  });

  it("keeps the local route when the database file is available", () => {
    const directory = temporaryDirectory();
    writeFileSync(join(directory, "pipeline.db"), "placeholder");

    const guide = buildOperationsGuide(join(directory, "pipeline.db"), operationCatalog(), { all: true });

    expect(guide.local.state).toBe("available");
    expect(guide.route).toBe("local");
    expect(guide.next.command).toBe("bun run --filter @solo-publisher/backend ops <command>");
    expect(guide.commands?.find((command) => command.name === "publication-repair")).toMatchObject({
      mutates: true,
      usage: "publication-repair [--ref post:160] [--apply]",
    });
    expect(guide.commands?.find((command) => command.name === "reschedule")).toMatchObject({ mutates: true });
    expect(guide.catalog.authoritative).toBe(true);
  });

  it("answers with a section map and keeps command entries in expanded views", () => {
    const directory = temporaryDirectory();
    writeFileSync(join(directory, "pipeline.db"), "placeholder");
    const catalog = operationCatalog();

    const guide = buildOperationsGuide(join(directory, "pipeline.db"), catalog);

    expect(guide.commands).toBeUndefined();
    expect(guide.startHere).toBeUndefined();
    expect(guide.sections.reduce((sum, section) => sum + section.commandCount, 0)).toBe(catalog.length);
    for (const section of guide.sections) {
      expect(section).not.toHaveProperty("commands");
      expect(section.command).toBe(`${guide.invocation.prefix} guide --section ${section.name} --json`);
    }
    expect(formatOperationsGuide(guide)).not.toContain("Start here:");
    expect(JSON.stringify(guide).length).toBeLessThan(JSON.stringify({ ...guide, commands: catalog }).length / 4);
  });

  it("expands one section into full entries", () => {
    const directory = temporaryDirectory();
    writeFileSync(join(directory, "pipeline.db"), "placeholder");

    const guide = buildOperationsGuide(join(directory, "pipeline.db"), operationCatalog(), { section: "media" });

    expect(guide.commands?.map((command) => command.name)).toContain("media-status");
    expect(guide.commands?.every((command) => command.section === "media")).toBe(true);
    expect(guide.startHere?.some((entry) => entry.command === "media-status")).toBe(true);
    expect(guide.startHere?.some((entry) => entry.command === "recent")).toBe(false);
    expect(formatOperationsGuide(guide)).toContain("Start here:");
  });

  // Without this the guide answers in the coordinates of the machine it runs
  // on, which is a container the reader is not in.
  it("speaks in the coordinates of the launcher that reached it", () => {
    const directory = temporaryDirectory();
    writeFileSync(join(directory, "pipeline.db"), "placeholder");

    const guide = buildOperationsGuide(join(directory, "pipeline.db"), operationCatalog(), {}, {
      OPS_INVOCATION: "bun run ops:prod --as maru",
      OPS_INSTANCE: "maru",
      OPS_INSTANCES: "alex,maru",
    } as NodeJS.ProcessEnv);

    expect(guide.next.command).toBe("bun run ops:prod --as maru <command>");
    expect(guide.catalog.command).toBe("bun run ops:prod --as maru guide --json");
    expect(guide.invocation.instances).toEqual(["alex", "maru"]);
    expect(formatOperationsGuide(guide)).toContain("Other deployments: alex, maru");
  });

  // A single-deployment install has nothing to choose between, and publishing a
  // list of one invites a `--as` flag that its launcher does not have.
  it("lists no deployments when the launcher knows of one", () => {
    const directory = temporaryDirectory();
    writeFileSync(join(directory, "pipeline.db"), "placeholder");

    const guide = buildOperationsGuide(join(directory, "pipeline.db"), operationCatalog(), {}, {
      OPS_INVOCATION: "docker compose exec app bun /app/ops/cli.js",
      OPS_INSTANCES: "studio",
    } as NodeJS.ProcessEnv);

    expect(guide.invocation.instances).toBeUndefined();
    expect(guide.next.command).toBe("docker compose exec app bun /app/ops/cli.js <command>");
  });
});
