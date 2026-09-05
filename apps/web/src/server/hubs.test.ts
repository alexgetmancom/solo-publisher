import { describe, expect, it } from "bun:test";
import { hubChronology } from "./hubs";
import type { FeedItem } from "./public-site";

function post(postId: number, date: string, textEn: string): FeedItem {
  return {
    id: String(postId),
    post_id: postId,
    date,
    text: textEn,
    text_ru: textEn,
    text_en: textEn,
    html: textEn,
    html_en: textEn,
    slug_ru: `p-${postId}`,
    slug_en: `p-${postId}`,
    has_ru: true,
    has_en: true,
    media: [],
    media_en: [],
    image: null,
    image_en: null,
    entities: [],
    views: 0,
  } as FeedItem;
}

describe("hubChronology", () => {
  it("groups by the month the reader's zone is in, not the server's", () => {
    // 01:30 on 1 September in Moscow is still 18:30 on 31 August in New York.
    const items = [post(1, "2025-08-31T22:30:00.000Z", "Claude is out")];
    expect(hubChronology(items, "en", "America/New_York")[0].key).toBe("2025-08");
    expect(hubChronology(items, "ru", "Europe/Moscow")[0].key).toBe("2025-09");
  });

  it("orders months and the events inside them newest first, whatever order it was handed", () => {
    const items = [
      post(1, "2026-07-02T10:00:00.000Z", "Older"),
      post(3, "2026-09-05T10:00:00.000Z", "Newest"),
      post(2, "2026-09-01T10:00:00.000Z", "Middle"),
    ];
    const months = hubChronology(items, "en", "UTC");
    expect(months.map((month) => month.key)).toEqual(["2026-09", "2026-07"]);
    expect(months[0].events.map((event) => event.title)).toEqual(["Newest", "Middle"]);
  });

  it("tags what each event was", () => {
    const items = [
      post(1, "2026-09-05T10:00:00.000Z", "Claude Code limits are growing by -25%"),
      post(2, "2026-09-04T10:00:00.000Z", "Google released Gemini 3.8 Flash"),
      post(3, "2026-09-03T10:00:00.000Z", "Claude Fable just showed up in the docs"),
    ];
    expect(hubChronology(items, "en", "UTC")[0].events.map((event) => event.kind)).toEqual(["limits", "release", "leak"]);
  });

  it("skips a post that has no slug in this language", () => {
    const missing = { ...post(1, "2026-09-05T10:00:00.000Z", "No English slug"), slug_en: null };
    expect(hubChronology([missing], "en", "UTC")).toEqual([]);
  });
});
