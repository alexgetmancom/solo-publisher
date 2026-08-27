import { describe, expect, it } from "bun:test";
import type { PipelinePost } from "../src/analytics/pipeline-payload.js";
import { renderOverviewSparkline } from "../src/interfaces/web/dashboard/chart.js";
import { formatMetricValue, getMskDateString, shortPipelineText } from "../src/interfaces/web/dashboard/format.js";
import { renderHeroCard, renderHeroMicroMetrics } from "../src/interfaces/web/dashboard/hero-section.js";
import { formatMedia, getTargetMetric, postMetricTotals, targetCell } from "../src/interfaces/web/dashboard/metrics.js";
import { renderDashboardShell } from "../src/interfaces/web/dashboard/shell.js";
import { renderOverviewPublicationList, renderPublicationDetails } from "../src/interfaces/web/dashboard/table.js";
import { getTargetUrl } from "../src/interfaces/web/dashboard/target-url.js";

function post(overrides: Partial<PipelinePost> = {}): PipelinePost {
  return { post_id: 106, ...overrides };
}

/** A published target with the given metric values, the only shape
 * getTargetMetric will read: it returns 0 for anything not published. */
function published(target: string, metrics: Record<string, number> = {}): Partial<PipelinePost> {
  return {
    targets: { [target]: { status: "published" } },
    metrics: { [target]: Object.fromEntries(Object.entries(metrics).map(([name, value]) => [name, { value }])) },
  };
}

describe("dashboard formatting", () => {
  it("does not show a views delta while the selected period is still zero", () => {
    const metrics = {
      postCount: 0,
      views: 0,
      freshViews: 0,
      medianViews: 10_600,
      reactions: 0,
      replies: 0,
      reposts: 0,
      engagementRate: null,
      countLabel: "0 постов сегодня",
      normLabel: "норма дня",
      contextLabel: "ОХВАТ · 2 АВГ",
      paceLabel: "до нормы 10.6k",
      projectionViews: 0,
      progressPercent: 0,
    };

    const html = renderHeroCard("text", metrics, "ru");

    expect(html).toContain("<strong>0</strong>");
    expect(html).not.toContain("−100%");
    expect(html).not.toContain("0%");
    expect(html).not.toContain('class="hero-card__delta');
  });

  it("formats video completion as a percentage with one decimal place", () => {
    const html = renderHeroMicroMetrics(
      "video",
      {
        videoCount: 1,
        views: 100,
        freshViews: 40,
        medianViews: null,
        completionRate: 24.91925664721141,
        averageWatchTimeMs: 11_500,
        subscribers: 15,
        countLabel: "1 ролик",
        normLabel: "норма дня",
        contextLabel: "ОХВАТ",
        paceLabel: null,
        projectionViews: null,
        progressPercent: null,
      },
      "ru",
    );

    expect(html).toContain("<b>24.9%</b> досмотры");
    expect(html).not.toContain("24.91925664721141");
  });

  it("distinguishes an absent metric from zero", () => {
    // Everything else about this function is cosmetic rounding. This part is
    // not: "" and "0" mean different things to the reader of the dashboard.
    expect(formatMetricValue(null)).toBe("");
    expect(formatMetricValue(undefined)).toBe("");
    expect(formatMetricValue("not a number")).toBe("");
    expect(formatMetricValue(0)).toBe("0");
  });

  it("shifts a UTC timestamp into the Moscow day", () => {
    // 22:30 UTC is already the next day in MSK (+3).
    expect(getMskDateString("2026-07-27T22:30:00.000Z")).toBe("2026-07-28");
    expect(getMskDateString("2026-07-27T10:00:00.000Z")).toBe("2026-07-27");
  });

  it("falls back to today for a missing or invalid date rather than rendering NaN", () => {
    const today = new Date().toISOString().slice(0, 10);
    expect(getMskDateString(null)).toBe(today);
    expect(getMskDateString(undefined)).toBe(today);
    expect(getMskDateString("not a date")).toBe(today);
  });

  it("survives a missing title instead of rendering the word null", () => {
    expect(shortPipelineText(null)).toBe("");
    expect(shortPipelineText("")).toBe("");
  });
});

