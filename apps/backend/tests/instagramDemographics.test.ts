import { describe, expect, it } from "bun:test";
import { audienceDemographicsReport, syncInstagramDemographics } from "../src/analytics/collection/instagram-demographics.js";
import { registerChannel } from "../src/channels/registry.js";
import { loadTestConfig } from "./helpers/studio-config.js";
import { withDb } from "./helpers/db.js";

const RESPONSE = {
  metric: "follower_demographics",
  timeframe: "this_month",
  demographics: {
    age: { "18-24": 210, "25-34": 300, "35-44": 90 },
    country: [
      { label: "RU", value: 400 },
      { label: "KZ", value: 100 },
    ],
  },
};

function channel(backendDb: Parameters<typeof registerChannel>[0]) {
  return registerChannel(backendDb, { platform: "instagram", locale: "ru", provider: "zernio", providerAccountId: "acc-1" });
}

describe("instagram demographics", () => {
  it("stores one dated capture and reports each dimension as shares of itself", async () => {
    await withDb(async (backendDb) => {
      const connection = channel(backendDb);
      const config = Object.assign(loadTestConfig({}), { ZERNIO_API_KEY: "a".repeat(16) });
      let asked = "";
      const fetchImpl = (async (input: URL | RequestInfo) => {
        asked = String(input);
        return new Response(JSON.stringify(RESPONSE));
      }) as typeof fetch;

      expect(await syncInstagramDemographics(config, backendDb, fetchImpl, connection)).toEqual({ stored: 5 });
      expect(asked).toContain("accountId=acc-1");
      expect(asked).toContain("metric=follower_demographics");
      // A second read on the same day replaces the capture instead of doubling it.
      expect(await syncInstagramDemographics(config, backendDb, fetchImpl, connection)).toEqual({ stored: 5 });

      const capture = (audienceDemographicsReport(backendDb).captures as Array<Record<string, unknown>>)[0];
      const dimensions = capture?.dimensions as Record<string, Array<{ label: string; value: number; unit: string; share: number }>>;
      expect(dimensions.age?.[0]).toEqual({ label: "25-34", value: 300, unit: "count", share: 50 });
      expect(dimensions.country?.[0]).toEqual({ label: "RU", value: 400, unit: "count", share: 80 });
    });
  });

  it("reports an account Instagram will not describe as unavailable, not as a failure", async () => {
    await withDb(async (backendDb) => {
      const connection = channel(backendDb);
      const config = Object.assign(loadTestConfig({}), { ZERNIO_API_KEY: "a".repeat(16) });
      const fetchImpl = (async () =>
        new Response(JSON.stringify({ error: "Account must have at least 100 followers" }), { status: 400 })) as unknown as typeof fetch;

      const result = await syncInstagramDemographics(config, backendDb, fetchImpl, connection);
      expect(result.stored).toBe(0);
      expect(result.unavailable).toContain("100 followers");
      expect((audienceDemographicsReport(backendDb).captures as unknown[]).length).toBe(0);
    });
  });
});
