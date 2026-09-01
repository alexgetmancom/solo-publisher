/** Canonical vertical-media recipes shared by the local and remote executors. */

// AAC packets can extend the muxed duration a few milliseconds past the
// requested cutoff. Keep enough margin for the finished MP4 itself to remain
// at or below the 59-second Story delivery contract.
export const STORY_MAX_DURATION_SECONDS = 58.9;
export const VERTICAL_ASPECT_RATIO = 9 / 16;
/** Within five percent of 9:16, preserve a plain contain render. */
export const VERTICAL_ASPECT_TOLERANCE = 0.05;

const VERTICAL_SCALE_FILTER =
  "scale=1080:1920:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black";
const VERTICAL_FOREGROUND_FILTER = "scale=1080:1920:force_original_aspect_ratio=decrease:force_divisible_by=2";
const VERTICAL_VIDEO_BACKGROUND_FILTER =
  "scale=540:960:force_original_aspect_ratio=increase:force_divisible_by=2,crop=540:960,boxblur=10:4,eq=brightness=-0.10:saturation=0.82,scale=1080:1920";
const VERTICAL_IMAGE_BACKGROUND_FILTER =
  "scale=1080:1920:force_original_aspect_ratio=increase:force_divisible_by=2,crop=1080:1920,boxblur=20:10,eq=brightness=-0.10:saturation=0.82";

export function needsVerticalBlur(width: number, height: number): boolean {
  if (!(width > 0 && height > 0)) return false;
  return Math.abs(width / height / VERTICAL_ASPECT_RATIO - 1) > VERTICAL_ASPECT_TOLERANCE;
}

/**
 * The vertical video graph, for whichever executor is going to encode it.
 *
 * `hardware` is the executor's own capability, not who called: a VAAPI encoder
 * needs the frames uploaded before the split, and a software one must never see
 * that upload. Everything before it -- the cadence, the blur, the overlay -- is
 * the recipe, and there is one of it.
 */
function verticalVideoFilter(duration: number | null, blur: boolean, splitOutputs: number, hardware: boolean): string {
  const trim = duration == null ? "" : `trim=duration=${duration},`;
  const labels = Array.from({ length: splitOutputs }, (_, index) => `[out${index}]`).join("");
  // Preserve source cadence for both site and Stories: do not turn a 24/30 FPS
  // input into duplicate frames, and do not discard real 60 FPS motion.
  const split = `${hardware ? "format=nv12,hwupload," : ""}split=${splitOutputs}${labels}`;
  if (!blur) return `[0:v:0]${trim}${VERTICAL_SCALE_FILTER},${split}`;
  return `[0:v:0]${trim}split=2[background-source][foreground-source];[background-source]${VERTICAL_VIDEO_BACKGROUND_FILTER}[background];[foreground-source]${VERTICAL_FOREGROUND_FILTER}[foreground];[background][foreground]overlay=(W-w)/2:(H-h)/2,${split}`;
}

function verticalImageFilter(blur: boolean): string {
  if (!blur) return VERTICAL_SCALE_FILTER;
  return `[0:v:0]split=2[background-source][foreground-source];[background-source]${VERTICAL_IMAGE_BACKGROUND_FILTER}[background];[foreground-source]${VERTICAL_FOREGROUND_FILTER}[foreground];[background][foreground]overlay=(W-w)/2:(H-h)/2`;
}

/** VAAPI rate control can overshoot on very short clips. 8.5 MiB leaves a real
 * margin below mtcute's 9.5 MiB upload boundary after MP4 overhead. Account for
 * the original (copied) audio plus container overhead. */
export function telegramVideoKbps(duration: number, audioBitrate: number): number {
  const targetBits = 8.5 * 1024 * 1024 * 8;
  return Math.max(150, Math.floor((targetBits / duration - audioBitrate - 24_000) / 1000));
}

/** The VAAPI init the remote executor puts in front of every encode. */
const VAAPI_DEVICE_ARGS = ["-init_hw_device", "vaapi=va:/dev/dri/renderD128", "-filter_hw_device", "va", "-y"];

