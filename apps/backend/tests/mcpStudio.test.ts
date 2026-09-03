import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiHandler } from "../src/api.js";
import { studioMediaAssets } from "../src/db/schema.js";
import { registerTestChannels } from "./helpers/channels.js";
import { withDb } from "./helpers/db.js";
import { openBackendDb } from "./helpers/open-db.js";
import { loadTestConfig, SITE_STUDIO_PROFILE } from "./helpers/studio-config.js";

const PNG_BYTES = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

function request(app: ReturnType<typeof createApiHandler>, body: unknown, authorization?: string) {
  return app(
    new Request("http://localhost/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) },
      body: JSON.stringify(body),
    }),
  );
}

describe("Studio MCP", () => {
  it("exposes owner-bound Studio commands only to the configured bearer token and audits mutations", () =>
    withDb(async (backendDb) => {
      const config = loadTestConfig(
        {
          CONTROLLER_ADMIN_IDS: "42",
          MCP_STUDIO_TOKEN: "a".repeat(16),
          MCP_STUDIO_ACTOR_ID: "42",
        },
        SITE_STUDIO_PROFILE,
      );
      registerTestChannels(backendDb, ["threads_ru"]);
      const app = createApiHandler({ config, backendDb });
      const anonymousTools = await request(app, { jsonrpc: "2.0", id: 1, method: "tools/list" });
      expect(JSON.stringify(await anonymousTools.json())).not.toContain("studio_post_create");

      const authorizedTools = await request(app, { jsonrpc: "2.0", id: 2, method: "tools/list" }, `Bearer ${"a".repeat(16)}`);
      const authorizedToolList = JSON.stringify(await authorizedTools.json());
      expect(authorizedToolList).toContain("studio_post_create");
      expect(authorizedToolList).not.toContain("studio_post_toggle_target");
      expect(authorizedToolList).toContain("studio_channels");
      expect(authorizedToolList).toContain("studio_locale_update");

      const denied = await request(
        app,
        { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "studio_queue", arguments: {} } },
        "Bearer wrong",
      );
      expect(await denied.json()).toMatchObject({ error: { code: -32001 } });

      const created = await request(
        app,
        {
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: { name: "studio_post_create", arguments: { text: "MCP draft", targets: ["threads_ru"] } },
        },
        `Bearer ${"a".repeat(16)}`,
      );
      expect(await created.json()).toMatchObject({ result: { content: [{ type: "text" }] } });
      expect(backendDb.sqlite.prepare("SELECT actor_id,targets_json FROM drafts").get()).toEqual({
        actor_id: 42,
        targets_json:
          '{"telegram":false,"site_ru":false,"site_en":false,"threads_ru":true,"threads_en":false,"x":false,"discord":false,"telegram_stories":false,"instagram_stories_ru":false,"instagram_stories":false}',
      });
      const preview = await request(
        app,
        { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "studio_post_preview", arguments: { draft_id: 1 } } },
        `Bearer ${"a".repeat(16)}`,
      );
      expect(JSON.stringify(await preview.json())).toContain("MCP draft");
      const history = await request(
        app,
        { jsonrpc: "2.0", id: 51, method: "tools/call", params: { name: "studio_post_history", arguments: { draft_id: 1 } } },
        `Bearer ${"a".repeat(16)}`,
      );
      expect(JSON.stringify(await history.json())).toContain("content.draft.created");
      expect(
        backendDb.sqlite.prepare("SELECT event_type, target FROM publication_events WHERE event_type='studio.mcp.command'").get(),
      ).toEqual({
        event_type: "studio.mcp.command",
        target: "mcp",
      });

      const capabilities = await request(
        app,
        { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "studio_capabilities", arguments: {} } },
        `Bearer ${"a".repeat(16)}`,
      );
      const capabilityResponse = (await capabilities.json()) as { result: { content: Array<{ text: string }> } };
      const [content] = capabilityResponse.result.content;
      expect(content).toBeDefined();
      const capabilityPayload = JSON.parse(content?.text ?? "") as Record<string, unknown>;
      expect(capabilityPayload).toHaveProperty("siteEnabled", true);
      expect(capabilityPayload).toHaveProperty("platforms");
      // Capabilities describe what is enabled, never what is missing: a leaked
      // `required` list would expose which credentials the owner has not set.
      expect(JSON.stringify(capabilityPayload)).not.toContain('"required"');

      const locale = await request(
        app,
        { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "studio_locale", arguments: {} } },
        `Bearer ${"a".repeat(16)}`,
      );
      const localeBody = (await locale.json()) as { result: { content: Array<{ text: string }> } };
      expect(localeBody.result.content[0]?.text).toContain('"locale":"en"');
      const localeUpdate = await request(
        app,
        { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "studio_locale_update", arguments: { locale: "ru" } } },
        `Bearer ${"a".repeat(16)}`,
      );
      const localeUpdateBody = (await localeUpdate.json()) as { result: { content: Array<{ text: string }> } };
      expect(localeUpdateBody.result.content[0]?.text).toContain('"updated":true');
      const signatureUpdate = await request(
        app,
        {
          jsonrpc: "2.0",
          id: 9,
          method: "tools/call",
          params: { name: "studio_youtube_signature_update", arguments: { signature: "https://example.com" } },
        },
        `Bearer ${"a".repeat(16)}`,
      );
      const signatureUpdateBody = (await signatureUpdate.json()) as { result: { content: Array<{ text: string }> } };
      expect(signatureUpdateBody.result.content[0]?.text).toContain("https://example.com");
    }));

  it("uses the same owner-bound Video Studio commands as Telegram", () =>
    withDb(async (backendDb) => {
      const token = "a".repeat(16);
      const config = loadTestConfig(
        { CONTROLLER_ADMIN_IDS: "42", MCP_STUDIO_TOKEN: token, MCP_STUDIO_ACTOR_ID: "42" },
        SITE_STUDIO_PROFILE,
      );
      const app = createApiHandler({ config, backendDb });
      const authorization = `Bearer ${token}`;
      const now = new Date().toISOString();
      backendDb.db
        .insert(studioMediaAssets)
        .values({
          actorId: 42,
          kind: "video",
          mimeType: "video/mp4",
          filename: "uploaded.mp4",
          localPath: "/tmp/uploaded.mp4",
          byteSize: 1,
          sha256: "video-asset",
          source: "ops_upload",
          createdAt: now,
        })
        .run();
      const tools = await request(app, { jsonrpc: "2.0", id: 1, method: "tools/list" }, authorization);
      const listed = JSON.stringify(await tools.json());
      for (const name of [
        "studio_video_create",
        "studio_video_list",
        "studio_video_status",
        "studio_video_history",
        "studio_video_replace_targets",
        "studio_video_update_metadata",
        "studio_video_schedule",
        "studio_video_retry",
      ])
        expect(listed).toContain(name);

      await request(
        app,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "studio_video_create", arguments: { asset_id: 1, locale: "en" } },
        },
        authorization,
      );
      expect(backendDb.sqlite.prepare("SELECT actor_id, studio_media_asset_id, locale FROM video_drafts WHERE id=1").get()).toEqual({
        actor_id: 42,
        studio_media_asset_id: 1,
        locale: "en",
      });

      await request(
        app,
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "studio_video_replace_targets", arguments: { video_draft_id: 1, targets: ["instagram_reels"] } },
        },
        authorization,
      );
      await request(
        app,
        {
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: {
            name: "studio_video_update_metadata",
            arguments: { video_draft_id: 1, target: "instagram_reels", metadata: { caption: "Ready from MCP #video" } },
          },
        },
        authorization,
      );
      expect(backendDb.sqlite.prepare("SELECT metadata_json FROM video_targets WHERE video_draft_id=1").get()).toEqual({
        metadata_json: '{"caption":"Ready from MCP #video"}',
      });
      expect(
        backendDb.sqlite
          .prepare("SELECT COUNT(*) AS count FROM publication_events WHERE event_type='studio.mcp.command' AND publication_key='video:1'")
          .get(),
      ).toEqual({ count: 3 });
    }));

  it("uploads a transport-neutral asset and attaches it through the owner-bound MCP contract", async () => {
    const backendDb = openBackendDb(":memory:");
    const directory = mkdtempSync(join(tmpdir(), "alexgetman-mcp-media-"));
    try {
      const token = "a".repeat(16);
      const config = loadTestConfig(
        {
          CONTROLLER_ADMIN_IDS: "42",
          MCP_STUDIO_TOKEN: token,
          MCP_STUDIO_ACTOR_ID: "42",
          DATA_DIR: directory,
        },
        SITE_STUDIO_PROFILE,
      );
      registerTestChannels(backendDb, ["telegram"]);
      const app = createApiHandler({ config, backendDb });
      const authorization = `Bearer ${token}`;
      const created = await request(
        app,
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "studio_post_create", arguments: { text: "Asset draft", targets: ["telegram"] } },
        },
        authorization,
      );
      expect(created.status).toBe(200);
      const uploaded = await app(
        new Request("http://localhost/api/studio/media", {
          method: "POST",
          headers: { authorization, "content-type": "image/jpeg", "x-filename": "agent-image.jpg" },
          body: PNG_BYTES,
        }),
      );
      expect(await uploaded.json()).toMatchObject({
        asset_id: 1,
        kind: "photo",
        filename: "agent-image.jpg",
        byte_size: PNG_BYTES.byteLength,
      });

      const attached = await request(
        app,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "studio_post_attach_media", arguments: { draft_id: 1, locale: "en", asset_ids: [1], replace: true } },
        },
        authorization,
      );
      expect(JSON.stringify(await attached.json())).toContain('\\"attached\\":true');
      expect(
        backendDb.sqlite.prepare("SELECT media_json AS media_en_json FROM post_locales WHERE draft_id=1 AND locale='en'").get(),
      ).toMatchObject({
        media_en_json: expect.stringContaining('"assetId":1'),
      });
      expect(backendDb.sqlite.prepare("SELECT source FROM studio_media_assets WHERE id=1").get()).toEqual({ source: "http_upload" });
    } finally {
      backendDb.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("accepts a notification without answering it", () =>
    withDb(async (backendDb) => {
      const config = loadTestConfig(
        { CONTROLLER_ADMIN_IDS: "42", MCP_STUDIO_TOKEN: "a".repeat(16), MCP_STUDIO_ACTOR_ID: "42" },
        SITE_STUDIO_PROFILE,
      );
      const app = createApiHandler({ config, backendDb });

      // Every client sends this right after the handshake. A response to a
      // notification is a protocol violation, and this one used to be an
      // "unknown method" error object.
      const accepted = await request(app, { jsonrpc: "2.0", method: "notifications/initialized" }, `Bearer ${"a".repeat(16)}`);
      expect(accepted.status).toBe(202);
      expect(await accepted.text()).toBe("");

      const handshake = await request(app, { jsonrpc: "2.0", id: 1, method: "initialize" });
      expect(await handshake.json()).toMatchObject({ result: { protocolVersion: "2024-11-05" } });
    }));

  it("refuses to publish one language into the other's audience", () =>
    withDb(async (backendDb) => {
      const token = "a".repeat(16);
      const config = loadTestConfig(
        {
          CONTROLLER_ADMIN_IDS: "42",
          MCP_STUDIO_TOKEN: token,
          MCP_STUDIO_ACTOR_ID: "42",
          THREADS_RU_ACCESS_TOKEN: "t".repeat(20),
          THREADS_RU_USER_ID: "1",
          THREADS_EN_ACCESS_TOKEN: "e".repeat(20),
          THREADS_EN_USER_ID: "2",
        },
        SITE_STUDIO_PROFILE,
      );
      const app = createApiHandler({ config, backendDb });
      const authorization = `Bearer ${token}`;
      const call = async (name: string, args: unknown) => {
        const response = await request(
          app,
          { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
          authorization,
        );
        const body = (await response.json()) as { error?: { message: string }; result?: { content: [{ text: string }] } };
        return body.error ? { error: body.error.message } : JSON.parse(body.result?.content[0]?.text ?? "null");
      };
      for (const target of ["threads_ru", "threads_en"]) await call("ops_channel_connect", { target, provider: "native" });
      const russian = "Сегодня разобрал, как мы используем React и Bun в проде — вышло короче, чем ожидал";
      const english = "Today I shipped the new analytics dashboard and it finally reads the way I wanted";

      // An English target with no English text used to borrow the Russian one
      // through three separate fallbacks and publish it.
      const borrowed = await call("studio_post_create", { text: russian, targets: ["threads_en"] });
      expect((await call("studio_post_validate", { draft_id: borrowed.draft_id }))[0]).toMatchObject({ kind: "empty", locale: "en" });
      expect(await call("studio_post_publish", { draft_id: borrowed.draft_id })).toMatchObject({ error: expect.stringContaining("EN") });

      // Russian typed into the English field is caught by what it is written in.
      const untranslated = await call("studio_post_create", { text: russian, text_en: russian, targets: ["threads_en"] });
      expect((await call("studio_post_validate", { draft_id: untranslated.draft_id }))[0]).toMatchObject({
        kind: "language",
        locale: "en",
        written: "ru",
      });

      // And a post written in both languages goes out in both, unbothered.
      const proper = await call("studio_post_create", { text: russian, text_en: english, targets: ["threads_ru", "threads_en"] });
      expect(await call("studio_post_validate", { draft_id: proper.draft_id })).toEqual([]);
      expect(await call("studio_post_publish", { draft_id: proper.draft_id })).toMatchObject({ queued: true });
      expect(
        backendDb.sqlite.prepare("SELECT target, json_extract(payload_json,'$.text') AS text FROM publish_jobs ORDER BY target").all(),
      ).toEqual([
        { target: "threads_en", text: english },
        { target: "threads_ru", text: russian },
      ]);
    }));
});