describe("dashboard shell", () => {
  it("keeps a hidden overview tooltip hidden after the pointer leaves a chart", () => {
    const html = renderDashboardShell("", "ru");
    expect(html).toContain(".overview-chart-tooltip[hidden] { display:none; }");
    expect(html).toContain(".overview-platforms__column + .overview-platforms__column { margin-left:-14px;");
    // The destination block sizes to the rows drawn instead of reserving a fixed
    // block of empty space above the publication list.
    expect(html).toContain("min-height:calc(var(--platform-rows,3) * 40px)");
    expect(html).toContain(".post-detail__content { display:block; padding:18px 0 0 38px; }");
    expect(html).toContain("const chartTooltip = root.querySelector('.overview-chart-tooltip')");
    expect(html).not.toContain("chart-scale");
  });

  it("tracks bound listeners off the DOM, so a cached fragment does not restore dead controls", () => {
    // The fragment cache stores main.innerHTML. A marker written as an attribute
    // is serialized into it and comes back on listener-less elements, which left
    // "show more" and the chart tooltips inert on every cached navigation.
    const html = renderDashboardShell("", "ru");
    expect(html).toContain("const bound = new WeakSet()");
    expect(html).not.toContain("dataset.bound");
  });

  it("puts the overview ceiling on the busiest day itself, so its bar fills the band", () => {
    const html = renderOverviewSparkline(
      [
        { label: "normal", value: 30_000 },
        { label: "best", value: 55_000 },
      ],
      "var(--series-views)",
      "Просмотры",
      "30 дней назад",
      "сегодня",
      "ru",
    );

    // The peak names the cap, so it reaches the line instead of being drawn
    // against a rounder number the period never reached.
    expect(html).toContain(`class="overview-spark__cap"`);
    expect(html).toContain("55k");
    expect(html).not.toContain("100k");
    expect(html).toMatch(/height="58\.00" rx="2"/);
  });

  it("keeps an ordinary month readable when one day goes viral", () => {
    // The shape this exists for: a Studio whose days run in the hundreds and one
    // post that reached 55k. Scaled to the peak, the other 29 days are a 1px
    // line — the strip stops saying anything about the month it covers.
    const days = [...Array(29)].map((_, index) => ({ label: `day${index}`, value: 400 + (index % 5) * 120 }));
    const html = renderOverviewSparkline(
      [...days, { label: "viral", value: 55_000 }],
      "var(--series-views)",
      "Просмотры",
      "30 дней назад",
      "сегодня",
      "ru",
    );

    // The ceiling sits just over the ninetieth percentile of the ordinary days,
    // not on the outlier, which is clipped and marked instead.
    expect(html).toContain("1k");
    expect(html).not.toContain("55k</text>");
    expect(html).toContain("overview-spark__bar--over-cap");
    expect(html).toContain('data-tooltip="viral · 55k"');
    // An ordinary day now uses a real part of the band instead of one pixel.
    const ordinaryHeights = [...html.matchAll(/class="overview-spark__bar"[^>]*height="([\d.]+)"/gu)].map((match) => Number(match[1]));
    expect(Math.max(...ordinaryHeights)).toBeGreaterThan(30);
  });

  it("stops following the peak at the hard cap, and says which day was clipped", () => {
    const html = renderOverviewSparkline(
      [
        { label: "normal", value: 10_000 },
        { label: "viral", value: 75_000 },
      ],
      "var(--series-views)",
      "Просмотры",
      "30 дней назад",
      "сегодня",
      "ru",
    );

    expect(html).toContain("50k");
    expect(html).toContain('class="overview-spark__bar overview-spark__bar--over-cap"');
    // Clipping is about height only: the day still reports what it earned.
    expect(html).toContain('data-tooltip="viral · 75k"');
    expect(html).not.toContain("логарифмическая");
  });

  it("scales the ceiling down to a young studio's numbers so its bars are readable", () => {
    const html = renderOverviewSparkline(
      [
        { label: "quiet", value: 300 },
        { label: "best", value: 1_400 },
      ],
      "var(--series-views)",
      "Просмотры",
      "30 дней назад",
      "сегодня",
      "ru",
    );

    expect(html).toContain("1.4k");
    // The best day nearly fills the 58px band instead of drawing a 1px stub.
    expect(html).toMatch(/height="5[0-9]\.\d\d" rx="2"/);
  });
});

