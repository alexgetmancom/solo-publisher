import pLimit from "p-limit";

let maxConcurrency = 2;
let limiter = pLimit(maxConcurrency);

export function assertFfmpegAvailable(): boolean {
  return Bun.spawnSync(["ffmpeg", "-version"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
}

export function configureFfmpegConcurrency(value: number): void {
  maxConcurrency = Math.max(1, Math.min(2, Math.floor(value)));
  limiter = pLimit(maxConcurrency);
}

export function ffmpegMaxConcurrency(): number {
  return maxConcurrency;
}

export async function runFfmpeg(args: string[], timeoutSeconds = 600): Promise<void> {
  await limiter(async () => {
    const child = Bun.spawn(["ffmpeg", ...args], { stdout: "ignore", stderr: "pipe" });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutSeconds * 1000);
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    clearTimeout(timer);
    if (timedOut) throw new Error(`media_processing_timeout: ffmpeg exceeded ${timeoutSeconds}s`);
    if (exitCode !== 0) throw new Error(formatFfmpegFailure(exitCode, stderr));
  });
}

/** Runs ffmpeg and returns what it wrote to stdout.
 *
 * Frame inspection wants pixels, not a file: writing a PNG to disk only to
 * read and delete it costs two syscalls and a temp path per frame, and the
 * frames here are a few kilobytes of raw RGB. */
export async function runFfmpegCapture(args: string[], timeoutSeconds = 120): Promise<Uint8Array> {
  return limiter(async () => {
    const child = Bun.spawn(["ffmpeg", ...args], { stdout: "pipe", stderr: "pipe" });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutSeconds * 1000);
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).arrayBuffer(),
      new Response(child.stderr).text(),
    ]);
    clearTimeout(timer);
    if (timedOut) throw new Error(`media_processing_timeout: ffmpeg exceeded ${timeoutSeconds}s`);
    if (exitCode !== 0) throw new Error(formatFfmpegFailure(exitCode, stderr));
    return new Uint8Array(stdout);
  });
}

/** Shared by every ffprobe caller: a stuck or hostile input must not hang the
 * request/job that triggered inspection, and a malformed response must not
 * surface as an unrelated JSON.parse crash. */
async function runFfprobe<T = unknown>(args: string[], timeoutSeconds = 30): Promise<T> {
  const child = Bun.spawn(["ffprobe", ...args], { stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutSeconds * 1000);
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  clearTimeout(timer);
  if (timedOut) throw new Error(`media_probe_timeout: ffprobe exceeded ${timeoutSeconds}s`);
  if (exitCode !== 0)
    throw new Error(`media_probe_failed: ffprobe exit ${exitCode}: ${stderr.trim().slice(-800) || "no diagnostic output"}`);
  try {
    return JSON.parse(stdout || "{}") as T;
  } catch {
    throw new Error("media_probe_failed: ffprobe returned invalid JSON");
  }
}

export type MediaMetadata = {
  width: number;
  height: number;
  durationSeconds: number;
  videoCodec: string;
  audioCodec: string | null;
  fps: number;
  audioBitrate: number | null;
};

/** Canonical ffprobe projection for every video workflow. Callers decide
 * whether a probe failure is fatal or whether transport metadata is enough. */
export async function probeMediaMetadata(filePath: string, timeoutSeconds = 30): Promise<MediaMetadata> {
  const data = await runFfprobe<{
    format?: { duration?: string };
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      width?: number;
      height?: number;
      duration?: string;
      avg_frame_rate?: string;
      bit_rate?: string;
    }>;
  }>(
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration:stream=codec_type,codec_name,width,height,duration,avg_frame_rate,bit_rate",
      "-of",
      "json",
      filePath,
    ],
    timeoutSeconds,
  );
  const video = data.streams?.find((stream) => stream.codec_type === "video");
  const audio = data.streams?.find((stream) => stream.codec_type === "audio");
  if (!video?.width || !video.height) throw new Error("media_probe_failed: ffprobe did not find a video stream");
  const [numerator = 0, denominator = 1] = (video.avg_frame_rate ?? "0/1").split("/").map(Number);
  const audioBitrate = Number(audio?.bit_rate);
  return {
    width: Number(video.width),
    height: Number(video.height),
    durationSeconds: Math.max(0, Number(data.format?.duration ?? video.duration ?? 0)),
    videoCodec: video.codec_name ?? "video",
    audioCodec: audio?.codec_name ?? null,
    fps: denominator ? numerator / denominator : 0,
    audioBitrate: Number.isFinite(audioBitrate) && audioBitrate > 0 ? audioBitrate : null,
  };
}

/** Keep an actionable terminal reason instead of persisting megabytes of ffmpeg
 * progress frames. Exit 137 is the Linux OOM-kill convention. */
export function formatFfmpegFailure(exitCode: number, stderr: string): string {
  const meaningful = stderr
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^frame=\s*\d+\s+fps=/.test(line))
    .slice(-6)
    .join(" · ");
  const reason = exitCode === 137 ? "process was killed (likely out of memory)" : meaningful || "no diagnostic output";
  return `media_processing_failed: ffmpeg exit ${exitCode}: ${reason}`.slice(0, 1200);
}
