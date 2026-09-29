import { describe, expect, it } from "bun:test";
import { plannedTargetDeliveries } from "../src/publishing/chain-plan.js";
import { publicationPreflight } from "../src/publishing/preflight.js";
import { createPublicationPlan } from "../src/publishing/publication-plan.js";
import { isContentRefusal, isPostTargetRetryable } from "../src/publishing/state.js";

describe("PublicationPlan", () => {
  it("decides localized content and target schedule before persistence", () => {
    const plan = createPublicationPlan(
      {
        text_ru: "Русский заголовок\nТекст",
        text_en_machine: "English title\nText",
        text_en_approved: null,
        targets_json: JSON.stringify({ telegram: true, threads_en: true, site_ru: true, site_en: true }),
        media_ru_json: JSON.stringify([{ file_id: "ru-image" }]),
        media_en_json: JSON.stringify([{ file_id: "en-image" }]),
        text_ru_entities_json: "[]",
        text_en_entities_json: "[]",
        thread: [],
      } as never,
      9,
      99,
      { mode: "scheduled", ruAt: "2026-07-15T10:00:00.000Z", enAt: "2026-07-15T12:00:00.000Z" },
      "2026-07-14T10:00:00.000Z",
    );

    expect(plan).toMatchObject({ draftId: 9, postId: 99, publicationKey: "post:99", mode: "scheduled" });
    expect(plan.payload).toMatchObject({
      locales: {
        ru: { text: "Русский заголовок\nТекст" },
        en: { text: "English title\nText", publishAt: "2026-07-15T12:00:00.000Z" },
      },
    });
    expect(plan.locales).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ locale: "ru", source: expect.objectContaining({ siteEnabled: true }) }),
        expect.objectContaining({ locale: "en", source: expect.objectContaining({ siteEnabled: true }) }),
      ]),
    );
  });

  it("rejects an enabled target that has no delivery contract", () => {
    expect(() =>
      createPublicationPlan(
        {
          text_ru: "Text",
          text_en_machine: "Text",
          text_en_approved: null,
          targets_json: JSON.stringify({ bogus_target: true }),
          media_ru_json: null,
          media_en_json: null,
        } as never,
        1,
        2,
        { mode: "immediate", ruAt: null, enAt: null },
        "2026-07-14T10:00:00.000Z",
      ),
    ).toThrow("Unknown publication target(s): bogus_target");
  });
});

