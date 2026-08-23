import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type ByteSink, exportStatus, recordExport, streamDatabase, streamMediaArchive } from "../src/operations/backup-export.js";
import { withDb } from "./helpers/db.js";
import { loadTestConfig } from "./helpers/studio-config.js";

/** Collects an export the way the backup host's `ssh … > file` does. */
function collector(): ByteSink & { bytes: () => Uint8Array; ended: () => boolean; flushes: () => number } {
  const chunks: Uint8Array[] = [];
  let ended = false;
  let flushes = 0;
  return {
    write: (chunk: Uint8Array) => chunks.push(new Uint8Array(chunk)),
    flush: () => {
      flushes += 1;
    },
    flushes: () => flushes,
    end: () => {
      ended = true;
    },
    ended: () => ended,
    bytes: () => {
      const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
      const out = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return out;
    },
  };
}

function mediaFixture(): { root: string; config: ReturnType<typeof loadTestConfig> } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "solo-publisher-backup-export-"));
  const config = loadTestConfig({ DATA_DIR: path.join(root, "data") });
  fs.mkdirSync(config.STUDIO_MEDIA_DIR, { recursive: true });
  fs.mkdirSync(path.join(config.SITE_PUBLIC_DIR, "media"), { recursive: true });
  fs.writeFileSync(path.join(config.STUDIO_MEDIA_DIR, "clip.mp4"), "video bytes");
  fs.writeFileSync(path.join(config.SITE_PUBLIC_DIR, "media", "cover.jpg"), "image bytes");
  return { root, config };
}

describe("backup export", () => {
  it("streams every media tree and records that it left the host", async () => {
    const { root, config } = mediaFixture();
    try {
      await withDb(async (backendDb) => {
        expect(exportStatus(backendDb, "media").ok).toBe(false);

        const sink = collector();
        const bytes = await streamMediaArchive(config, backendDb, sink);
        expect(bytes).toBeGreaterThan(0);
        expect(sink.ended()).toBe(true);
        // Written bytes have to reach the reader as the archive is produced. A
        // sink that only queues them holds the whole archive in memory, and a
        // gigabyte of media does not fit in this container.
        expect(sink.flushes()).toBeGreaterThan(0);

        const archive = path.join(root, "media.tar.gz");
        fs.writeFileSync(archive, sink.bytes());
        // Paths travel relative to DATA_DIR, so the archive restores onto a
        // fresh volume whatever the host path was when it was taken.
        const names = new TextDecoder().decode(Bun.spawnSync(["tar", "-tzf", archive]).stdout);
        expect(names).toContain("video-media/clip.mp4");
        expect(names).toContain("site/media/cover.jpg");
        expect(names).not.toContain(root);

        const status = exportStatus(backendDb, "media");
        expect(status.ok).toBe(true);
        expect(status.bytes).toBe(bytes);
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("streams a database a restore can open", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "solo-publisher-db-export-"));
    try {
      await withDb(async (backendDb) => {
        const sink = collector();
        const bytes = await streamDatabase(backendDb, sink);
        expect(bytes).toBeGreaterThan(0);

        const restored = path.join(root, "pipeline.db");
        fs.writeFileSync(restored, sink.bytes());
        const { Database } = await import("bun:sqlite");
        const copy = new Database(restored, { readonly: true });
        expect(copy.query("SELECT count(*) AS count FROM drafts").get()).toEqual({ count: 0 });
        copy.close();

        expect(exportStatus(backendDb, "db").ok).toBe(true);
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("stops counting an export the backup host has not repeated", async () => {
    await withDb((backendDb) => {
      // Eight days: one past the week `doctor` allows. A puller that stopped —
      // or a backup machine switched off — looks exactly like this.
      recordExport(backendDb, "media", 1, new Date(Date.now() - 8 * 24 * 60 * 60 * 1000));
      const status = exportStatus(backendDb, "media");
      expect(status.ok).toBe(false);
      expect(status.ageDays).toBeGreaterThan(7);
      expect(status.at).not.toBeNull();
    });
  });

  it("records nothing when the archive did not complete", async () => {
    const { root, config } = mediaFixture();
    try {
      await withDb(async (backendDb) => {
        fs.rmSync(config.DATA_DIR, { recursive: true, force: true });
        await expect(streamMediaArchive(config, backendDb, collector())).rejects.toThrow();
        // A truncated archive counted as a backup is worse than none: `doctor`
        // would go green over it.
        expect(exportStatus(backendDb, "media").ok).toBe(false);
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
