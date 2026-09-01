import { describe, expect, it } from "bun:test";
import type { Context } from "grammy";
import { buildMainMenu } from "../src/bot/navigation.js";
import { buildSettingsMenu } from "../src/bot/settings/index.js";
import type { UnsafeBackendDb } from "../src/db/client.js";
import type { TestChannelId } from "./helpers/channels.js";
import { withDb } from "./helpers/db.js";
import { loadTestConfig } from "./helpers/studio-config.js";

/**
 * The main menu identifies its buttons by a fingerprint instead of by the hash
 * of their own labels, because the queue button's label carries a live count
 * and every publication that went out in the background made the operator's
 * next tap "outdated".
 *
 * A fingerprint buys that at a price: `@grammyjs/menu` stops range-checking the
 * tapped position, so a tap on a menu whose *shape* has changed reaches a
 * button that is not there. The fingerprint therefore has to move whenever the
 * shape does, and that is not something the type system can hold -- adding one
 * more conditional button and forgetting the fingerprint is a silent trap.
 * This is the test that springs it.
 */
async function mainMenuShape(backendDb: UnsafeBackendDb): Promise<{ shape: number[]; fingerprint: string }> {
  const config = loadTestConfig();
  const menu = buildMainMenu(config, backendDb, buildSettingsMenu(config, backendDb));
  const ctx = { from: { id: 1 } } as unknown as Context;
  // Both halves of what this test compares are the plugin's own internals: the
  // rendered keyboard is protected, and the fingerprint is the option it was
  // built with. Reaching them is the only way to ask whether they agree.
  const internals = menu as unknown as {
    render: (ctx: Context) => Promise<{ length: number }[]>;
    options: { fingerprint: (ctx: Context) => string };
  };
  const rendered = await internals.render(ctx);
  const fingerprint = await internals.options.fingerprint(ctx);
  return { shape: [rendered.length, ...rendered.map((row) => row.length)], fingerprint };
}

function withChannels(channels: readonly TestChannelId[]): Promise<{ shape: number[]; fingerprint: string }> {
  return withDb((backendDb) => mainMenuShape(backendDb), channels);
}

describe("main menu fingerprint", () => {
  it("moves whenever the shape of the menu moves", async () => {
    const withoutStreams = await withChannels([]);
    const withStreams = await withChannels(["youtube_ru"]);

    expect(withStreams.shape).not.toEqual(withoutStreams.shape);
    expect(withStreams.fingerprint).not.toEqual(withoutStreams.fingerprint);
  });

  it("stands still while only a label moves", async () => {
    // Two renders of the same Studio: the queue count is free to differ between
    // them without any tap in flight becoming unanswerable.
    const first = await withChannels(["telegram"]);
    const second = await withChannels(["telegram"]);

    expect(second.shape).toEqual(first.shape);
    expect(second.fingerprint).toEqual(first.fingerprint);
  });
});
