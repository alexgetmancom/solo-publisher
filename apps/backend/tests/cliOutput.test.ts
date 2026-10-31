import { expect, it } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openBackendDb } from "./helpers/open-db.js";
import { seedTextPost } from "./helpers/post.js";

it("flushes an archive-sized metadata export before the CLI exits", async () => {
  const directory = mkdtempSync(join(tmpdir(), "site-metadata-cli-"));
  try {
    const file = join(directory, "pipeline.db");
    const db = openBackendDb(":memory:");
    try {
      for (let id = 1; id <= 80; id++) {
        seedTextPost(db, { postId: id, en: `Article ${id}. ${"Archive content. ".repeat(1600)}`, siteEn: true });
      }
      // The CLI gets a complete file with no fixture connection holding it.
      // Older Bun versions defer releasing prepared statements after close().
      db.sqlite.run("VACUUM INTO ?", [file]);
    } finally {
      db.close();
    }
    const [output, errors] = await new Promise<[string, string]>((resolve, reject) => {
      let resume: ReturnType<typeof setTimeout> | undefined;
      const child = execFile(
        process.execPath,
        [fileURLToPath(new URL("../src/cli.ts", import.meta.url)), "site-metadata", "--json", "--db", file],
        { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 10_000 },
        (error, stdout, stderr) => {
          clearTimeout(resume);
          if (error) reject(error);
          else resolve([stdout, stderr]);
        },
      );
      // Pause after the first bytes so the CLI also handles a slow reader.
      child.stdout?.once("data", () => {
        child.stdout?.pause();
        resume = setTimeout(() => child.stdout?.resume(), 100);
      });
    });
    expect(errors).toBe("");
    expect(output.length).toBeGreaterThan(2 * 1024 * 1024);
    const result = JSON.parse(output) as { items: { post_id: number; text: string }[] };
    expect(result.items).toHaveLength(80);
    expect(result.items.find((item) => item.post_id === 1)?.text).toEndWith("Archive content. ");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  // This integration starts the complete CLI in a cold process under CI coverage.
}, 30_000);
