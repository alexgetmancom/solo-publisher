import { describe, expect, it } from "bun:test";
import type { Context } from "grammy";
import { extractMessage } from "../src/bot/message.js";
import { slugify } from "../src/content/message.js";

function messageContext(message: Record<string, unknown>): Context {
  return { message } as unknown as Context;
}

describe("extractMessage", () => {
  it("keeps Telegram animations as video media", () => {
    const result = extractMessage(
      messageContext({
        caption: "Animation caption",
        animation: {
          file_id: "animation-1",
          width: 720,
          height: 1280,
          duration: 4,
          file_name: "clip.mp4",
          mime_type: "video/mp4",
        },
      }),
    );

    expect(result.media).toEqual([
      {
        type: "video",
        file_id: "animation-1",
        width: 720,
        height: 1280,
        duration: 4,
        file_name: "clip.mp4",
        mime_type: "video/mp4",
      },
    ]);
  });

  it("takes a soundless video once when the Bot API sets both animation and document", () => {
    const result = extractMessage(
      messageContext({
        caption: "One attached file",
        animation: { file_id: "animation-1", width: 1920, height: 1080, duration: 14, file_name: "clip.mp4", mime_type: "video/mp4" },
        document: { file_id: "document-twin-1", file_name: "clip.mp4", mime_type: "video/mp4" },
      }),
    );

    expect(result.media).toHaveLength(1);
    expect(result.media[0]?.file_id).toBe("animation-1");
  });

  it("keeps video files sent as Telegram documents as video media", () => {
    const result = extractMessage(
      messageContext({
        document: { file_id: "document-1", file_name: "clip.mp4", mime_type: "application/octet-stream" },
      }),
    );

    expect(result.media).toEqual([
      {
        type: "video",
        file_id: "document-1",
        file_name: "clip.mp4",
        mime_type: "application/octet-stream",
      },
    ]);
  });

  it("does not treat unrelated Telegram documents as post media", () => {
    const result = extractMessage(
      messageContext({
        document: { file_id: "document-2", file_name: "notes.pdf", mime_type: "application/pdf" },
      }),
    );

    expect(result.media).toEqual([]);
  });
});

describe("slugify", () => {
  it("preserves Cyrillic letters with diacritics", () => {
    expect(slugify("Claude Code получил встроенный браузер", 54)).toBe("claude-code-получил-встроенный-браузер");
    expect(slugify("Ёлки и йога", 55)).toBe("ёлки-и-йога");
  });
});
