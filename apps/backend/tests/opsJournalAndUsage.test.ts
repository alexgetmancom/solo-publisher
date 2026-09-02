import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type BackendDb, openBackendDb } from "../src/db/client.js";
import { journalEvents } from "../src/operations/journal.js";

let backendDb: BackendDb | null = null;
const directories: string[] = [];

afterEach(() => {
  backendDb?.close();
  backendDb = null;
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "solo-publisher-journal-"));
  directories.push(directory);
  return directory;
}

describe("journal read", () => {
  it("reaches the events no publication owns", () => {
    backendDb = openBackendDb(":memory:");
    // What the Studio's feedback tool writes: recorded "where its operator will
    // see it", and reachable through neither `timeline` nor `audit`.
    backendDb.events.record({ ref: "mcp:feedback", type: "mcp.feedback.received", severity: "info", message: "the card is empty" });
    backendDb.events.record({ ref: null, type: "runtime.restart.looping", severity: "error", message: "restarted 5 times" });
    backendDb.events.record({ ref: "post:1", type: "publish.job.published", severity: "info", message: "published" });

    expect(journalEvents(backendDb, { limit: 50 }).count).toBe(3);
    const feedback = journalEvents(backendDb, { type: "mcp.", limit: 50 });
    expect(feedback.count).toBe(1);
    expect((feedback.events as { message: string }[])[0]?.message).toBe("the card is empty");
    expect(journalEvents(backendDb, { severity: "error", limit: 50 }).count).toBe(1);
    expect(journalEvents(backendDb, { ref: "post:1", limit: 50 }).count).toBe(1);
  });

  // A page that happens to be full reads as the whole story, and the oldest row
  // in it reads as the beginning of one.
  it("says when the answer is a page and not the whole of it", () => {
    backendDb = openBackendDb(":memory:");
    for (let index = 0; index < 3; index += 1)
      backendDb.events.record({ ref: null, type: "runtime.restarted", severity: "info", message: `restart ${index}` });

    expect(journalEvents(backendDb, { limit: 3 }).truncated).toBe(true);
    expect(journalEvents(backendDb, { limit: 10 }).truncated).toBe(false);
  });
});

describe("operations usage", () => {
  /** Usage is buffered and flushed on an interval, which counts nothing in a
   * process that exits inside it. Every CLI command an operator ran was counted
   * in memory and dropped, and `usage` -- whose whole subject is which commands
   * are exercised -- reported the terminal as permanently unused. */
  it("counts a command run through the terminal", async () => {
    const directory = temporaryDirectory();
    const databasePath = path.join(directory, "pipeline.db");
    const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
    const environment = { ...process.env, NODE_ENV: "development", DEPLOYMENT_ENV: "development", DATA_DIR: directory };

    const first = Bun.spawn(["bun", cli, "status", "--json", "--db", databasePath], { env: environment, stdout: "pipe", stderr: "pipe" });
    expect(await first.exited).toBe(0);

    const report = Bun.spawn(["bun", cli, "usage", "--json", "--db", databasePath], { env: environment, stdout: "pipe", stderr: "pipe" });
    const output = await new Response(report.stdout).text();
    expect(await report.exited).toBe(0);
    const status = JSON.parse(output).features.find((entry: { featureKey: string }) => entry.featureKey === "operations.status");
    expect(status.calls).toBe(1);
    expect(status.unused).toBe(false);
  });
});
