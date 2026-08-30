import { describe, expect, it } from "bun:test";
import { canonicalUrl, clusterKey, titleSimilarity } from "../src/editorial/cluster.js";
import type { GrokSpawn } from "../src/editorial/producers/grok.js";
import { acceptCandidate, runRadar } from "../src/editorial/radar.js";
import { scoreCandidate, selectForDelivery } from "../src/editorial/ranking.js";
import {
  candidateCounts,
  decideCandidate,
  decisionCounters,
  getCandidate,
  lastRun,
  listCandidates,
  recentRuns,
} from "../src/editorial/store.js";
import { settingsService } from "../src/studio/services/settings.js";
import { withDb } from "./helpers/db.js";
import { loadTestConfig, MSK_STUDIO_PROFILE } from "./helpers/studio-config.js";

const textEncoder = new TextEncoder();

const report = (headline: string) =>
  Array.from(
    { length: 10 },
    (_, index) =>
      `${index + 1}. **${headline} ${index + 1}**\n\n${"Substantive reporting. ".repeat(12)}\n\n[Source](https://x.com/example/status/${index + 1})`,
  ).join("\n\n");

function stream(value: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(textEncoder.encode(value));
      controller.close();
    },
  });
}

function grokReturning(text: string | ((call: number) => string), calls: string[][] = []): GrokSpawn {
  return (command) => {
    calls.push(command);
    return {
      stdout: stream(JSON.stringify({ text: typeof text === "string" ? text : text(calls.length) })),
      stderr: stream(""),
      exited: Promise.resolve(0),
      kill: () => {},
    };
  };
}

