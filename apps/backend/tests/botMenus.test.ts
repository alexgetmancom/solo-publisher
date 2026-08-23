import { afterEach, describe, expect, it } from "bun:test";
import type { Menu } from "@grammyjs/menu";
import type { Context } from "grammy";
import { renderMainMenuHeadline, showMainMenu } from "../src/bot/menu-render.js";
import { buildMainMenu } from "../src/bot/navigation.js";
import { buildSettingsMenu } from "../src/bot/settings/index.js";
import { isAdmin } from "../src/bot.js";
import { registerChannel } from "../src/channels/registry.js";
import type { BackendDb } from "../src/db/client.js";
import type { BackendConfig } from "../src/foundation/config.js";
import { openBackendDb } from "./helpers/open-db.js";
import { loadTestConfig } from "./helpers/studio-config.js";

let backendDb: BackendDb | null = null;

afterEach(() => {
  backendDb?.close();
  backendDb = null;
});

const fakeCtx = { from: { id: 1 } } as unknown as Context;

/** `Menu.render` is typed `protected` (internal API), but it's the plugin's
 * own documented way to resolve a menu's button labels for a given ctx
 * without going through a real Telegram update. */
async function renderLabels(menu: Menu<Context>): Promise<string[]> {
  const rows: Array<Array<{ text: string }>> = await (
    menu as unknown as { render: (ctx: Context) => Promise<Array<Array<{ text: string }>>> }
  ).render(fakeCtx);
  return rows.flat().map((btn) => btn.text);
}

async function mainMenuLabels(config: BackendConfig, db: BackendDb): Promise<string[]> {
  const settingsMenu = buildSettingsMenu(config, db);
  const mainMenu = buildMainMenu(config, db, settingsMenu);
  return renderLabels(mainMenu);
}

async function settingsMenuLabels(config: BackendConfig, db: BackendDb, submenu?: string): Promise<string[]> {
  const settings = buildSettingsMenu(config, db);
  return renderLabels(submenu ? settings.at(submenu) : settings);
}

describe("isAdmin", () => {
  it("rejects an undefined user id", () => {
    expect(isAdmin(loadTestConfig({ CONTROLLER_ADMIN_IDS: "1,2" }), undefined)).toBe(false);
  });

  it("accepts a user id listed in CONTROLLER_ADMIN_IDS", () => {
    expect(isAdmin(loadTestConfig({ CONTROLLER_ADMIN_IDS: "1,2" }), 2)).toBe(true);
  });

  it("rejects a user id not listed in CONTROLLER_ADMIN_IDS", () => {
    expect(isAdmin(loadTestConfig({ CONTROLLER_ADMIN_IDS: "1,2" }), 3)).toBe(false);
  });

  it("rejects everyone when CONTROLLER_ADMIN_IDS is empty", () => {
    expect(isAdmin(loadTestConfig({ CONTROLLER_ADMIN_IDS: "" }), 1)).toBe(false);
  });
});

describe("buildMainMenu", () => {
  it("renders an empty queue status above the menu", async () => {
    backendDb = openBackendDb(":memory:");
    const config = loadTestConfig({ CONTROLLER_ADMIN_IDS: "1" });
    const mainMenu = buildMainMenu(config, backendDb, buildSettingsMenu(config, backendDb));
    let text = "";
    const ctx = {
      reply: async (value: string) => {
        text = value;
      },
    } as unknown as Context;

    await showMainMenu(ctx, backendDb, config, mainMenu);

    expect(text).toBe("✅ Queue is empty");
  });

  it("uses calendar-relative labels for recent and upcoming activity", () => {
    const now = new Date("2026-08-13T18:00:00.000Z");
    const published = {
      id: 1,
      label: "🚨 DeepSeek больше не дешевый",
      time: new Date("2026-08-12T12:08:00.000Z"),
      kind: "post" as const,
    };
    const upcoming = {
      id: 2,
      label: "УКРАЛИ ВСЁ И СБЕЖАЛИ НА ВЕРТОЛЕТЕ?!",
      time: new Date("2026-08-14T17:00:00.000Z"),
      kind: "video" as const,
    };

    expect(renderMainMenuHeadline({ upcoming: null, published }, "ru", "Europe/Moscow", now)).toBe(
      "✅ Вчера, 15:08 · 📝 🚨 DeepSeek больше не...",
    );
    expect(renderMainMenuHeadline({ upcoming, published }, "ru", "Europe/Moscow", now)).toBe(
      "⏭ Завтра, 20:00 · 🎬 УКРАЛИ ВСЁ И СБЕЖАЛИ...",
    );
  });

  it("offers one intake for new material, and analytics", async () => {
    backendDb = openBackendDb(":memory:");
    const config = loadTestConfig({});
    const labels = await mainMenuLabels(config, backendDb);
    expect(labels.some((text) => /new material/i.test(text))).toBe(true);
    expect(labels.some((text) => /new video/i.test(text))).toBe(false);
    expect(labels.some((text) => /analytics/i.test(text))).toBe(true);
  });

  it("gives the intake the whole first row", async () => {
    backendDb = openBackendDb(":memory:");
    const config = loadTestConfig({});
    const settingsMenu = buildSettingsMenu(config, backendDb);
    const mainMenu = buildMainMenu(config, backendDb, settingsMenu);
    const rows: Array<Array<{ text: string }>> = await (
      mainMenu as unknown as { render: (ctx: Context) => Promise<Array<Array<{ text: string }>>> }
    ).render(fakeCtx);
    expect(rows[0]?.map((button) => button.text)).toEqual(["📥 New material"]);
  });
});