/** The site and Story standard renders share one ladder; Telegram gets its own
 * ceiling and rides it flat, because the cap is the delivery limit rather than
 * headroom for a peak. */
const STANDARD_RATE = { kbps: 3150, maxKbps: 3300 };

/**
 * One encoded output off a filter-graph label. Every leg is this: the three
 * copies that used to spell it out drifted apart a keyframe interval at a time,
 * which is invisible until a platform rejects one of them.
 *
 * The encoder is the only difference between the two executors, so it is the
 * only thing this branches on: VAAPI receives frames already on the device,
 * libx264 needs the pixel format and a preset spelled out.
 */
function outputLeg(
  encoder: "h264_vaapi" | "libx264",
  label: string,
  rate: { kbps: number; maxKbps: number },
  gop: string | null,
  duration: number | null,
  output: string,
): string[] {
  return [
    "-map",
    label,
    "-map",
    "0:a?",
    "-c:v",
    encoder,
    ...(encoder === "libx264" ? ["-preset", "medium", "-pix_fmt", "yuv420p"] : []),
    "-b:v",
    `${rate.kbps}k`,
    "-maxrate",
    `${rate.maxKbps}k`,
    "-bufsize",
    `${rate.maxKbps * 2}k`,
    ...(gop ? ["-g", gop] : []),
    // Copied rather than re-encoded on both executors: telegramVideoKbps budgets
    // the video around the source audio's own bitrate, and an encoder that
    // decided its own would spend that budget without telling anyone.
    "-c:a",
    "copy",
    "-tag:v",
    "avc1",
    "-movflags",
    "+faststart",
    ...(duration == null ? [] : ["-t", String(duration)]),
    output,
  ];
}

/** The Story pair as the local executor makes it. Same graph, same two outputs
 * and same ladders as the remote one; software encoding is the whole delta. */
export function localStoryFfmpegArgs(
  input: string,
  standardOutput: string,
  telegramOutput: string,
  telegramKbps: number,
  blur: boolean,
): string[] {
  return [
    "-y",
    "-i",
    input,
    "-filter_complex",
    verticalVideoFilter(STORY_MAX_DURATION_SECONDS, blur, 2, false),
    ...outputLeg("libx264", "[out0]", STANDARD_RATE, "50", STORY_MAX_DURATION_SECONDS, standardOutput),
    ...outputLeg("libx264", "[out1]", { kbps: telegramKbps, maxKbps: telegramKbps }, "50", STORY_MAX_DURATION_SECONDS, telegramOutput),
  ];
}

export function remoteStoryFfmpegArgs(
  input: string,
  standardOutput: string,
  telegramOutput: string,
  telegramVideoKbps: number,
  blur: boolean,
): string[] {
  return [
    ...VAAPI_DEVICE_ARGS,
    "-i",
    input,
    "-filter_complex",
    verticalVideoFilter(STORY_MAX_DURATION_SECONDS, blur, 2, true),
    ...outputLeg("h264_vaapi", "[out0]", STANDARD_RATE, "50", STORY_MAX_DURATION_SECONDS, standardOutput),
    ...outputLeg(
      "h264_vaapi",
      "[out1]",
      { kbps: telegramVideoKbps, maxKbps: telegramVideoKbps },
      "50",
      STORY_MAX_DURATION_SECONDS,
      telegramOutput,
    ),
  ];
}

export function remoteSiteVideoFfmpegArgs(input: string, output: string, blur: boolean): string[] {
  return [
    ...VAAPI_DEVICE_ARGS,
    "-i",
    input,
    "-filter_complex",
    verticalVideoFilter(null, blur, 1, true),
    ...outputLeg("h264_vaapi", "[out0]", STANDARD_RATE, null, null, output),
  ];
}

export function verticalImageFfmpegArgs(input: string, output: string, blur: boolean): string[] {
  const filter = verticalImageFilter(blur);
  return ["-y", "-i", input, ...(blur ? ["-filter_complex", filter] : ["-vf", filter]), "-frames:v", "1", "-q:v", "2", output];
}
