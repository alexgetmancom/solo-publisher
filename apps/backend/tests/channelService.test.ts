import { describe, expect, it } from "bun:test";
import { listChannels } from "../src/channels/registry.js";
import type { BackendDb } from "../src/db/client.js";
import { recordAuthFailure } from "../src/observability/auth-circuit.js";
import { channelService } from "../src/studio/services/channels.js";
import { withDb } from "./helpers/db.js";
import { loadTestConfig } from "./helpers/studio-config.js";

describe("Studio channel service", () => {
  it("discovers Zernio accounts through the injected fetch implementation", async () => {
    const calls: Array<{ url: string; authorization: string | null }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push({ url, authorization: new Headers(init?.headers).get("authorization") });
      return new Response(JSON.stringify({ accounts: [{ _id: "account-1", username: "alex" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const service = channelService({} as BackendDb, Object.assign(loadTestConfig({}), { ZERNIO_API_KEY: "z".repeat(16) }), fetchImpl);

    await expect(service.discoverZernioAccounts()).resolves.toEqual([{ _id: "account-1", username: "alex" }]);
    expect(calls).toEqual([{ url: "https://zernio.com/api/v1/accounts", authorization: `Bearer ${"z".repeat(16)}` }]);
  });

  it("connects a selected provider account only to the requested publication route", () =>
    withDb(async (backendDb) => {
      const fetchImpl = (async () =>
        Response.json({ accounts: [{ _id: "account-1", platform: "Instagram", username: "alex" }] })) as unknown as typeof fetch;
      const config = loadTestConfig({});
      config.ZERNIO_API_KEY = "z".repeat(16);
      const service = channelService(backendDb, config, fetchImpl);

      await service.connectZernio("account-1", "ru", "instagram_stories");

      expect(listChannels(backendDb)).toMatchObject([
        { id: "instagram_stories_ru", provider: "zernio", providerAccountId: "account-1", targetId: "instagram_stories_ru" },
      ]);
    }));

  it("reports missing credentials beside a connection and can disable it", () =>
    withDb((backendDb) => {
      const service = channelService(backendDb, loadTestConfig({}));
      service.connectTarget("telegram_stories");

      expect(service.report()).toMatchObject([{ id: "telegram_stories", status: "missing" }]);
      service.disable("telegram_stories");
      expect(service.report()).toEqual([]);
      expect(service.report(false)).toMatchObject([{ id: "telegram_stories", enabled: false, status: "disabled" }]);
    }));

  /** The breaker is read on the publish path and nowhere else, so a target
   * whose credential is failing stops publishing while the channel it belongs
   * to still reports `ready`: connected, stored, and quietly not publishing. */
  it("reports a credential the publish path has stopped calling", () =>
    withDb(async (backendDb) => {
      const service = channelService(backendDb, loadTestConfig({}));
      service.connectTarget("telegram_stories");

      expect(service.report(false)[0]?.credential).toMatchObject({ blocked: false, authFailureStreak: 0 });

      // Three consecutive auth failures is what trips it.
      for (let attempt = 0; attempt < 3; attempt += 1) recordAuthFailure(backendDb, "telegram_stories");

      const blocked = service.report(false)[0]?.credential;
      expect(blocked?.blocked).toBe(true);
      expect(blocked?.authFailureStreak).toBe(3);
      expect(blocked?.blockedUntil).toBeTruthy();
    }));
});
