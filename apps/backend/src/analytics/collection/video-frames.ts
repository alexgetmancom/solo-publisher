import { runFfmpegCapture } from "../../foundation/runtime/ffmpeg.js";

/** The frame is measured, not viewed, so it is decoded small: 64 by 114 keeps
 * a vertical video's proportions and is enough for every figure below while
 * costing a few kilobytes per frame. */
const WIDTH = 64;
const HEIGHT = 114;

/** The moments worth looking at. Zero is what a viewer sees before deciding,
 * one and three are where the retention figures already are. */
export const FRAME_SECONDS = [0, 1, 3] as const;

export type FrameFeatures = {
  brightness: number;
  contrast: number;
  saturation: number;
  edgeDensity: number;
  skinShare: number;
  splitScore: number;
  shape: "face" | "split" | "gameplay";
};

/**
 * Measures one frame of a video.
 *
 * Everything here is arithmetic on pixels, which is a deliberate limit: it can
 * say a large skin-toned region sits in the middle of the frame, and it cannot
 * say whose face it is or whether the makeup works. What it does answer is the
 * question actually being asked -- was this opening a face, a split screen or
 * plain gameplay -- and it answers it for a hundred and seventy videos without
 * a vision model or a per-frame bill.
 */
export async function frameFeatures(input: string, atSeconds: number): Promise<FrameFeatures> {
  const pixels = await runFfmpegCapture([
    "-ss",
    String(atSeconds),
    "-i",
    input,
    "-frames:v",
    "1",
    "-vf",
    `scale=${WIDTH}:${HEIGHT}`,
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgb24",
    "-",
  ]);
  if (pixels.length < WIDTH * HEIGHT * 3) throw new Error(`frame_unavailable: ffmpeg returned ${pixels.length} bytes at ${atSeconds}s`);
  return describe(pixels);
}

function describe(pixels: Uint8Array): FrameFeatures {
  const luma: number[] = [];
  let saturationSum = 0;
  let skin = 0;
  let centreCount = 0;
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const offset = (y * WIDTH + x) * 3;
      const red = pixels[offset] ?? 0;
      const green = pixels[offset + 1] ?? 0;
      const blue = pixels[offset + 2] ?? 0;
      luma.push(0.299 * red + 0.587 * green + 0.114 * blue);
      const max = Math.max(red, green, blue);
      const min = Math.min(red, green, blue);
      saturationSum += max === 0 ? 0 : (max - min) / max;
      // The middle of the frame is where a talking head sits; a skin-toned
      // corner is usually a wooden table or a wall.
      const inCentre = x > WIDTH * 0.2 && x < WIDTH * 0.8 && y > HEIGHT * 0.15 && y < HEIGHT * 0.85;
      if (!inCentre) continue;
      centreCount += 1;
      if (isSkin(red, green, blue)) skin += 1;
    }
  }
  const count = WIDTH * HEIGHT;
  const brightness = luma.reduce((sum, value) => sum + value, 0) / count;
  const contrast = Math.sqrt(luma.reduce((sum, value) => sum + (value - brightness) ** 2, 0) / count);
  const skinShare = centreCount ? skin / centreCount : 0;
  const splitScore = split(luma);
  const edgeDensity = edges(luma);
  return {
    brightness: round(brightness),
    contrast: round(contrast),
    saturation: round((saturationSum / count) * 100),
    edgeDensity: round(edgeDensity * 100),
    skinShare: round(skinShare * 100),
    splitScore: round(splitScore * 100),
    shape: skinShare > 0.18 ? "face" : splitScore > 0.25 ? "split" : "gameplay",
  };
}

/** A rough skin-tone test in RGB. It catches faces and hands, and it also
 * catches sand and wood -- which is why it is only trusted in the middle of
 * the frame and reported as a share rather than as a yes. */
function isSkin(red: number, green: number, blue: number): boolean {
  return red > 95 && green > 40 && blue > 20 && red > green && red > blue && red - Math.min(green, blue) > 15;
}

/** A vertical split screen leaves a hard horizontal seam and two halves with
 * different brightness. One without the other is a dark sky over a bright
 * floor, so both are required. */
function split(luma: number[]): number {
  const middle = Math.floor(HEIGHT / 2);
  const rowMean = (row: number) => {
    let sum = 0;
    for (let x = 0; x < WIDTH; x += 1) sum += luma[row * WIDTH + x] ?? 0;
    return sum / WIDTH;
  };
  let top = 0;
  let bottom = 0;
  for (let y = 0; y < middle; y += 1) top += rowMean(y);
  for (let y = middle; y < HEIGHT; y += 1) bottom += rowMean(y);
  const halves = Math.abs(top / middle - bottom / (HEIGHT - middle)) / 255;
  let seam = 0;
  for (let y = middle - 4; y <= middle + 4; y += 1) {
    if (y <= 0 || y >= HEIGHT - 1) continue;
    seam = Math.max(seam, Math.abs(rowMean(y - 1) - rowMean(y + 1)) / 255);
  }
  return Math.min(1, halves + seam);
}

/** How busy the frame is. A gameplay frame with a HUD and subtitles has many
 * more edges than a face against a wall. */
function edges(luma: number[]): number {
  let total = 0;
  for (let y = 1; y < HEIGHT; y += 1)
    for (let x = 1; x < WIDTH; x += 1) {
      const here = luma[y * WIDTH + x] ?? 0;
      total += Math.abs(here - (luma[y * WIDTH + x - 1] ?? 0)) + Math.abs(here - (luma[(y - 1) * WIDTH + x] ?? 0));
    }
  return total / ((WIDTH - 1) * (HEIGHT - 1) * 2 * 255);
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
