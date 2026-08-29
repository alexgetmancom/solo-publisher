import { afterEach, describe, expect, it } from "bun:test";
import { directConnectTargets } from "../src/botTargets.js";
import { registerTargetChannel } from "../src/channels/registry.js";
import type { BackendDb } from "../src/db/client.js";
import { renderStudioSection } from "../src/interfaces/web/studio.js";
import { openBackendDb } from "./helpers/open-db.js";
import { loadTestConfig } from "./helpers/studio-config.js";

let backendDb: BackendDb | null = null;

afterEach(() => {
  backendDb?.close();
  backendDb = null;
});

describe("channel connection surfaces", () => {
  it("renders every direct route and both YouTube accounts in Command Center", () => {
    backendDb = openBackendDb(":memory:");
    const config = loadTestConfig({
      CONTROLLER_ADMIN_IDS: "1",
      PUBLIC_BASE_URL: "https://publisher.example.com",
      TOKEN_ENCRYPTION_KEY: "ef".repeat(32),
      THREADS_APP_ID: "threads-id",
      THREADS_APP_SECRET: "threads-secret",
      INSTAGRAM_APP_ID: "instagram-id",
      INSTAGRAM_APP_SECRET: "instagram-secret",
      X_CLIENT_ID: "x-id",
      X_CLIENT_SECRET: "x-secret",
      YOUTUBE_RU_CLIENT_ID: "youtube-ru-id",
      YOUTUBE_RU_CLIENT_SECRET: "youtube-ru-secret",
      YOUTUBE_EN_CLIENT_ID: "youtube-en-id",
      YOUTUBE_EN_CLIENT_SECRET: "youtube-en-secret",
    });
    config.ZERNIO_API_KEY = "z".repeat(16);
    const html = String(renderStudioSection(config, backendDb, 1, "en"));

    for (const { id } of directConnectTargets()) expect(html).toContain(`name="target" value="${id}"`);
    expect(html).toContain('name="platform" value="youtube"');
    expect(html).toContain('name="locale" value="ru"');
    expect(html).toContain('name="locale" value="en"');
    expect(html).toContain("/oauth/threads/start");
    expect(html).toContain("/oauth/instagram/start");
    expect(html).toContain("/oauth/x/start");
    expect(html).toContain("/command-center/channels/zernio?locale=ru");
  });

  it("shows readiness and disable controls beside connected channels", () => {
    backendDb = openBackendDb(":memory:");
    const config = loadTestConfig({});
    registerTargetChannel(backendDb, "telegram_stories", { provider: "native" });

    const html = String(renderStudioSection(config, backendDb, 1, "en"));
    expect(html).toContain("missing credentials: 3");
    expect(html).toContain('action="/command-center/channels/disable"');
    expect(html).toContain('name="channel" value="telegram_stories"');
  });
});