/** DeepSeek, answering with the items a test wants read out of Grok's report. */
function deepSeekReturning(items: unknown[]): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ items }) } }] }), {
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

const radarConfig = (admins = "42") => loadTestConfig({ CONTROLLER_ADMIN_IDS: admins, DEEPSEEK_API_KEY: "test-key" }, MSK_STUDIO_PROFILE);

/** Findings a test can tell apart, and so can the radar: headlines that share
 * their distinctive words are one story, which is the whole point of the
 * clustering and would otherwise make every fixture collapse into one card. */
const SUBJECTS = [
  "OpenAI ships a developer console",
  "Anthropic publishes interpretability research",
  "Mistral raises a funding round",
  "Google retires an image product",
];

const findings = (count: number) =>
  SUBJECTS.slice(0, count).map((title, index) => ({
    title,
    summary: `What happened: ${title}.`,
    reason: `It continues a subject this Studio has published about, item ${index + 1}.`,
    url: `https://example.com/story-${index + 1}?utm_source=x`,
  }));

describe("radar search", () => {
  it("runs the saved prompt once a day, stores what it found, and keeps the raw report", async () => {
    await withDb(async (backendDb) => {
      settingsService(backendDb).setRadar({ enabled: true, hour: 10, minute: 0, prompt: "Find today's AI news." });
      const calls: string[][] = [];
      const options = { spawn: grokReturning(report("Today"), calls), fetchImpl: deepSeekReturning(findings(3)) };
      const now = new Date("2026-07-20T07:30:00.000Z");

      const first = await runRadar(radarConfig(), backendDb, "news", { ...options, now });
      const second = await runRadar(radarConfig(), backendDb, "news", { ...options, now });

      expect(first).toEqual({ status: "stored", producer: "news", inserted: 3, duplicates: 0 });
      expect(second).toEqual({ status: "already_ran" });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.slice(0, 6)).toEqual(["grok", "--no-leader", "--reasoning-effort", "xhigh", "--output-format", "json"]);
      // No `--json-schema`: obliged to answer with the schema object, Grok can
      // satisfy that without searching at all, and the runs that failed did
      // exactly that -- one sentence about the report, zero tool calls.
      expect(calls[0]).not.toContain("--json-schema");
      expect(calls[0]?.[8]).toContain("Find today's AI news.");
      expect(calls[0]?.[8]).toContain("Search X first");
      // The search is expensive and the reading of it is not: keeping the report
      // means a bad parse can be redone without paying for the search again.
      expect(lastRun(backendDb, "news")?.rawText).toContain("Today 1");
      expect(candidateCounts(backendDb)).toEqual({ waiting: 3, later: 0 });
      // Stored under the link itself, with what identified the referrer removed.
      expect(
        listCandidates(backendDb, "new", 3)
          .map((candidate) => candidate.url)
          .sort(),
      ).toEqual(["https://example.com/story-1", "https://example.com/story-2", "https://example.com/story-3"]);
    });
  });

  it("cuts the report out of the progress narration Grok concatenates in front of it", async () => {
    await withDb(async (backendDb) => {
      settingsService(backendDb).setRadar({ enabled: true, hour: 0, minute: 0, prompt: "A prompt" });
      const narrated = `Ищу свежие посты в X за последние 24 часа.Первый проход дал шум.${report("Sonic")}`;

      await runRadar(radarConfig(), backendDb, "news", {
        spawn: grokReturning(narrated),
        fetchImpl: deepSeekReturning(findings(1)),
        now: new Date("2026-07-20T07:30:00.000Z"),
      });

      expect(lastRun(backendDb, "news")?.rawText?.startsWith("1. **Sonic 1**")).toBe(true);
    });
  });

  it("retries a report that is only narration, then fails with what Grok said", async () => {
    await withDb(async (backendDb) => {
      settingsService(backendDb).setRadar({ enabled: true, hour: 0, minute: 0, prompt: "A prompt" });
      const calls: string[][] = [];

      const result = await runRadar(radarConfig(), backendDb, "news", {
        spawn: grokReturning("Ищу в X, что обсуждают…", calls),
        fetchImpl: deepSeekReturning([]),
        now: new Date("2026-07-20T07:30:00.000Z"),
      });

      expect(result.status).toBe("failed");
      expect(result.status === "failed" && result.error).toContain("Grok answered: Ищу в X, что обсуждают…");
      // Narration is a result like any other, so it is retried rather than
      // abandoned on the first attempt.
      expect(calls).toHaveLength(2);
      // An empty radar and a broken radar must not look alike.
      expect(lastRun(backendDb, "news")?.status).toBe("failed");
      expect(candidateCounts(backendDb).waiting).toBe(0);
    });
  });

  it("asks Grok to rewrite an incomplete report once, and pays the reader only for the finished one", async () => {
    await withDb(async (backendDb) => {
      settingsService(backendDb).setRadar({ enabled: true, hour: 0, minute: 0, prompt: "A prompt" });
      const calls: string[][] = [];
      let readings = 0;
      const fetchImpl = (async (...args: Parameters<typeof fetch>) => {
        readings += 1;
        return deepSeekReturning(findings(2))(...args);
      }) as typeof fetch;

      const result = await runRadar(radarConfig(), backendDb, "news", {
        spawn: grokReturning((call) => (call === 1 ? "1. **Ищу свежие факты в X**" : report("Finished")), calls),
        fetchImpl,
        now: new Date("2026-07-20T07:30:00.000Z"),
      });

      expect(result).toEqual({ status: "stored", producer: "news", inserted: 2, duplicates: 0 });
      expect(calls).toHaveLength(2);
      expect(calls.map((call) => call[3])).toEqual(["xhigh", "xhigh"]);
      expect(calls[1]?.at(-1)).toContain("Your previous result was incomplete: 1 numbered items and 0 X source links");
      expect(readings).toBe(1);
    });
  });

  it("does not run before the selected time, and runs on demand whatever the clock says", async () => {
    await withDb(async (backendDb) => {
      settingsService(backendDb).setRadar({ enabled: true, hour: 10, minute: 0, prompt: "A prompt" });
      const options = { spawn: grokReturning(report("News")), fetchImpl: deepSeekReturning(findings(1)) };

      expect(await runRadar(radarConfig(), backendDb, "news", { ...options, now: new Date("2026-07-20T06:59:00.000Z") })).toEqual({
        status: "not_due",
      });
      expect(
        await runRadar(radarConfig(), backendDb, "news", { ...options, force: true, now: new Date("2026-07-20T06:59:00.000Z") }),
      ).toEqual({ status: "stored", producer: "news", inserted: 1, duplicates: 0 });
    });
  });
});