describe("dashboard target URLs", () => {
  it("builds a per-locale site path from that locale's own slug", () => {
    const withSlugs = post({ post_id: 106, slug_ru: "ru-slug", slug_en: "en-slug" });
    expect(getTargetUrl(withSlugs, "site_ru")).toBe("/ru/106/ru-slug/");
    expect(getTargetUrl(withSlugs, "site_en")).toBe("/106/en-slug/");
  });

  it("returns no site URL when that locale has no slug, instead of linking the other locale", () => {
    const englishOnly = post({ post_id: 106, slug_ru: null, slug_en: "en-slug", site_url: "/106/en-slug/" });
    expect(getTargetUrl(englishOnly, "site_ru")).toBeNull();
  });

  it("prefers the recorded telegram URL", () => {
    expect(getTargetUrl(post({ telegram_url: "https://t.me/alexgetman/106" }), "telegram")).toBe("https://t.me/alexgetman/106");
  });

  it("builds x and threads permalinks from an external id", () => {
    expect(getTargetUrl(post({ targets: { x: { external_id: "1234" } } }), "x")).toBe("https://x.com/alexgetmancom/status/1234");
    expect(getTargetUrl(post({ targets: { threads_ru: { external_id: "abc" } } }), "threads_ru")).toBe(
      "https://www.threads.com/@alexgetmanru/post/abc",
    );
    expect(getTargetUrl(post({ targets: { threads_en: { external_id: "abc" } } }), "threads_en")).toBe(
      "https://www.threads.com/@alexgetmanco/post/abc",
    );
  });

  it("rewrites a stored threads.net URL to threads.com", () => {
    expect(getTargetUrl(post({ targets: { threads_ru: { url: "https://www.threads.net/@x/post/1" } } }), "threads_ru")).toBe(
      "https://www.threads.com/@x/post/1",
    );
  });

  it("passes an external id through when it is already a URL", () => {
    expect(getTargetUrl(post({ targets: { x: { external_id: "https://x.com/i/status/9" } } }), "x")).toBe("https://x.com/i/status/9");
  });

  it("returns null for an unknown target and for a target with nothing recorded", () => {
    expect(getTargetUrl(post(), "instagram_stories")).toBeNull();
    expect(getTargetUrl(post({ targets: { x: { status: "queued" } } }), "x")).toBeNull();
  });
});