describe("publication preflight", () => {
  it("blocks one-message Telegram media captions over the declared profile limit", () => {
    const issues = publicationPreflight({
      text_ru: "А".repeat(1025),
      media_ru_json: JSON.stringify([{ type: "photo" }]),
      targets_json: JSON.stringify({ telegram: true, site_ru: true, threads_ru: false, threads_en: false }),
    });
    expect(issues).toEqual([expect.objectContaining({ target: "telegram", kind: "caption-limit", actual: 1025, limit: 1024 })]);
  });

  it("does not block a long Telegram text post without media", () => {
    expect(
      publicationPreflight({
        text_ru: "А".repeat(4096),
        media_ru_json: null,
        targets_json: JSON.stringify({ telegram: true, threads_ru: false, threads_en: false }),
      }),
    ).toEqual([]);
  });

  it("carries a Threads post over 500 characters as the posts it makes, not as a refusal", () => {
    const targets_json = JSON.stringify({ telegram: false, threads_ru: true, threads_en: false });
    expect(publicationPreflight({ text_ru: "А".repeat(501), media_ru_json: null, targets_json })).toEqual([]);
    expect(publicationPreflight({ text_ru: "А".repeat(501), media_ru_json: JSON.stringify([{ type: "photo" }]), targets_json })).toEqual(
      [],
    );
  });

  it("counts an appended link against the Threads budget, and stops counting it once it is dropped", () => {
    const targets_json = JSON.stringify({ telegram: false, threads_ru: true, threads_en: false });
    const text_ru_entities_json = JSON.stringify([{ type: "text_link", offset: 0, length: 5, url: "https://example.com/guide" }]);
    // Text plus link is over the limit, so the link is dropped and the post fits.
    expect(publicationPreflight({ text_ru: "А".repeat(490), media_ru_json: null, text_ru_entities_json, targets_json })).toEqual([]);
    // Text alone is over the limit: it becomes two posts, and the link travels
    // with the piece the words it marked are in.
    expect(publicationPreflight({ text_ru: "А".repeat(501), media_ru_json: null, text_ru_entities_json, targets_json })).toEqual([]);
  });

  it("offers a thread where the platform carries one, and says how many posts it makes", () => {
    // Telegram carries a thread as one message and has no reply chain to cut a
    // caption into, so this is where the offer still stands.
    const draft = {
      text_ru: "А".repeat(1100),
      media_ru_json: JSON.stringify([{ type: "photo" }]),
      targets_json: JSON.stringify({ telegram: true, threads_ru: false, threads_en: false }),
    };
    expect(publicationPreflight(draft)).toEqual([expect.objectContaining({ target: "telegram", kind: "caption-limit", threadParts: 3 })]);
  });

  it("measures every post of a thread on its own, and names the one at fault", () => {
    const targets_json = JSON.stringify({ telegram: false, threads_ru: true, threads_en: false });
    const part = (textRu: string, media: Record<string, unknown>[] = []) => ({
      position: 0,
      textRu,
      entitiesRu: [],
      textEn: null,
      textEnApproved: null,
      media,
    });
    expect(publicationPreflight({ text_ru: "Раз", media_ru_json: null, targets_json, thread: [part("Два")] })).toEqual([]);
    // A part over the budget is cut into the posts it makes, like any other.
    expect(
      publicationPreflight({ text_ru: "Раз", media_ru_json: null, targets_json, thread: [part("Два"), part("А".repeat(501))] }),
    ).toEqual([]);
    expect(
      publicationPreflight({
        text_ru: "Раз",
        media_ru_json: null,
        targets_json,
        thread: [part("Два", [{ type: "photo" }, { type: "photo" }])],
      }),
    ).toEqual([expect.objectContaining({ kind: "media-limit", limit: 1, part: 2 })]);
  });

  it("carries a Telegram thread as one rich message, free of the caption limit", () => {
    const issues = publicationPreflight({
      text_ru: "А".repeat(1025),
      media_ru_json: JSON.stringify([{ type: "photo" }]),
      targets_json: JSON.stringify({ telegram: true, threads_ru: false, threads_en: false }),
      thread: [{ position: 2, textRu: "Два", entitiesRu: [], textEn: null, textEnApproved: null, media: [] }],
    });
    expect(issues).toEqual([]);
  });

  it("cuts an English translation longer than the Russian it renders, rather than refusing it", () => {
    // The author wrote Russian that fits; the machine translation of it does
    // not, and no one can shorten it from the Russian card.
    const issues = publicationPreflight({
      text_ru: "Коротко",
      text_en_machine: "E".repeat(501),
      media_ru_json: null,
      targets_json: JSON.stringify({ telegram: false, threads_ru: true, threads_en: true }),
    });
    expect(issues).toEqual([]);
  });
});

describe("what each platform actually receives", () => {
  const part = (textRu: string, textEn: string | null = null) => ({
    position: 0,
    textRu,
    entitiesRu: [],
    textEn,
    textEnApproved: null,
    media: [],
  });

  it("counts the posts delivery will send, not the ones the author wrote", () => {
    // The Russian fits in two written posts; the English translation of the
    // second does not, and Threads receives the reply it becomes.
    const draft = {
      text_ru: "Раз",
      text_en_machine: "One",
      media_ru_json: null,
      targets_json: JSON.stringify({ threads_ru: true, threads_en: true, telegram: true }),
      thread: [part("Два", "B".repeat(700))],
    };
    const deliveries = plannedTargetDeliveries(draft as never);
    expect(deliveries.map((delivery) => [delivery.target, delivery.posts.length])).toEqual([
      ["threads_ru", 2],
      ["threads_en", 3],
      ["telegram", 1],
    ]);
  });

  it("refuses an attachment the channel cannot take, before anything publishes", () => {
    const draft = {
      text_ru: "Раз",
      text_en_machine: "One",
      media_ru_json: JSON.stringify([{ type: "video", file_id: "big", file_size: 18_000_000 }]),
      targets_json: JSON.stringify({ discord: true }),
    };
    expect(publicationPreflight(draft)).toEqual([
      expect.objectContaining({ target: "discord", kind: "media-size", limit: 10_485_760, actual: 18_000_000 }),
    ]);
    // A boosted server reports a larger cap of its own, and the same file passes.
    expect(publicationPreflight(draft, { discord: 52_428_800 })).toEqual([]);
  });
});

describe("what a failed target may be offered", () => {
  it("offers a retry for a timeout and an edit for a refusal about the content", () => {
    expect(isPostTargetRetryable("discord", "failed", "Discord message create 413: attachment too large")).toBe(false);
    expect(isContentRefusal("threads_text_too_long:part 2:612/500")).toBe(true);
    expect(isPostTargetRetryable("discord", "failed", "Discord message create 503: unavailable")).toBe(true);
    expect(isContentRefusal("Discord message create 503: unavailable")).toBe(false);
  });
});
