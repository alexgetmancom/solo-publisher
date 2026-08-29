import { escapeXml } from "../foundation/html.js";
import type { StoryCardCopy } from "./copy.js";

export const STORY_CARD_WIDTH = 1080;
export const STORY_CARD_HEIGHT = 1920;
export const STORY_CARD_EMOJI_LEFT = 108;
export const STORY_CARD_EMOJI_SIZE = 58;

// One source for the text block's metrics: the emoji is composited by the
// renderer against the same baseline the SVG draws the copy on, so a layout
// tweak made in one of the two places would silently pull them apart.
const FONT_SIZE = 74;
const LINE_HEIGHT = 94;
const BLOCK_CENTER = 1020;
const TEXT_LEFT = 190;
/** Nudges the emoji's box off the text baseline onto its optical centre. */
const EMOJI_BASELINE_OFFSET = 7;

function storyCardFirstBaseline(copy: StoryCardCopy): number {
  return BLOCK_CENTER - ((copy.lines.length - 1) * LINE_HEIGHT) / 2 + FONT_SIZE * 0.25;
}

export function storyCardEmojiTop(copy: StoryCardCopy): number {
  return Math.round(storyCardFirstBaseline(copy) - STORY_CARD_EMOJI_SIZE + EMOJI_BASELINE_OFFSET);
}

/** Twemoji asset filename for a leading emoji: codepoints in lowercase hex joined
 * by "-", with the FE0F variation selector dropped. Returns a name whether or not
 * the file exists — the renderer checks the assets directory, so widening emoji
 * coverage is a matter of dropping an SVG in, with no code change here. */
export function emojiAssetFile(emoji: string | null): string | null {
  if (!emoji) return null;
  const codePoints = [...emoji].map((character) => character.codePointAt(0) ?? 0).filter((point) => point !== 0xfe0f);
  if (codePoints.length === 0) return null;
  return `${codePoints.map((point) => point.toString(16)).join("-")}.svg`;
}

/** The wordmark is this Studio's own name, empty on an installation that has
 * not claimed one — every card a Studio posts carries it into its audience's
 * Stories, so it can never come from a constant here. */
export function storyCardOverlaySvg(copy: StoryCardCopy, wordmark: string): string {
  const firstBaseline = storyCardFirstBaseline(copy);
  const text = copy.lines
    .map(
      (line, index) =>
        `<text x="${TEXT_LEFT}" y="${firstBaseline + index * LINE_HEIGHT}" class="copy" font-weight="${
          index < copy.boldLineCount ? 680 : 440
        }">${escapeXml(line)}</text>`,
    )
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${STORY_CARD_WIDTH}" height="${STORY_CARD_HEIGHT}">
  <defs>
    <filter id="glow" x="-15%" y="-25%" width="130%" height="150%">
      <feGaussianBlur in="SourceAlpha" stdDeviation="3.2" result="blur"/>
      <feFlood flood-color="#f0d19a" flood-opacity=".18" result="warm"/>
      <feComposite in="warm" in2="blur" operator="in" result="halo"/>
      <feMerge><feMergeNode in="halo"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <style>
      text { font-family: Manrope, sans-serif; fill: #f3eee4; }
      .copy { font-size: ${FONT_SIZE}px; letter-spacing: -1.15px; }
    </style>
  </defs>
  ${
    wordmark
      ? `<text x="540" y="150" text-anchor="middle" font-size="29" font-weight="430"
        letter-spacing="10" fill-opacity=".8" filter="url(#glow)">${escapeXml(wordmark)}</text>`
      : ""
  }
  <g filter="url(#glow)">${text}</g>
</svg>`;
}
