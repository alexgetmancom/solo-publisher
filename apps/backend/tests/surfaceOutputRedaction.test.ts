import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mcpResponse } from "../src/interfaces/mcp.js";
import { withDb } from "./helpers/db.js";
import { loadTestConfig } from "./helpers/studio-config.js";

/**
 * A secret leaves this system through whatever prints a provider's answer.
 *
 * The logger has redacted every line it serializes for a long time, and
 * `foundation/http.ts` scrubs response bodies where they are read. The two
 * surfaces that hand a result back to a person or an agent did not: an
 * operation result carries `raw_json` straight from a platform, and a provider
 * that echoes a token in an error body put it in a terminal scrollback and in
 * an agent's context. Same pass, same three places now.
 */

describe("what a surface prints", () => {
  it("redacts a credential on the way out of an MCP tool result", () =>
    withDb(async (backendDb) => {
      const config = loadTestConfig({ CONTROLLER_ADMIN_IDS: "42" });

      const success = (await mcpResponse(
        backendDb,
        config,
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          // The tool echoes the name back, which is the shortest honest way to
          // put provider-shaped text through the same encoder a result uses.
          params: { name: "submit_feedback", arguments: { name: "Bearer sk-live-4711", message: "hello" } },
        },
        "key",
        42,
      )) as { result: { content: Array<{ text: string }> } };

      expect(success.result.content[0]?.text).toContain("Bearer [REDACTED]");
      expect(success.result.content[0]?.text).not.toContain("sk-live-4711");
    }));

  it("redacts a credential on the way out of an MCP error", () =>
    withDb(async (backendDb) => {
      const config = loadTestConfig({ CONTROLLER_ADMIN_IDS: "42" });

      const failure = (await mcpResponse(
        backendDb,
        config,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "studio_unknown?access_token=sk-live-4711", arguments: {} },
        },
        "key",
        42,
      )) as { error: { message: string } };

      expect(failure.error.message).toContain("access_token=[REDACTED]");
      expect(failure.error.message).not.toContain("sk-live-4711");
    }));

  it("redacts a credential on the way out of the CLI", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "solo-publisher-redaction-"));
    try {
      const child = Bun.spawn(
        [
          "bun",
          fileURLToPath(new URL("../src/cli.ts", import.meta.url)),
          "nonsense?access_token=sk-live-4711",
          "--db",
          path.join(dir, "pipeline.db"),
        ],
        { env: { ...process.env, DATA_DIR: dir }, stdout: "pipe", stderr: "pipe" },
      );
      const [, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);

      expect(stderr).toContain("access_token=[REDACTED]");
      expect(stderr).not.toContain("sk-live-4711");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
