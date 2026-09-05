import { describe, expect, it } from "bun:test";
import { registerChannel } from "../src/channels/registry.js";
import { translateDraftText } from "../src/content/translation.js";
import { runTranslationCycle } from "../src/content/translation-worker.js";
import { openBackendDb } from "../src/db/client.js";
import { createStudioServices } from "../src/studio/services/index.js";
import { loadTestConfig } from "./helpers/studio-config.js";

/** A DeepSeek that answers every call with the same English, counting the calls
 * so a test can say the operator's tap made none of them. */
function stubTranslator(english: string): { calls: () => number; restore: () => void } {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (() => {
    calls += 1;
    return Promise.resolve(Response.json({ choices: [{ message: { content: english } }] }));
  }) as unknown as typeof fetch;
  return { calls: () => calls, restore: () => (globalThis.fetch = originalFetch) };
}

describe("draft translation", () => {
  it("produces no translation when the provider is unavailable", async () => {
    const backendDb = openBackendDb(":memory:");
    registerChannel(backendDb, { platform: "threads", locale: "en", provider: "native", targetId: "threads_en" });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => Promise.reject(new Error("provider unavailable"))) as unknown as typeof fetch;
    try {
      // It used to answer with the Russian text it was handed, which is the one
      // answer that cannot be told apart from a real translation: the draft
      // looked finished and the English channels published Russian.
      expect(await translateDraftText(backendDb, "Русский текст", loadTestConfig({ DEEPSEEK_API_KEY: "test-key" }))).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
      backendDb.close();
    }
  });

  it("never calls the translator for a Studio that publishes no English", async () => {
    const backendDb = openBackendDb(":memory:");
    registerChannel(backendDb, { platform: "threads", locale: "ru", provider: "native", targetId: "threads_ru" });
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (() => {
      calls += 1;
      return Promise.reject(new Error("must not be called"));
    }) as unknown as typeof fetch;
    try {
      expect(await translateDraftText(backendDb, "Русский текст", loadTestConfig({ DEEPSEEK_API_KEY: "test-key" }))).toBeUndefined();
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
      backendDb.close();
    }
  });
});

describe("draft translation queue", () => {
  it("creates the draft without waiting for the translator, then fills its English in", async () => {
    const backendDb = openBackendDb(":memory:");
    registerChannel(backendDb, { platform: "threads", locale: "en", provider: "native", targetId: "threads_en" });
    registerChannel(backendDb, { platform: "threads", locale: "ru", provider: "native", targetId: "threads_ru" });
    const config = loadTestConfig({ DEEPSEEK_API_KEY: "test-key" });
    const translator = stubTranslator("English text");
    try {
      const draftId = createStudioServices(backendDb, config).posts.create(1, { text: "Русский текст", media: [], entities: [] });
      // The tap that made the draft asked no provider anything: that wait is
      // what made a card take two seconds instead of a tenth of one.
      expect(translator.calls()).toBe(0);
      expect(backendDb.drafts.get(draftId)?.text_en_machine).toBeNull();
      expect(backendDb.draftTranslations.pending(draftId)).toBe(true);

      expect(await runTranslationCycle(backendDb, config)).toEqual([draftId]);
      expect(translator.calls()).toBe(1);
      expect(backendDb.drafts.get(draftId)?.text_en_machine).toBe("English text");
      // The row is the pending state, so the card stops saying "translating" by
      // the row being gone rather than by a second flag that could disagree.
      expect(backendDb.draftTranslations.pending(draftId)).toBe(false);
      expect(await runTranslationCycle(backendDb, config)).toEqual([]);
    } finally {
      translator.restore();
      backendDb.close();
    }
  });

  it("leaves a draft with no English rather than Russian, and stops asking once it has given up", async () => {
    const backendDb = openBackendDb(":memory:");
    registerChannel(backendDb, { platform: "threads", locale: "en", provider: "native", targetId: "threads_en" });
    const config = loadTestConfig({ DEEPSEEK_API_KEY: "test-key" });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => Promise.reject(new Error("provider unavailable"))) as unknown as typeof fetch;
    try {
      const draftId = createStudioServices(backendDb, config).posts.create(1, { text: "Русский текст", media: [], entities: [] });
      expect(await runTranslationCycle(backendDb, config)).toEqual([draftId]);
      // A failed attempt is retried, and until it runs out the draft's English is
      // still on its way -- never the Russian text under an English name.
      expect(backendDb.drafts.get(draftId)?.text_en_machine).toBeNull();
      expect(backendDb.draftTranslations.pending(draftId)).toBe(true);

      // Back to due without waiting out the backoff this attempt just set.
      backendDb.draftTranslations.queue(draftId);
      const claim = backendDb.draftTranslations.claimDue(60_000);
      expect(claim).not.toBeNull();
      if (!claim) return;
      backendDb.draftTranslations.fail(claim.draftId, claim.lockedBy, "provider unavailable", 1);
      // Out of attempts: the card stops promising English that is not coming, and
      // preflight already refuses to publish an English target without it.
      expect(backendDb.draftTranslations.pending(draftId)).toBe(false);
      expect(await runTranslationCycle(backendDb, config)).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
      backendDb.close();
    }
  });

  it("queues nothing for a Studio that publishes no English", () => {
    const backendDb = openBackendDb(":memory:");
    registerChannel(backendDb, { platform: "threads", locale: "ru", provider: "native", targetId: "threads_ru" });
    const config = loadTestConfig({ DEEPSEEK_API_KEY: "test-key" });
    try {
      const draftId = createStudioServices(backendDb, config).posts.create(1, { text: "Русский текст", media: [], entities: [] });
      expect(backendDb.draftTranslations.pending(draftId)).toBe(false);
    } finally {
      backendDb.close();
    }
  });
});
