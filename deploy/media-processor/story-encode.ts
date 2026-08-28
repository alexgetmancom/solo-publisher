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

function verticalVideoFilter(duration: number | null, blur: boolean, splitOutputs: number): string {
  const trim = duration == null ? "" : `trim=duration=${duration},`;
  // Preserve source cadence for both site and Stories: do not turn a 24/30 FPS
  // input into duplicate frames, and do not discard real 60 FPS motion.
  if (!blur)
    return `[0:v:0]${trim}${VERTICAL_SCALE_FILTER},format=nv12,hwupload,split=${splitOutputs}${Array.from({ length: splitOutputs }, (_, i) => `[out${i}]`).join("")}`;
  return `[0:v:0]${trim}split=2[background-source][foreground-source];[background-source]${VERTICAL_VIDEO_BACKGROUND_FILTER}[background];[foreground-source]${VERTICAL_FOREGROUND_FILTER}[foreground];[background][foreground]overlay=(W-w)/2:(H-h)/2,format=nv12,hwupload,split=${splitOutputs}${Array.from({ length: splitOutputs }, (_, i) => `[out${i}]`).join("")}`;
}

function verticalImageFilter(blur: boolean): string {
  if (!blur) return VERTICAL_SCALE_FILTER;
  return `[0:v:0]split=2[background-source][foreground-source];[background-source]${VERTICAL_IMAGE_BACKGROUND_FILTER}[background];[foreground-source]${VERTICAL_FOREGROUND_FILTER}[foreground];[background][foreground]overlay=(W-w)/2:(H-h)/2`;
}

/** Software (no VAAPI) counterpart of verticalVideoFilter, for the local executor. */
function verticalSoftwareVideoFilter(blur: boolean): string {
  if (!blur) return VERTICAL_SCALE_FILTER;
  return `[0:v:0]split=2[background-source][foreground-source];[background-source]${VERTICAL_VIDEO_BACKGROUND_FILTER}[background];[foreground-source]${VERTICAL_FOREGROUND_FILTER}[foreground];[background][foreground]overlay=(W-w)/2:(H-h)/2[out0]`;
}

export function storyFfmpegArgs(input: string, output: string, kind: "video" | "image", blur = false): string[] {
  if (kind === "image") {
    const filter = verticalImageFilter(blur);
    return ["-y", "-i", input, ...(blur ? ["-filter_complex", filter] : ["-vf", filter]), "-frames:v", "1", "-q:v", "2", output];
  }
  // A blurred backdrop needs filter_complex (two branches out of one input), so
  // the video mapping changes with it: the labeled overlay output instead of
  // the raw stream. Leaving `blur` unhandled here silently produced a
  // letterboxed render on the local executor while the remote one blurred.
  const filter = verticalSoftwareVideoFilter(blur);
  return [
    "-y",
    "-i",
    input,
    "-t",
    String(STORY_MAX_DURATION_SECONDS),
    ...(blur ? ["-filter_complex", filter] : ["-vf", filter]),
    "-map",
    blur ? "[out0]" : "0:v:0",
    "-map",
    "0:a?",
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-b:v",
    "3150k",
    "-maxrate",
    "3300k",
    "-bufsize",
    "6600k",
    "-g",
    "50",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "320k",
    "-ar",
    "48000",
    "-ac",
    "2",
    "-tag:v",
    "avc1",
    "-movflags",
    "+faststart",
    output,
  ];
}

/** The VAAPI init the remote executor puts in front of every encode. */
const VAAPI_DEVICE_ARGS = ["-init_hw_device", "vaapi=va:/dev/dri/renderD128", "-filter_hw_device", "va", "-y"];

/** The site and Story standard renders share one ladder; Telegram gets its own
 * ceiling and rides it flat, because the cap is the delivery limit rather than
 * headroom for a peak. */
const STANDARD_RATE = { kbps: 3150, maxKbps: 3300 };

/**
 * One encoded output off a filter-graph label. Every remote leg is this: the
 * three copies that used to spell it out drifted apart a keyframe interval at a
 * time, which is invisible until a platform rejects one of them.
 */
function vaapiOutputLeg(
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
    "h264_vaapi",
    "-b:v",
    `${rate.kbps}k`,
    "-maxrate",
    `${rate.maxKbps}k`,
    "-bufsize",
    `${rate.maxKbps * 2}k`,
    ...(gop ? ["-g", gop] : []),
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
    verticalVideoFilter(STORY_MAX_DURATION_SECONDS, blur, 2),
    ...vaapiOutputLeg("[out0]", STANDARD_RATE, "50", STORY_MAX_DURATION_SECONDS, standardOutput),
    ...vaapiOutputLeg("[out1]", { kbps: telegramVideoKbps, maxKbps: telegramVideoKbps }, "50", STORY_MAX_DURATION_SECONDS, telegramOutput),
  ];
}

export function remoteSiteVideoFfmpegArgs(input: string, output: string, blur: boolean): string[] {
  return [
    ...VAAPI_DEVICE_ARGS,
    "-i",
    input,
    "-filter_complex",
    verticalVideoFilter(null, blur, 1),
    ...vaapiOutputLeg("[out0]", STANDARD_RATE, null, null, output),
  ];
}

export function verticalImageFfmpegArgs(input: string, output: string, blur: boolean): string[] {
  const filter = verticalImageFilter(blur);
  return ["-y", "-i", input, ...(blur ? ["-filter_complex", filter] : ["-vf", filter]), "-frames:v", "1", "-q:v", "2", output];
}
