import { describe, expect, it } from "bun:test";
import { getConversationState } from "../src/bot/conversation-state.js";
import { handleStreamMessage, promptStreamField, showStreamScreen } from "../src/bot/stream-screen.js";
import { registerTestChannels } from "./helpers/channels.js";
import { openBackendDb } from "./helpers/open-db.js";
import { loadTestConfig } from "./helpers/studio-config.js";

/**
 * The stream screen edits a channel with an audience on it, so what is pinned
 * here is which channel that turns out to be. A Studio has more than one
 * YouTube account and only ever streams on one of them at a time; asking the
 * operator which is a question YouTube already answers, and answering it wrong
 * renames a stream nobody is watching.
 */

const config = loadTestConfig({
  CONTROLLER_BOT_TOKEN: "bot-token",
  CONTROLLER_ADMIN_IDS: "42",
  YOUTUBE_RU_CLIENT_ID: "client",
  YOUTUBE_RU_CLIENT_SECRET: "secret",
  YOUTUBE_RU_REFRESH_TOKEN: "refresh-ru",
  YOUTUBE_EN_CLIENT_ID: "client",
  YOUTUBE_EN_CLIENT_SECRET: "secret",
  YOUTUBE_EN_REFRESH_TOKEN: "refresh-en",
});

const sent: string[] = [];
const buttons: string[][] = [];

function ctxWith(message: Record<string, unknown> = {}) {
  return {
    from: { id: 42 },
    chat: { id: 42 },
    message,
    reply: async (text: string, options?: { reply_markup?: { inline_keyboard?: Array<Array<{ text: string }>> } }) => {
      sent.push(text);
      buttons.push((options?.reply_markup?.inline_keyboard ?? []).flat().map((button) => button.text));
      return { message_id: sent.length };
    },
  } as never;
}

function studioDb() {
  const backendDb = openBackendDb(":memory:");
  registerTestChannels(backendDb, ["youtube_ru", "youtube_en"]);
  return backendDb;
}

/** Answers as two separate channels. The two are told apart by the credential
 * the caller presents, never by request order: the Studio asks both at once,
 * and a stub that counted calls attributed half the answers to the wrong
 * channel. */