describe("dashboard metrics", () => {
  it("reads a metric only from a published target", () => {
    expect(getTargetMetric(post(published("x", { views: 500 })), "x", "views")).toBe(500);
    expect(getTargetMetric(post({ targets: { x: { status: "queued" } }, metrics: { x: { views: { value: 500 } } } }), "x", "views")).toBe(
      0,
    );
  });

  it("infers published status for telegram and site targets from their recorded URL", () => {
    expect(
      getTargetMetric(post({ telegram_url: "https://t.me/a/1", metrics: { telegram: { views: { value: 9 } } } }), "telegram", "views"),
    ).toBe(9);
    expect(getTargetMetric(post({ site_ru: "/ru/106/s/", metrics: { site_ru: { views: { value: 4 } } } }), "site_ru", "views")).toBe(4);
  });

  it("treats an absent, null or unparseable metric as zero", () => {
    expect(getTargetMetric(post(published("x")), "x", "views")).toBe(0);
    expect(getTargetMetric(post(published("x", { views: Number.NaN })), "x", "views")).toBe(0);
    expect(getTargetMetric(post(), "x", "views")).toBe(0);
  });

  it("sums every metric across the given targets", () => {
    const both: PipelinePost = {
      targets: { x: { status: "published" }, threads_ru: { status: "published" } },
      metrics: {
        x: { views: { value: 100 }, likes: { value: 5 }, replies: { value: 1 }, reposts: { value: 2 } },
        threads_ru: { views: { value: 50 }, likes: { value: 3 } },
      },
    };
    expect(postMetricTotals(both, ["x", "threads_ru"])).toEqual({ views: 150, likes: 8, replies: 1, reposts: 2 });
    expect(postMetricTotals(both, [])).toEqual({ views: 0, likes: 0, replies: 0, reposts: 0 });
  });

  it("folds bot_views into the visible site views cell", () => {
    const cell = targetCell(post({ ...published("site_ru", { views: 10, bot_views: 4 }), slug_ru: "s" }), "site_ru");
    expect(cell).toContain(">14<");
  });

  it("renders tildes while a target is still in flight and dashes when it never published", () => {
    expect(targetCell(post({ targets: { x: { status: "queued" } } }), "x")).toBe(
      '<span class="mv">~</span><span class="ml">~</span><span class="mr">~</span><span class="mp">~</span>',
    );
    expect(targetCell(post({ targets: { x: { status: "publishing" } } }), "x")).toContain("~");
    expect(targetCell(post({ targets: { x: { status: "failed" } } }), "x")).toBe(
      '<span class="mv">—</span><span class="ml">—</span><span class="mr">—</span><span class="mp">—</span>',
    );
  });

  it("distinguishes a collected zero from a metric that was never collected", () => {
    const cell = targetCell(post(published("x", { views: 0 })), "x");
    expect(cell).toContain('<span class="mv">0</span>');
    // likes were never sampled, so the cell must not claim zero likes.
    expect(cell).toContain('<span class="ml">—</span>');
  });

  it("links the views cell when the target has a public URL and leaves the rest plain", () => {
    const linked = targetCell(post({ ...published("x", { views: 7 }), targets: { x: { status: "published", external_id: "42" } } }), "x");
    expect(linked).toContain('<a class="metric-link" href="https://x.com/alexgetmancom/status/42"');
    expect(linked).toContain('rel="noopener noreferrer"');
    expect(linked.match(/<a /g)?.length).toBe(1);
  });

  it("labels media by kind and count, preferring the English gallery", () => {
    expect(formatMedia(post())).toBe("text");
    expect(formatMedia(post({ media_en_json: [{ type: "photo" }, { type: "photo" }] }))).toBe("pic (2)");
    expect(formatMedia(post({ media_en_json: [{ type: "video" }] }))).toBe("vid (1)");
    expect(formatMedia(post({ media_en_json: [{ media_type: "VIDEO" }, { type: "photo" }] }))).toBe("vid (2)");
    expect(formatMedia(post({ media_ru_json: [{ type: "photo" }], media_en_json: null }))).toBe("pic (1)");
  });
});

