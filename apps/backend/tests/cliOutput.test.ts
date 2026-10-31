import { expect, it } from "bun:test";
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
    const db = openBackendDb(file);
    for (let id = 1; id <= 80; id++) {
      seedTextPost(db, { postId: id, en: `Article ${id}. ${"Archive content. ".repeat(160)}`, siteEn: true });
    }
    db.close();
    const child = Bun.spawn(["bun", fileURLToPath(new URL("../src/cli.ts", import.meta.url)), "site-metadata", "--json", "--db", file], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(errors).toBe("");
    expect(code).toBe(0);
    expect(output.length).toBeGreaterThan(131072);
    const result = JSON.parse(output) as { items: { post_id: number; text: string }[] };
    expect(result.items).toHaveLength(80);
    expect(result.items.find((item) => item.post_id === 1)?.text).toEndWith("Archive content. ");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
