import { describe, expect, it } from "bun:test";
import { createApiHandler } from "../src/api.js";
import { registerChannel } from "../src/channels/registry.js";
import { withDb } from "./helpers/db.js";
import { loadTestConfig } from "./helpers/studio-config.js";

const COMMAND_TOKEN = "b".repeat(16);

function testConfig() {
  return loadTestConfig({
    CONTROLLER_ADMIN_IDS: "42",
    CONTROLLER_BOT_TOKEN: "bot-token",
    COMMAND_CENTER_TOKEN: COMMAND_TOKEN,
    PUBLIC_BASE_URL: "https://publisher.example.com",
    TOKEN_ENCRYPTION_KEY: "cd".repeat(32),
    THREADS_APP_ID: "threads-id",
    THREADS_APP_SECRET: "threads-secret",
    INSTAGRAM_APP_ID: "instagram-id",
    INSTAGRAM_APP_SECRET: "instagram-secret",
  });
}

describe("Command Center Studio tab", () => {
  it("gates the studio tab behind the Command Center token and renders the shared read model", () =>
    withDb(async (backendDb) => {
      const config = testConfig();
      const app = createApiHandler({ config, backendDb });

      const anonymous = await app(new Request("http://localhost/command-center?tab=studio"));
      expect(anonymous.status).toBe(200);
      expect(await anonymous.text()).toContain("Токен Command Center");

      const authorized = await app(
        new Request("http://localhost/command-center?tab=studio", { headers: { "X-Admin-Token": COMMAND_TOKEN } }),
      );
      expect(authorized.status).toBe(200);
      const dashboardText = await authorized.text();
      expect(dashboardText).toContain("Очередь");
      expect(dashboardText).not.toContain("Уведомления");
      expect(dashboardText).toContain('href="/command-center?tab=studio"');
      expect(dashboardText).toContain("Подключить Threads RU");
      expect(dashboardText).toContain("/oauth/threads/start?locale=ru");
      expect(dashboardText).toContain("Подключить Instagram EN");
      expect(dashboardText).toContain("<table bordered striped>");
      expect(dashboardText).not.toContain("| Площадка |");
    }));

  it("keeps channel setup available without MCP and leads a fresh install through its first draft", () =>
    withDb(async (backendDb) => {
      const config = loadTestConfig({ COMMAND_CENTER_TOKEN: COMMAND_TOKEN });
      const app = createApiHandler({ config, backendDb });
      const studio = await app(new Request("http://localhost/command-center?tab=studio", { headers: { "X-Admin-Token": COMMAND_TOKEN } }));
      expect(studio.status).toBe(200);
      const studioText = await studio.text();
      expect(studioText).toContain('href="/command-center?tab=studio"');
      expect(studioText).toContain("Подключить Telegram");
      expect(studioText).toContain("Настройте Telegram или MCP");
      expect(studioText).not.toContain("<h2>Очередь</h2>");

      const landing = await app(new Request("http://localhost/command-center", { headers: { "X-Admin-Token": COMMAND_TOKEN } }));
      expect(await landing.text()).toContain("Опубликуйте первый черновик");

      registerChannel(backendDb, { platform: "telegram", locale: "ru", provider: "native", targetId: "telegram", source: "test" });
      const configured = await app(new Request("http://localhost/command-center", { headers: { "X-Admin-Token": COMMAND_TOKEN } }));
      const configuredText = await configured.text();
      expect(configuredText).toContain("Опубликуйте первый черновик");
      expect(configuredText).toContain("Подключено назначений: 1");
    }));
});