describe("publication detail fragments", () => {
  const viewed = (views: number, text: string): PipelinePost => ({
    post_id: views,
    text_en: text,
    ...published("x", { views }),
  });

  it("renders bounded detail fragments for the lazy loader", () => {
    const result = renderPublicationDetails(
      "ru",
      ["ru", "en"],
      Array.from({ length: 9 }, (_, index) => viewed(index, `post ${index}`)),
      undefined,
      [],
      5,
      2,
    );
    expect(result.total).toBe(9);
    expect(result.loaded).toBe(2);
    expect(result.remaining).toBe(2);
    expect(result.html.match(/<details class="post-detail">/g)?.length).toBe(2);
    // Ordered by views, so offset 5 lands on the sixth and seventh best posts.
    expect(result.html).toContain("post 3");
    expect(result.html).toContain("post 2");
  });

  it("orders publications by views, best first, in every period", () => {
    const result = renderPublicationDetails(
      "ru",
      ["ru", "en"],
      [viewed(4, "quiet"), viewed(90, "hit"), viewed(30, "middle")],
      undefined,
      [],
      0,
      10,
    );
    expect(result.html.indexOf("hit")).toBeLessThan(result.html.indexOf("middle"));
    expect(result.html.indexOf("middle")).toBeLessThan(result.html.indexOf("quiet"));
  });
});

describe("a Studio that publishes one language", () => {
  const bilingual: PipelinePost = {
    post_id: 7,
    date: "2026-08-19T09:00:00.000Z",
    text_ru: "Скидка 91% стала рекордной",
    full_text_ru: "Скидка 91% стала рекордной",
    text_en: "The 91% discount is the biggest",
    full_text_en: "The 91% discount is the biggest",
    ...published("telegram", { views: 12 }),
  };

  it("heads its publications with what it actually published, and shows that copy alone", () => {
    // The row used to be titled by a machine translation the Studio never sent
    // anywhere, over an ENGLISH / RU ORIGINAL pair that claimed it published both.
    const html = renderOverviewPublicationList("ru", ["ru"], [bilingual], ["telegram"]);

    expect(html).toContain("Скидка 91% стала рекордной");
    expect(html).not.toContain("The 91% discount is the biggest");
    expect(html).not.toContain("ENGLISH");
    expect(html).not.toContain("RU ORIGINAL");
  });

  it("keeps both languages for a Studio that publishes both", () => {
    const html = renderOverviewPublicationList("ru", ["ru", "en"], [bilingual], ["telegram"]);

    expect(html).toContain("The 91% discount is the biggest");
    expect(html).toContain("ENGLISH");
    expect(html).toContain("RU ORIGINAL");
  });
});

