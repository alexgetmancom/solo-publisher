import { afterEach, describe, expect, it } from "bun:test";
import { listChannels } from "../src/channels/registry.js";
import type { UnsafeBackendDb } from "../src/db/client.js";
import { mcpResponse } from "../src/interfaces/mcp.js";
import { flushUsage, usageReport } from "../src/observability/usage.js";
import {
  type OperationContext,
  operationCatalog,
  operationDef,
  operationUsage,
  operationUsageKeys,
  runOperation,
} from "../src/operations/registry.js";
import { openBackendDb } from "./helpers/open-db.js";
import { loadTestConfig } from "./helpers/studio-config.js";

let backendDb: UnsafeBackendDb | null = null;

afterEach(() => {
  backendDb?.close();
  backendDb = null;
});

/** Moving the database file, writing credentials, or reading a path off the
 * host are the operations an MCP caller must never reach. This is the list, and
 * it is the one thing about the registry worth failing a build over. */
/** Operations that reach the CLI and not MCP, and why each is off.
 *
 * Host-only: it moves the database file, writes a credential, or reads a path
 * on the host, none of which a remote caller can mean.
 *
 * Rare mutation: every agent tool is listed in full in every context this
 * server is connected to, before a caller has asked anything. A read earns that
 * because diagnosis is what an agent is for; a mutation earns it by being part
 * of routine delivery work. These are neither, and are run by an operator with
 * the note and the dry-run in front of them. */
const OFF_THE_AGENT_SURFACE = [
  "guide",
  "backup",
  "backup-stream",
  "restore",
  "import-x-analytics",
  "import-manual-analytics",
  "format-record",
  "replace-media",
  "set-media",
  "site-media-images",
  "site-media-deduplicate",
  "credential-set",
  "telegram-stories-login",
  "threads-authorize",
  // Rare mutations, in the order the catalog carries them.
  "studio-profile-set",
  "live-say",
  "dates-repair",
  "milestone-announce",
  "x-import-delete",
  "x-relink",
  "purge",
  "story-card-backfill",
  "story-media-backfill",
  "metrics-backfill",
];

function context(db: UnsafeBackendDb): OperationContext {
  return {
    dbPath: ":memory:",
    config: () => loadTestConfig({ CONTROLLER_ADMIN_IDS: "42" }),
    db: () => db,
    fetchImpl: fetch,
    actorType: "test",
  };
}