describe("buildSettingsMenu", () => {
  it("groups every setting under a category instead of one flat list", async () => {
    backendDb = openBackendDb(":memory:");
    const config = loadTestConfig({});
    const labels = await settingsMenuLabels(config, backendDb);
    expect(labels).toEqual(["📡 Publishing", "🔔 Notifications", "📊 Analytics", "⚙️ General", "← Menu"]);
  });

  it("keeps the news digest under notifications", async () => {
    backendDb = openBackendDb(":memory:");
    const config = loadTestConfig({});

    const labels = await settingsMenuLabels(config, backendDb, "settings-notifications-category");
    expect(labels).not.toContain("📥 Inbox");
    expect(labels).toContain("📰 News digest");
  });

  it("renders the news digest controls with a back button", async () => {
    backendDb = openBackendDb(":memory:");
    const config = loadTestConfig({});

    const labels = await settingsMenuLabels(config, backendDb, "settings-news-digest");
    expect(labels).toEqual([
      "◻️ News digest",
      "🕒 Delivery time: 10:00",
      "low",
      "medium",
      "high",
      "● xhigh",
      "✏️ Change prompt",
      "▶️ Send now",
      "← Notifications",
    ]);
  });

  it("offers the manual analytics inputs no platform API provides", async () => {
    backendDb = openBackendDb(":memory:");
    const config = loadTestConfig({});
    const labels = await settingsMenuLabels(config, backendDb, "settings-analytics");
    expect(labels.some((text) => /threads followers/i.test(text))).toBe(true);
    expect(labels.some((text) => /import x csv/i.test(text))).toBe(true);
  });

  it("shows the YouTube signature entry when a YouTube channel is connected", async () => {
    backendDb = openBackendDb(":memory:");
    const config = loadTestConfig({});
    registerChannel(backendDb, { platform: "youtube", locale: "ru", provider: "native" });

    const labels = await settingsMenuLabels(config, backendDb, "settings-publishing");
    expect(labels.some((text) => /youtube/i.test(text))).toBe(true);
  });

  it("hides the YouTube signature entry when no YouTube channel is connected", async () => {
    backendDb = openBackendDb(":memory:");
    const config = loadTestConfig({});

    const labels = await settingsMenuLabels(config, backendDb, "settings-publishing");
    expect(labels.some((text) => /youtube/i.test(text))).toBe(false);
  });

  it("offers every direct publication route and YouTube from the channels screen", async () => {
    backendDb = openBackendDb(":memory:");
    const labels = await settingsMenuLabels(loadTestConfig({}), backendDb, "settings-channels");

    for (const target of ["Telegram", "Discord", "Telegram Stories", "Instagram Stories RU", "Instagram Stories EN"])
      expect(labels.some((text) => text.includes(target))).toBe(true);
    expect(labels.some((text) => text.includes("YouTube RU"))).toBe(true);
    expect(labels.some((text) => text.includes("YouTube EN"))).toBe(true);
  });

  it("offers channel disable controls and no unconnected default targets", async () => {
    backendDb = openBackendDb(":memory:");
    const config = loadTestConfig({});
    registerChannel(backendDb, { platform: "telegram", locale: "ru", provider: "native", targetId: "telegram", label: "Telegram" });

    expect(await settingsMenuLabels(config, backendDb, "settings-channels")).toContain("Disable Telegram");
    expect(await settingsMenuLabels(config, backendDb, "settings-default-targets")).toEqual(["✓ Telegram", "← Publishing"]);
  });

  it("does not offer default targets before a channel is connected", async () => {
    backendDb = openBackendDb(":memory:");
    expect(await settingsMenuLabels(loadTestConfig({}), backendDb, "settings-default-targets")).toEqual(["← Publishing"]);
  });
});