describe("renderOverviewPublicationList", () => {
  it("uses thin expandable rows and keeps the lower detail contract", () => {
    const html = renderOverviewPublicationList(
      "ru",
      ["ru", "en"],
      [
        {
          post_id: 1,
          date: "2026-08-01T12:00:00.000Z",
          text_en: "English copy",
          full_text_en: "Full English copy",
          text_ru: "Русский текст",
          targets: { x: { status: "published", external_id: "123" } },
          metrics: { x: { views: { value: 42 }, likes: { value: 4 }, replies: { value: 2 } } },
          media_en_json: [{ url: "/media/post.jpg" }],
        },
      ],
      ["x"],
      [],
      { limit: 4, moreUrl: "/api/publication-details" },
    );

    expect(html).toContain('<div class="overview-publications__list">');
    expect(html).toContain('<details class="post-detail">');
    expect(html).toContain("Full English copy");
    expect(html).toContain("Русский текст");
    expect(html).toContain('class="post-platforms"');
    expect(html).toContain('<b class="post-platform__locale">EN</b>');
    expect(html).toContain('class="post-platform__metrics"');
    expect(html).toContain('title="Охват" aria-label="Охват: 42"');
    expect(html).toContain('title="Реакции" aria-label="Реакции: 4"');
    expect(html).toContain('title="Ответы" aria-label="Ответы: 2"');
    expect(html).not.toContain("X (Twitter) EN</span>");
    expect(html).not.toContain('<img src="/media/post.jpg"');
  });

  it("keeps publication rows compact with a count and a grouped tooltip", () => {
    const textPost: PipelinePost = {
      post_id: 2,
      date: "2026-08-02T12:00:00.000Z",
      full_text_en: "One two three four five six seven eight nine",
      targets: {
        telegram: { status: "published" },
        x: { status: "published" },
      },
      metrics: {
        telegram: { views: { value: 42 }, likes: { value: 4 }, replies: { value: 2 } },
        x: { views: { value: 18 }, likes: { value: 2 }, replies: { value: 1 } },
      },
    };
    const html = renderOverviewPublicationList("ru", ["ru", "en"], [textPost], ["telegram", "x"]);

    expect(html).toContain("One two three four five six seven...");
    expect(html).toContain('class="post-detail__platform-summary post-detail__platform-summary--count"');
    expect(html).toContain('<b class="post-detail__platform-count">2</b>');
    expect(html).toContain('class="post-detail__platform-tooltip" role="tooltip"');
    expect(html).toContain("<b>EN</b>");
    expect(html).toContain("<b>RU</b>");
    expect(html).toContain("<span>X (Twitter)</span>");
    expect(html).toContain("<span>Telegram</span>");
    expect(html).not.toContain("post-detail__platform-marker");
    expect(html).not.toContain("data-tooltip=");
    expect(html.match(/class="post-detail__metric/g)?.length).toBe(3);
    expect(html).not.toContain("post-detail__metric--separated");
  });

  it("shows the exact destination count and splits the tooltip by locale", () => {
    const targetIds = [
      "site_en",
      "site_ru",
      "threads_en",
      "threads_ru",
      "instagram_stories",
      "instagram_stories_ru",
      "telegram",
      "telegram_stories",
    ];
    const post: PipelinePost = {
      date: "2026-08-02T12:00:00.000Z",
      full_text_en: "Published everywhere",
      targets: Object.fromEntries(targetIds.map((target) => [target, { status: "published" }])),
    };
    const html = renderOverviewPublicationList("ru", ["ru", "en"], [post], targetIds);

    expect(html).toContain('<b class="post-detail__platform-count">8</b>');
    expect(html).toContain("<b>EN</b>");
    expect(html).toContain("<b>RU</b>");
    for (const name of ["Site", "Threads", "Instagram Stories", "Telegram", "Telegram Stories"])
      expect(html).toContain(`<span>${name}</span>`);
    expect(html).not.toContain("post-detail__platform-marker");
    expect(html).not.toContain("data-tooltip=");
  });

  it("renders a video row as icon plus locale without a source label", () => {
    const html = renderOverviewPublicationList(
      "ru",
      ["ru", "en"],
      [],
      [],
      [
        {
          key: "video:2",
          destinations: [
            {
              target: "instagram_reels",
              label: "Instagram RU",
              locale: "RU",
              providerAccountId: null,
              url: "https://www.instagram.com/reel/CODE123/",
              views: 100,
              reactions: 8,
              replies: 1,
            },
          ],
          title: "First second third fourth fifth sixth seventh eighth",
          url: "https://www.instagram.com/reel/CODE123/",
          publishedAt: "2026-08-02T12:00:00.000Z",
          views: 100,
          reactions: 8,
          replies: 1,
          afterPeriodViews: 0,
          lifetimeViews: 100,
          subscribers: null,
        },
      ],
    );

    expect(html).toContain("First second third fourth fifth sixth seventh...");
    // The row opens like a text row; the permalink lives on the destination
    // inside it, where a clip on two platforms has one link each.
    expect(html).toContain("<details");
    expect(html).toContain('<a class="post-platform" href="https://www.instagram.com/reel/CODE123/"');
    expect(html).toContain("РЕЗУЛЬТАТ ПО ПЛОЩАДКАМ");
    expect(html).toContain('class="post-detail__platform-summary" aria-label="Instagram RU"');
    expect(html).toContain('<i class="platform-mark">');
    expect(html).toContain('<b class="post-detail__platform-locale">RU</b>');
    expect(html).not.toContain("data-tooltip=");
    expect(html).not.toContain("post-detail__source");
  });
});