describe("operations registry", () => {
  it("takes a text route by its target alone", async () => {
    // The target names the platform and the language. Asking for them again let
    // a caller store one platform under another one's id, and production has
    // rows where they disagree.
    const backendDb = openBackendDb(":memory:");
    try {
      const connect = operationDef("channel-connect");
      const parse = (input: unknown) => connect?.schema.parse(input);
      const run = async (input: unknown) => connect?.handler(context(backendDb), parse(input));

      expect(await run({ target: "threads_en", provider: "native" })).toEqual({ id: "threads_en" });
      const connected = listChannels(backendDb).find((channel) => channel.id === "threads_en");
      expect(connected?.locale).toBe("en");
      expect(connected?.source).toBe("test");

      expect(await run({ platform: "youtube", locale: "ru", provider: "native" })).toEqual({ id: "youtube_ru" });
      await expect(run({ provider: "native" })).rejects.toThrow("needs --target");
    } finally {
      backendDb.close();
    }
  });

  it("keeps host-only operations and rare mutations off the agent surface", () => {
    const catalog = new Map(operationCatalog().map((entry) => [entry.name, entry]));

    // Both directions: the list has to name every operation that is off, or a
    // new one added with `agent: false` and forgotten here reaches MCP the day
    // someone flips it back without a test to say why it was off.
    expect(
      [...catalog.values()]
        .filter((entry) => !entry.agent)
        .map((entry) => entry.name)
        .sort(),
    ).toEqual([...OFF_THE_AGENT_SURFACE].sort());
    expect(catalog.get("recent")?.agent).toBe(true);
    expect(catalog.get("settle")?.agent).toBe(true);
    expect(catalog.get("retry")?.agent).toBe(true);
    // Diagnosis is the whole point of the agent surface, so a read leaves it
    // only by being unable to mean anything remotely: `guide` probes a host
    // path, `backup-stream` writes an archive to stdout, and
    // `threads-authorize` asks a terminal for the address it was redirected to.
    expect(
      [...catalog.values()]
        .filter((entry) => !entry.mutates && !entry.agent)
        .map((entry) => entry.name)
        .sort(),
    ).toEqual(["backup-stream", "guide", "threads-authorize"]);
  });

  it("refuses input the schema does not define, on every surface", async () => {
    backendDb = openBackendDb(":memory:");

    // A misspelled `target` used to be stripped and read as "every target".
    await expect(runOperation("delete", context(backendDb), { ref: "post:1", targte: "x", apply: true })).rejects.toThrow(
      "delete: unknown field targte",
    );
    await expect(runOperation("retry", context(backendDb), { ref: "post:1", target: "" })).rejects.toThrow("retry: target");
    await expect(runOperation("metrics-backfill", context(backendDb), { refs: "" })).rejects.toThrow("metrics-backfill: refs");
    await expect(runOperation("toString", context(backendDb), {})).rejects.toThrow("unknown command: toString");
  });

  it("counts every operation run, whichever surface ran it, and none that only failed to parse", async () => {
    backendDb = openBackendDb(":memory:");

    await runOperation("recent", context(backendDb), {});
    await runOperation("recent", context(backendDb), {});
    await expect(runOperation("timeline", context(backendDb), { ref: "nonsense" })).rejects.toThrow("--ref must look like");
    // Rejected before the handler: an operator's typo is not a command that fails.
    await expect(runOperation("recent", context(backendDb), { limit: 999 })).rejects.toThrow("recent: limit");
    flushUsage(backendDb);

    const report = usageReport(backendDb, { days: 1, unusedDays: 1, knownFeatures: operationUsageKeys() });
    const feature = (name: string) => report.features.find((entry) => entry.featureKey === `operations.${name}`);
    expect(feature("recent")).toMatchObject({ calls: 2, successes: 2, failures: 0 });
    expect(feature("timeline")).toMatchObject({ calls: 1, successes: 0, failures: 1 });
    // A command nobody has run is the answer the report exists to give, so it
    // has to appear with a zero rather than be absent.
    expect(feature("audit")).toMatchObject({ calls: 0, unused: true, lastSeenAt: null });
  });

  /** A usage line reading `--ref VALUE` is what produced `--ref 160` and the
   * round-trip it cost; the placeholder has to survive into the rendered line. */
  it("derives the usage line from the schema, showing the real invocation", () => {
    expect(operationUsage("retry", operationDef("retry") as never)).toBe("retry --ref post:160 [--target x] [--locale ru|en] [--apply]");
    expect(operationUsage("recent", operationDef("recent") as never)).toBe("recent [--limit VALUE]");
    expect(operationUsage("publish", operationDef("publish") as never)).toBe(
      'publish --locale ru|en --targets threads_ru --text "post text"',
    );
    expect(operationUsage("purge", operationDef("purge") as never)).toBe("purge --ref post:160 [--apply]");
    expect(operationUsage("story-card-backfill", operationDef("story-card-backfill") as never)).toBe(
      "story-card-backfill --ref post:160 [--apply] [--force]",
    );
  });

  it("accepts the bare post number every other surface shows", async () => {
    backendDb = openBackendDb(":memory:");

    const normalized = (await runOperation("timeline", context(backendDb), { ref: "160" })) as { ref: string };

    expect(normalized.ref).toBe("post:160");
    await expect(runOperation("timeline", context(backendDb), { ref: "nonsense" })).rejects.toThrow("--ref must look like post:106");
  });

  it("journals every mutation once, against the ref the operation normalized", async () => {
    backendDb = openBackendDb(":memory:");

    // The bare number is a spelling of the ref, and the journal has to carry
    // the resolved one: `160` in publication_key joins to nothing.
    await runOperation("publication-repair", context(backendDb), { ref: "160" });
    await runOperation("recent", context(backendDb), {});

    expect(backendDb.sqlite.prepare("SELECT publication_key, event_type, target FROM publication_events").all()).toEqual([
      { publication_key: "post:160", event_type: "operations.command", target: null },
    ]);
  });

  it("validates input before the handler runs", async () => {
    backendDb = openBackendDb(":memory:");

    await expect(runOperation("recent", context(backendDb), { limit: 999 })).rejects.toThrow("recent: limit");
    await expect(runOperation("verify", context(backendDb), {})).rejects.toThrow("verify: ref");
    await expect(runOperation("nonsense", context(backendDb), {})).rejects.toThrow("unknown command: nonsense");
  });

  it("serves every agent operation as an MCP tool and nothing else", async () => {
    backendDb = openBackendDb(":memory:");
    const config = loadTestConfig({ CONTROLLER_ADMIN_IDS: "42" });

    const listed = (await mcpResponse(backendDb, config, { jsonrpc: "2.0", id: 1, method: "tools/list" }, "key", 42)) as {
      result: { tools: Array<{ name: string }> };
    };
    const opsTools = listed.result.tools.filter((tool) => tool.name.startsWith("ops_")).map((tool) => tool.name);

    expect(opsTools).toEqual(
      operationCatalog()
        .filter((entry) => entry.agent)
        .map((entry) => `ops_${entry.name.replace(/-/g, "_")}`),
    );
    for (const name of OFF_THE_AGENT_SURFACE) expect(opsTools).not.toContain(`ops_${name.replace(/-/g, "_")}`);
  });

  it("refuses a host-only operation asked for over MCP", async () => {
    backendDb = openBackendDb(":memory:");
    const config = loadTestConfig({ CONTROLLER_ADMIN_IDS: "42" });

    const response = (await mcpResponse(
      backendDb,
      config,
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ops_restore", arguments: { source: "/tmp/backup.db" } } },
      "key",
      42,
    )) as { error: { code: number } };

    expect(response.error.code).toBe(-32601);
  });

  it("names the offending field when an agent calls an operation wrongly", async () => {
    backendDb = openBackendDb(":memory:");
    const config = loadTestConfig({ CONTROLLER_ADMIN_IDS: "42" });

    const response = (await mcpResponse(
      backendDb,
      config,
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ops_recent", arguments: { limit: 999 } } },
      "key",
      42,
    )) as { error: { code: number; message: string } };

    expect(response.error.code).toBe(-32602);
    expect(response.error.message).toContain("limit");
  });

  it("keeps the CLI's own spellings off the agent surface", async () => {
    backendDb = openBackendDb(":memory:");
    const config = loadTestConfig({ CONTROLLER_ADMIN_IDS: "42", MCP_STUDIO_TOKEN: "a".repeat(16), MCP_STUDIO_ACTOR_ID: "42" });
    const listed = (await mcpResponse(backendDb, config, { jsonrpc: "2.0", id: 1, method: "tools/list" }, "key", 42)) as {
      result: { tools: Array<{ name: string; description: string; inputSchema: { properties?: Record<string, object> } }> };
    };
    const ops = listed.result.tools.filter((tool) => tool.name.startsWith("ops_"));
    expect(ops.length).toBeGreaterThan(0);

    // `--apply` is not a thing an MCP caller can write, and `placeholder` is the
    // CLI usage line's device — it carried shell quoting (`"post text"`) into
    // the schema an agent reads as the value to send.
    expect(ops.filter((tool) => tool.description.includes("--"))).toEqual([]);
    expect(ops.filter((tool) => Object.values(tool.inputSchema.properties ?? {}).some((field) => "placeholder" in field))).toEqual([]);
  });

  it("answers a batch as a batch and a notification with nothing", async () => {
    backendDb = openBackendDb(":memory:");
    const config = loadTestConfig({ CONTROLLER_ADMIN_IDS: "42", MCP_STUDIO_TOKEN: "a".repeat(16), MCP_STUDIO_ACTOR_ID: "42" });
    const batch = (await mcpResponse(
      backendDb,
      config,
      [
        { jsonrpc: "2.0", id: 1, method: "initialize" },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
      ],
      "key",
      42,
    )) as Array<{ id: number }>;

    expect(batch.map((answer) => answer.id)).toEqual([1, 2]);
    expect(await mcpResponse(backendDb, config, [{ jsonrpc: "2.0", method: "notifications/initialized" }], "key", 42)).toBeNull();
  });
});
