import { runFfmpegCapture } from "../foundation/runtime/ffmpeg.js";

const BACKGROUND_AUDIO_FLOOR_DB = -55;

/** Detects the quiet floor that distinguishes a voice/game-only track from a
 * track carrying a persistent background bed. A failed optional probe stays
 * quiet so an upload is never rejected because of this advisory check. */
export async function backgroundMusicLikelyMissing(source: string, audioCodec: string | null): Promise<boolean> {
  if (!audioCodec) return true;
  try {
    const output = await runFfmpegCapture([
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      source,
      "-map",
      "0:a:0",
      "-af",
      "astats=metadata=1:reset=0,ametadata=print:file=-",
      "-f",
      "null",
      "-",
    ]);
    const text = new TextDecoder().decode(output);
    const rmsTrough = lastOverallMetric(text, "RMS_trough");
    const noiseFloor = lastOverallMetric(text, "Noise_floor");
    return rmsTrough != null && noiseFloor != null && rmsTrough < BACKGROUND_AUDIO_FLOOR_DB && noiseFloor < BACKGROUND_AUDIO_FLOOR_DB;
  } catch {
    return false;
  }
}

function lastOverallMetric(output: string, metric: string): number | null {
  const matches = [...output.matchAll(new RegExp(`lavfi\\.astats\\.Overall\\.${metric}=(-?\\d+(?:\\.\\d+)?)`, "gu"))];
  const value = matches.at(-1)?.[1];
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
