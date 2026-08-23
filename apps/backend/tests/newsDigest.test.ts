import { describe, expect, it } from "bun:test";
import type { Bot, InputFile } from "grammy";
import { type GrokSpawn, sendDailyNewsDigest } from "../src/interfaces/telegram/news-digest.js";
import { settingsService } from "../src/studio/services/settings.js";
import { withDb } from "./helpers/db.js";
import { loadTestConfig, MSK_STUDIO_PROFILE } from "./helpers/studio-config.js";

const textEncoder = new TextEncoder();
const completeDigest = (headline: string) =>
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

describe("daily news digest", () => {
  it("runs the saved prompt once after the daily time and sends a Markdown file to every administrator", async () => {
    await withDb(async (backendDb) => {
      settingsService(backendDb).setNewsDigest({ enabled: true, hour: 10, minute: 0, prompt: "Find today's AI news." });
      const commands: string[][] = [];
      const spawn: GrokSpawn = (command) => {
        commands.push(command);
        return {
          stdout: stream(
            JSON.stringify({
              text: completeDigest("Today's news"),
              thought: "Internal reasoning must not be sent",
            }),
          ),
          stderr: stream(""),
          exited: Promise.resolve(0),
          kill: () => {},
        };
      };
      const sent: Array<{ actorId: number; document: InputFile }> = [];
      const bot = {
        api: {
          sendMessage: async () => undefined,
          sendDocument: async (actorId: number, document: InputFile) => {
            sent.push({ actorId, document });
          },
        },
      } as unknown as Bot;
      const config = loadTestConfig({ CONTROLLER_ADMIN_IDS: "42,7" }, MSK_STUDIO_PROFILE);
      const now = new Date("2026-07-20T07:30:00.000Z");

      expect(await sendDailyNewsDigest(config, backendDb, bot, now, { spawn })).toEqual({ status: "sent" });
      expect(await sendDailyNewsDigest(config, backendDb, bot, now, { spawn })).toEqual({ status: "already_sent" });
      expect(commands[0]?.slice(0, 6)).toEqual(["grok", "--no-leader", "--reasoning-effort", "xhigh", "--output-format", "json"]);
      // No `--json-schema`: obliged to answer with the schema object, Grok can
      // satisfy that without searching at all, and the runs that failed did
      // exactly that — one sentence about the report, zero tool calls.
      expect(commands[0]).not.toContain("--json-schema");
      expect(commands[0]?.slice(6, 8)).toEqual(["--always-approve", "--single"]);
      expect(commands[0]?.[8]).toContain("Find today's AI news.");
      expect(commands[0]?.[8]).toContain("Search X first");
      expect(sent.map((item) => item.actorId)).toEqual([42, 7]);
      expect(sent.every((item) => item.document.filename === "news-digest-2026-07-20.md")).toBe(true);
      const first = sent.at(0);
      if (!first) throw new Error("The news digest was not sent");
      const raw = new TextDecoder().decode((await first.document.toRaw()) as Uint8Array);
      expect(raw.startsWith("1. **Today's news 1**")).toBe(true);
      expect(raw).toContain("[Source](https://x.com/example/status/1)");
      expect(raw).not.toContain("I am searching");
      expect(raw).not.toContain("Internal reasoning must not be sent");
    });
  });

  it("waits for the configured time unless the operator presses send now", async () => {
    await withDb(async (backendDb) => {
      settingsService(backendDb).setNewsDigest({ enabled: false, hour: 18, minute: 30, prompt: "A prompt" });
      let runs = 0;
      const spawn: GrokSpawn = () => {
        runs += 1;
        return {
          stdout: stream(JSON.stringify({ text: completeDigest("News") })),
          stderr: stream(""),
          exited: Promise.resolve(0),
          kill: () => {},
        };
      };
      const bot = { api: { sendDocument: async () => undefined, sendMessage: async () => undefined } } as unknown as Bot;
      const config = loadTestConfig({ CONTROLLER_ADMIN_IDS: "42" }, MSK_STUDIO_PROFILE);
      const now = new Date("2026-07-20T07:30:00.000Z");

      expect(await sendDailyNewsDigest(config, backendDb, bot, now, { spawn })).toEqual({ status: "disabled" });
      expect(await sendDailyNewsDigest(config, backendDb, bot, now, { force: true, spawn })).toEqual({ status: "sent" });
      expect(await sendDailyNewsDigest(config, backendDb, bot, now, { force: true, spawn })).toEqual({ status: "sent" });
      expect(runs).toBe(2);
    });
  });

  it("cuts the report out of the progress narration Grok concatenates in front of it", async () => {
    await withDb(async (backendDb) => {
      settingsService(backendDb).setNewsDigest({ enabled: true, hour: 0, minute: 0, prompt: "A prompt" });
      const spawn: GrokSpawn = () => ({
        // Verbatim shape of a real run: the narration runs straight into the
        // first numbered item with no line break between them.
        stdout: stream(
          JSON.stringify({
            text: `Ищу свежие посты в X за последние 24 часа.Первый проход дал шум. Сужаю поиск.${completeDigest("Sonic × Fortnite")}`,
            thought: "Internal reasoning must not be sent",
          }),
        ),
        stderr: stream(""),
        exited: Promise.resolve(0),
        kill: () => {},
      });
      const sent: InputFile[] = [];
      const bot = {
        api: {
          sendMessage: async () => undefined,
          sendDocument: async (_actorId: number, document: InputFile) => {
            sent.push(document);
          },
        },
      } as unknown as Bot;
      const config = loadTestConfig({ CONTROLLER_ADMIN_IDS: "42" }, MSK_STUDIO_PROFILE);

      const result = await sendDailyNewsDigest(config, backendDb, bot, new Date("2026-07-20T07:30:00.000Z"), { spawn });

      expect(result).toEqual({ status: "sent" });
      const raw = new TextDecoder().decode((await sent[0]?.toRaw()) as Uint8Array);
      expect(raw.startsWith("1. **Sonic × Fortnite 1**")).toBe(true);
      expect(raw).not.toContain("Ищу в X");
      expect(raw).not.toContain("Добиваю первоисточники");
    });
  });

  it("retries pure narration, then fails with what Grok said", async () => {
    await withDb(async (backendDb) => {
      settingsService(backendDb).setNewsDigest({ enabled: true, hour: 0, minute: 0, prompt: "A prompt" });
      let runs = 0;
      const spawn: GrokSpawn = () => {
        runs += 1;
        return {
          // Only narration, no numbered list: shipping the chatter would be worse than failing.
          stdout: stream(JSON.stringify({ text: "Ищу в X, что обсуждают…" })),
          stderr: stream(""),
          exited: Promise.resolve(0),
          kill: () => {},
        };
      };
      const sent: InputFile[] = [];
      const bot = {
        api: {
          sendMessage: async () => undefined,
          sendDocument: async (_actorId: number, document: InputFile) => {
            sent.push(document);
          },
        },
      } as unknown as Bot;
      const config = loadTestConfig({ CONTROLLER_ADMIN_IDS: "42" }, MSK_STUDIO_PROFILE);

      const result = await sendDailyNewsDigest(config, backendDb, bot, new Date("2026-07-20T07:30:00.000Z"), { spawn });

      expect(result.status).toBe("failed");
      expect(result.status === "failed" && result.error).toContain("Grok answered: Ищу в X, что обсуждают…");
      // Narration is a result like any other, so it is retried rather than
      // abandoned on the first attempt.
      expect(runs).toBe(2);
      expect(sent).toHaveLength(0);
    });
  });

  it("asks Grok to rewrite a short digest once and sends only the complete result", async () => {
    await withDb(async (backendDb) => {
      settingsService(backendDb).setNewsDigest({ enabled: true, hour: 0, minute: 0, prompt: "A prompt" });
      const commands: string[][] = [];
      const spawn: GrokSpawn = (command) => {
        commands.push(command);
        const markdown = commands.length === 1 ? "1. **Ищу свежие игровые факты в X за 24 часа**" : completeDigest("Finished report");
        return {
          stdout: stream(JSON.stringify({ text: markdown })),
          stderr: stream(""),
          exited: Promise.resolve(0),
          kill: () => {},
        };
      };
      const sent: InputFile[] = [];
      const bot = {
        api: {
          sendMessage: async () => undefined,
          sendDocument: async (_actorId: number, document: InputFile) => {
            sent.push(document);
          },
        },
      } as unknown as Bot;
      const config = loadTestConfig({ CONTROLLER_ADMIN_IDS: "42" }, MSK_STUDIO_PROFILE);

      const result = await sendDailyNewsDigest(config, backendDb, bot, new Date("2026-07-20T07:30:00.000Z"), { spawn });

      expect(result).toEqual({ status: "sent" });
      expect(commands).toHaveLength(2);
      expect(commands.map((command) => command[3])).toEqual(["xhigh", "xhigh"]);
      expect(commands[1]?.at(-1)).toContain("Your previous result was incomplete: 46 characters, 1 numbered items and 0 X source links");
      expect(sent).toHaveLength(1);
      const raw = new TextDecoder().decode((await sent[0]?.toRaw()) as Uint8Array);
      expect(raw).toContain("Finished report");
      expect(raw).not.toContain("Ищу свежие");
    });
  });

  it("tells every administrator when the digest failed, and at which effort", async () => {
    await withDb(async (backendDb) => {
      settingsService(backendDb).setNewsDigest({ enabled: true, hour: 0, minute: 0, prompt: "A prompt", effort: "medium" });
      const spawn: GrokSpawn = () => ({
        stdout: stream(JSON.stringify({ text: "Сначала соберу свежие посты за 24 часа." })),
        stderr: stream(""),
        exited: Promise.resolve(0),
        kill: () => {},
      });
      const messages: Array<{ actorId: number; text: string }> = [];
      const documents: InputFile[] = [];
      const bot = {
        api: {
          sendMessage: async (actorId: number, text: string) => {
            messages.push({ actorId, text });
          },
          sendDocument: async (_actorId: number, document: InputFile) => {
            documents.push(document);
          },
        },
      } as unknown as Bot;
      const config = loadTestConfig({ CONTROLLER_ADMIN_IDS: "42,7" }, MSK_STUDIO_PROFILE);

      const result = await sendDailyNewsDigest(config, backendDb, bot, new Date("2026-07-20T07:30:00.000Z"), { spawn });

      expect(result.status).toBe("failed");
      expect(documents).toHaveLength(0);
      // Silence reads as "no news today", which is the one outcome that must
      // never be indistinguishable from a working day.
      expect(messages.map((message) => message.actorId)).toEqual([42, 7]);
      expect(messages[0]?.text).toContain("effort medium");
      expect(messages[0]?.text).toContain("Сначала соберу свежие посты");
    });
  });

  it("does not send a long progress report with only one numbered item and no sources", async () => {
    await withDb(async (backendDb) => {
      settingsService(backendDb).setNewsDigest({ enabled: true, hour: 0, minute: 0, prompt: "A prompt" });
      let runs = 0;
      const spawn: GrokSpawn = () => {
        runs += 1;
        return {
          stdout: stream(JSON.stringify({ text: "1. **Still searching**".padEnd(3_000, "x") })),
          stderr: stream(""),
          exited: Promise.resolve(0),
          kill: () => {},
        };
      };
      const sent: InputFile[] = [];
      const bot = {
        api: {
          sendMessage: async () => undefined,
          sendDocument: async (_actorId: number, document: InputFile) => {
            sent.push(document);
          },
        },
      } as unknown as Bot;
      const config = loadTestConfig({ CONTROLLER_ADMIN_IDS: "42" }, MSK_STUDIO_PROFILE);

      const result = await sendDailyNewsDigest(config, backendDb, bot, new Date("2026-07-20T07:30:00.000Z"), { spawn });

      expect(result.status).toBe("failed");
      expect(result.status === "failed" && result.error).toContain(
        "Grok news digest is incomplete at effort xhigh: 3000 characters, 1 numbered items and 0 X source links; minimum 2582, 10 and 10",
      );
      // The operator is told what Grok actually answered, because every stub so
      // far has been a sentence about the report rather than the report.
      expect(result.status === "failed" && result.error).toContain("Grok answered: 1. **Still searching**");
      expect(runs).toBe(2);
      expect(sent).toHaveLength(0);
    });
  });

  it("rejects an empty digest instead of sending a blank file", async () => {
    await withDb(async (backendDb) => {
      settingsService(backendDb).setNewsDigest({ enabled: true, hour: 0, minute: 0, prompt: "A prompt" });
      const spawn: GrokSpawn = () => ({
        stdout: stream(JSON.stringify({ text: "  \n " })),
        stderr: stream(""),
        exited: Promise.resolve(0),
        kill: () => {},
      });
      const sent: InputFile[] = [];
      const bot = {
        api: {
          sendMessage: async () => undefined,
          sendDocument: async (_actorId: number, document: InputFile) => {
            sent.push(document);
          },
        },
      } as unknown as Bot;
      const config = loadTestConfig({ CONTROLLER_ADMIN_IDS: "42" }, MSK_STUDIO_PROFILE);

      const result = await sendDailyNewsDigest(config, backendDb, bot, new Date("2026-07-20T07:30:00.000Z"), { spawn });

      expect(result).toEqual({ status: "failed", error: "Grok returned an empty news digest" });
      expect(sent).toHaveLength(0);
    });
  });

  it("does not run before the selected time", async () => {
    await withDb(async (backendDb) => {
      settingsService(backendDb).setNewsDigest({ enabled: true, hour: 10, minute: 0, prompt: "A prompt" });
      const spawn: GrokSpawn = () => {
        throw new Error("Grok should not start before the schedule");
      };
      const bot = { api: { sendDocument: async () => undefined, sendMessage: async () => undefined } } as unknown as Bot;
      const config = loadTestConfig({ CONTROLLER_ADMIN_IDS: "42" }, MSK_STUDIO_PROFILE);

      expect(await sendDailyNewsDigest(config, backendDb, bot, new Date("2026-07-20T06:59:00.000Z"), { spawn })).toEqual({
        status: "not_due",
      });
    });
  });
});
