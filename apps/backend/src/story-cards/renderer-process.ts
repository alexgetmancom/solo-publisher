import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { OverlayOptions } from "sharp";
import * as z from "zod";
import { MAX_LINES, TEMPLATE_VERSION } from "./copy.js";
import {
  emojiAssetFile,
  STORY_CARD_EMOJI_LEFT,
  STORY_CARD_EMOJI_SIZE,
  STORY_CARD_HEIGHT,
  STORY_CARD_WIDTH,
  storyCardEmojiTop,
  storyCardOverlaySvg,
} from "./svg.js";

// The limits come from copy.ts rather than being restated here: when they were
// two independent literals, raising the line budget passed review and then
// failed at render time against a schema nobody remembered to widen.
const inputSchema = z.object({
  backgroundPath: z.string().min(1),
  assetsDir: z.string().min(1),
  outputPath: z.string().min(1),
  wordmark: z.string(),
  copy: z.object({
    headline: z.string(),
    emoji: z.string().nullable(),
    lines: z.array(z.string()).min(1).max(MAX_LINES),
    boldLineCount: z.number().int().min(0).max(MAX_LINES),
    templateVersion: z.literal(TEMPLATE_VERSION),
  }),
});

const input = inputSchema.parse(JSON.parse(await Bun.stdin.text()));
await mkdir(path.dirname(input.outputPath), { recursive: true });
const { default: sharp } = await import("sharp");
sharp.cache(false);
sharp.concurrency(1);
const composites: OverlayOptions[] = [{ input: Buffer.from(storyCardOverlaySvg(input.copy, input.wordmark)) }];
const emojiFile = emojiAssetFile(input.copy.emoji);
const emojiPath = emojiFile ? path.join(input.assetsDir, "emoji", emojiFile) : null;
if (emojiPath && existsSync(emojiPath)) {
  composites.push({
    input: await sharp(emojiPath).resize(STORY_CARD_EMOJI_SIZE, STORY_CARD_EMOJI_SIZE, { fit: "contain" }).png().toBuffer(),
    left: STORY_CARD_EMOJI_LEFT,
    top: storyCardEmojiTop(input.copy),
  });
}
const result = await sharp(input.backgroundPath)
  .resize(STORY_CARD_WIDTH, STORY_CARD_HEIGHT, { fit: "cover" })
  .composite(composites)
  .jpeg({ quality: 92, chromaSubsampling: "4:4:4" })
  .toFile(input.outputPath);
process.stdout.write(JSON.stringify({ outputPath: input.outputPath, bytes: result.size, emoji: emojiPath && existsSync(emojiPath) }));