describe("radar candidates", () => {
  it("offers one story once, however many links and headlines it arrives under", async () => {
    await withDb(async (backendDb) => {
      settingsService(backendDb).setRadar({ enabled: true, hour: 0, minute: 0, prompt: "A prompt" });
      const config = radarConfig();
      const monday = new Date("2026-07-20T07:30:00.000Z");
      const tuesday = new Date("2026-07-21T07:30:00.000Z");
      const story = {
        title: "OpenAI releases GPT-6 to developers",
        summary: "The model is available in the API today.",
        reason: "It continues the model-release cluster this Studio publishes.",
        url: "https://openai.com/blog/gpt-6?utm_source=x",
      };

      await runRadar(config, backendDb, "news", {
        spawn: grokReturning(report("A")),
        fetchImpl: deepSeekReturning([story]),
        now: monday,
      });
      await runRadar(config, backendDb, "news", {
        spawn: grokReturning(report("B")),
        fetchImpl: deepSeekReturning([
          // The same link, tracking parameters aside.
          { ...story, title: "Another headline entirely", url: "https://www.openai.com/blog/gpt-6/?ref=newsletter" },
          // The same story, restated, from somewhere else.
          { ...story, title: "GPT-6 released by OpenAI for developers", url: "https://press.example.com/gpt-6" },
        ]),
        now: tuesday,
      });

      expect(candidateCounts(backendDb)).toEqual({ waiting: 1, later: 0 });
      expect(recentRuns(backendDb, 2)[0]?.duplicateCount).toBe(2);
    });
  });

  it("makes one draft from a finding, and nothing at all from the second tap", async () => {
    await withDb(async (backendDb) => {
      settingsService(backendDb).setRadar({ enabled: true, hour: 0, minute: 0, prompt: "A prompt" });
      await runRadar(radarConfig(), backendDb, "news", {
        spawn: grokReturning(report("A")),
        fetchImpl: deepSeekReturning(findings(1)),
        now: new Date("2026-07-20T07:30:00.000Z"),
      });
      const candidate = listCandidates(backendDb, "new", 1)[0];
      if (!candidate) throw new Error("The radar stored no candidate");

      const first = acceptCandidate(backendDb, 42, candidate.id);
      // The card is still in the chat, and a card in a chat is tapped twice.
      const second = acceptCandidate(backendDb, 42, candidate.id);

      expect(first?.draftId).toBeGreaterThan(0);
      expect(second).toBeNull();
      const stored = getCandidate(backendDb, candidate.id);
      expect(stored?.status).toBe("accepted");
      expect(backendDb.drafts.list([42], 10)).toHaveLength(1);
    });
  });

  it("counts a decision by subject, and does not count 'already covered' against the subject", async () => {
    await withDb(async (backendDb) => {
      settingsService(backendDb).setRadar({ enabled: true, hour: 0, minute: 0, prompt: "A prompt" });
      await runRadar(radarConfig(), backendDb, "news", {
        spawn: grokReturning(report("A")),
        fetchImpl: deepSeekReturning(findings(2)),
        now: new Date("2026-07-20T07:30:00.000Z"),
      });
      const [first, second] = listCandidates(backendDb, "new", 2);
      if (!first || !second) throw new Error("The radar stored too few candidates");

      expect(decideCandidate(backendDb, first.id, { status: "skipped", skipReason: "already-covered" })).toBe(true);
      // A decision already taken is not retaken by a second tap on an old card.
      expect(decideCandidate(backendDb, first.id, { status: "later" })).toBe(false);
      decideCandidate(backendDb, second.id, { status: "skipped", skipReason: "off-topic" });

      const counters = decisionCounters(backendDb);
      expect(counters.skipped).toBe(1);
      expect(getCandidate(backendDb, first.id)?.status).toBe("skipped");
    });
  });
});

describe("radar ranking", () => {
  it("prefers the subject the editor keeps accepting, and marks down a story already published", () => {
    const counters = {
      bySlug: new Map([
        ["accepted-subject", { accepted: 6, skipped: 0 }],
        ["declined-subject", { accepted: 0, skipped: 6 }],
      ]),
      byHost: new Map<string, { accepted: number; skipped: number }>(),
      accepted: 6,
      skipped: 6,
    };
    const base = { title: "A model release", summary: "", reason: "Because of the cluster.", url: null, relatedPostIds: [] };
    const liked = scoreCandidate({ ...base, entitySlugs: ["accepted-subject"] }, { counters, posts: [], host: null });
    const disliked = scoreCandidate({ ...base, entitySlugs: ["declined-subject"] }, { counters, posts: [], host: null });
    const unknown = scoreCandidate({ ...base, entitySlugs: [] }, { counters, posts: [], host: null });

    expect(liked.score).toBeGreaterThan(unknown.score);
    expect(unknown.score).toBeGreaterThan(disliked.score);
    // A subject with no history is not buried: it is where every new subject starts.
    expect(unknown.scores.subject).toBeGreaterThan(0);
  });

  it("spends one of the three slots on something it is less sure of", () => {
    const ranked = [90, 80, 70, 60, 50].map((score, index) => ({ id: index + 1, score }));

    const shown = selectForDelivery(ranked, 3, 0);

    expect(shown.slice(0, 2).map((item) => item.score)).toEqual([90, 80]);
    // A radar that only ever shows its best guesses only ever hears about them.
    expect(shown[2]?.score).toBeLessThan(80);
  });
});

describe("radar clustering", () => {
  it("strips what identifies the referrer rather than the page", () => {
    expect(canonicalUrl("https://www.example.com/a/b/?utm_source=x&id=7")).toBe("https://example.com/a/b?id=7");
    expect(canonicalUrl("not a url")).toBeNull();
  });

  it("reads one story under two headlines as one", () => {
    // Word order and everything common between them stops mattering.
    expect(clusterKey("OpenAI releases GPT-6 to developers")).toBe(clusterKey("To developers, OpenAI releases GPT-6"));
    // A restated headline keeps its names and numbers, which is what the
    // similarity pass is for once the exact key has moved.
    expect(titleSimilarity("OpenAI releases GPT-6 to developers", "GPT-6 released by OpenAI for developers")).toBeGreaterThan(0.6);
    expect(titleSimilarity("OpenAI releases GPT-6", "Anthropic ships Claude 5")).toBeLessThan(0.2);
  });
});