function stubYouTube(perLocale: Record<string, unknown>): { calls: string[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = Object.assign(
    async (url: string | URL | Request, init: RequestInit = {}) => {
      const href = String(url);
      const body = init.body ? String(init.body) : "";
      calls.push(`${init.method ?? "GET"} ${href}${body ? ` ${body}` : ""}`);
      if (href.includes("oauth2.googleapis.com")) {
        const locale = body.includes("refresh-en") ? "en" : "ru";
        return Response.json({ access_token: `token-${locale}` });
      }
      const authorization = new Headers(init.headers).get("authorization") ?? "";
      const locale = authorization.endsWith("token-en") ? "en" : "ru";
      if (init.method === "PUT") return Response.json({});
      const answer = perLocale[locale];
      // The message is the body YouTube sent, verbatim: re-encoding it as JSON
      // escaped the very keys the screen reads it by.
      if (answer instanceof Error) return new Response(answer.message, { status: 403 });
      return Response.json(answer ?? { items: [] });
    },
    { preconnect: original.preconnect },
  ) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

const live = {
  items: [{ id: "bc-live", snippet: { title: "Стримс", description: "", liveChatId: "chat-1" }, status: { lifeCycleStatus: "live" } }],
};

describe("stream screen", () => {
  it("edits the channel that is on the air, not the first one connected", async () => {
    const backendDb = studioDb();
    const youtube = stubYouTube({ ru: { items: [] }, en: live });
    try {
      const effects = await promptStreamField(ctxWith(), backendDb, config, "title");
      expect(effects[0]).toMatchObject({ text: expect.stringContaining("Стримс") });
      expect(getConversationState(backendDb, 42, "stream")?.data.channel).toBe("en");
    } finally {
      youtube.restore();
      backendDb.close();
    }
  });

  /** A channel that cannot stream at all answers 403 forever. That is "no
   * stream here", not an outage, and it must not hide the channel that does
   * have one -- nor vanish from the screen unmentioned. */
  it("keeps working when one channel refuses, and says which one did", async () => {
    const backendDb = studioDb();
    const youtube = stubYouTube({ ru: live, en: new Error("The user is not enabled for live streaming.") });
    try {
      sent.length = 0;
      await showStreamScreen(ctxWith(), backendDb, config);
      expect(sent.at(-1)).toContain("Стримс");
      expect(sent.at(-1)).toContain("EN");
    } finally {
      youtube.restore();
      backendDb.close();
    }
  });

  it("sends the typed value to the channel the prompt was opened against", async () => {
    const backendDb = studioDb();
    const youtube = stubYouTube({ ru: { items: [] }, en: live });
    try {
      await promptStreamField(ctxWith(), backendDb, config, "title");
      const result = await handleStreamMessage(ctxWith({ text: "Пилим бота" }), backendDb, config);
      expect(result.handled).toBe(true);
      const update = youtube.calls.find((call) => call.startsWith("PUT"));
      expect(update).toContain('"title":"Пилим бота"');
      // The dialog is over: the next message is an ordinary one again.
      expect(getConversationState(backendDb, 42, "stream")).toBeNull();
    } finally {
      youtube.restore();
      backendDb.close();
    }
  });

  it("declines a value that is not text rather than sending an empty title", async () => {
    const backendDb = studioDb();
    const youtube = stubYouTube({ ru: live });
    try {
      await promptStreamField(ctxWith(), backendDb, config, "title");
      const result = await handleStreamMessage(ctxWith({ photo: [{ file_id: "p" }] }), backendDb, config);
      expect(result.handled).toBe(true);
      expect(youtube.calls.some((call) => call.startsWith("PUT"))).toBe(false);
    } finally {
      youtube.restore();
      backendDb.close();
    }
  });

  it("says one thing in the chat of the stream the prompt was opened against", async () => {
    const backendDb = studioDb();
    const youtube = stubYouTube({ ru: { items: [] }, en: live });
    try {
      await promptStreamField(ctxWith(), backendDb, config, "chat");
      await handleStreamMessage(ctxWith({ text: "Погнали" }), backendDb, config);
      const insert = youtube.calls.find((call) => call.includes("liveChat/messages"));
      expect(insert).toContain('"liveChatId":"chat-1"');
      expect(insert).toContain('"messageText":"Погнали"');
    } finally {
      youtube.restore();
      backendDb.close();
    }
  });

  /** A stream that is not on the air has no chat, and a button that posts into
   * nothing is a button that reports failure for a living. */
  it("offers no chat button on a stream that has not started", async () => {
    const backendDb = studioDb();
    const starting = { items: [{ id: "bc-soon", snippet: { title: "Стримс" }, status: { lifeCycleStatus: "ready" } }] };
    const youtube = stubYouTube({ ru: starting, en: { items: [] } });
    try {
      sent.length = 0;
      await showStreamScreen(ctxWith(), backendDb, config);
      expect(sent.at(-1)).toContain("Стримс");
      expect(buttons.at(-1)).not.toContain("💬 Say in chat");
      expect(buttons.at(-1)).toContain("✏️ Title");
    } finally {
      youtube.restore();
      backendDb.close();
    }
  });

  /** The screen an operator opens while streaming must not be a place errors
   * pile up. A channel with live streaming switched off answers 403 forever
   * and has no stream; that is not news, and it read as a wall of JSON. */
  it("says nothing about a channel that simply has live streaming switched off", async () => {
    const backendDb = studioDb();
    const off = new Error('{"error":{"code":403,"errors":[{"reason":"liveStreamingNotEnabled"}]}}');
    const youtube = stubYouTube({ ru: live, en: off });
    try {
      sent.length = 0;
      await showStreamScreen(ctxWith(), backendDb, config);
      expect(sent.at(-1)).toContain("Стримс");
      expect(sent.at(-1)).not.toContain("EN");
      expect(sent.at(-1)).not.toContain("403");
    } finally {
      youtube.restore();
      backendDb.close();
    }
  });

  it("reports a real fault as one line, not as the JSON document it arrived in", async () => {
    const backendDb = studioDb();
    const quota = new Error('{"error":{"code":403,"message":"The request cannot be completed because you have exceeded your quota."}}');
    const youtube = stubYouTube({ ru: live, en: quota });
    try {
      sent.length = 0;
      await showStreamScreen(ctxWith(), backendDb, config);
      expect(sent.at(-1)).toContain("exceeded your quota");
      expect(sent.at(-1)).not.toContain("googleapis.com");
      expect(sent.at(-1)).not.toContain('"code"');
    } finally {
      youtube.restore();
      backendDb.close();
    }
  });

  /** Every YouTube stream is a new broadcast that opens with an empty
   * description, so the value the operator wants is the one they typed last
   * time -- offered to reuse, never applied on its own. */
  it("offers the last stream's description when this one opened empty", async () => {
    const backendDb = studioDb();
    const withHistory = {
      items: [
        { id: "bc-live", snippet: { title: "Стримс", description: "", liveChatId: "chat-1" }, status: { lifeCycleStatus: "live" } },
        {
          id: "bc-old",
          snippet: { title: "Прошлый", description: "Ссылки под эфиром", actualEndTime: "2026-08-20T21:00:00Z" },
          status: { lifeCycleStatus: "complete" },
        },
        {
          id: "bc-older",
          snippet: { title: "Позапрошлый", description: "Старое описание", actualEndTime: "2026-08-01T21:00:00Z" },
          status: { lifeCycleStatus: "complete" },
        },
      ],
    };
    const youtube = stubYouTube({ ru: withHistory, en: { items: [] } });
    try {
      const effects = await promptStreamField(ctxWith(), backendDb, config, "description");
      expect(effects[0]).toMatchObject({ text: expect.stringContaining("Ссылки под эфиром") });
      expect(effects[0]).not.toMatchObject({ text: expect.stringContaining("Старое описание") });
    } finally {
      youtube.restore();
      backendDb.close();
    }
  });

  /** A tap ends in the callback runner, which turns a failure into a toast. A
   * typed message has no such boundary: raising there reached the logs and the
   * operator, who had just typed a new title, saw nothing at all. */
  it("answers the typed value even when the stream ended while it was being typed", async () => {
    const backendDb = studioDb();
    const youtube = stubYouTube({ ru: live, en: { items: [] } });
    try {
      await promptStreamField(ctxWith(), backendDb, config, "title");
      youtube.restore();
      const ended = stubYouTube({ ru: { items: [] }, en: { items: [] } });
      try {
        const result = await handleStreamMessage(ctxWith({ text: "Пилим бота" }), backendDb, config);
        expect(result.handled).toBe(true);
        expect(result.effects[0]).toMatchObject({ text: expect.stringContaining("No stream is running any more") });
      } finally {
        ended.restore();
      }
    } finally {
      backendDb.close();
    }
  });

  it("reports a refusal from YouTube instead of raising into the log", async () => {
    const backendDb = studioDb();
    const youtube = stubYouTube({ ru: live, en: { items: [] } });
    try {
      await promptStreamField(ctxWith(), backendDb, config, "chat");
      youtube.restore();
      const refusing = stubYouTube({ ru: new Error('{"error":{"message":"The live chat is no longer live."}}') });
      try {
        const result = await handleStreamMessage(ctxWith({ text: "Привет" }), backendDb, config);
        expect(result.effects[0]).toMatchObject({ text: expect.stringContaining("The live chat is no longer live.") });
      } finally {
        refusing.restore();
      }
    } finally {
      backendDb.close();
    }
  });

  it("says so when a button is tapped after the stream it was drawn for ended", async () => {
    const backendDb = studioDb();
    const youtube = stubYouTube({ ru: { items: [] }, en: { items: [] } });
    try {
      const effects = await promptStreamField(ctxWith(), backendDb, config, "title");
      expect(effects[0]).toMatchObject({ type: "toast", text: expect.stringContaining("No stream is running any more") });
    } finally {
      youtube.restore();
      backendDb.close();
    }
  });

  it("offers no edit buttons when nothing is running", async () => {
    const backendDb = studioDb();
    const youtube = stubYouTube({ ru: { items: [] }, en: { items: [] } });
    try {
      sent.length = 0;
      await showStreamScreen(ctxWith(), backendDb, config);
      expect(sent.at(-1)).toContain("No stream is running");
    } finally {
      youtube.restore();
      backendDb.close();
    }
  });
});
