import { describe, expect, it } from "bun:test";
import { frameFeatures } from "../src/analytics/collection/video-frames.js";
import { assertFfmpegAvailable } from "../src/foundation/runtime/ffmpeg.js";

/** A synthetic clip is enough: the measurements are arithmetic on pixels, and
 * a generated frame has a known answer where a real one has an opinion. */
async function clip(filter: string, path: string): Promise<string> {
  const child = Bun.spawn(["ffmpeg", "-y", "-f", "lavfi", "-i", filter, "-frames:v", "1", "-pix_fmt", "yuv420p", path], {
    stdout: "ignore",
    stderr: "ignore",
  });
  if ((await child.exited) !== 0) throw new Error("could not render the test clip");
  return path;
}

describe.if(assertFfmpegAvailable())("frame features", () => {
  it("tells a dark still frame from a bright busy one", async () => {
    const directory = process.env.TMPDIR ?? "/tmp";
    const dark = await clip("color=c=black:s=360x640", `${directory}/frame-dark.mp4`);
    const noisy = await clip("testsrc=s=360x640", `${directory}/frame-noisy.mp4`);

    const flat = await frameFeatures(dark, 0);
    const busy = await frameFeatures(noisy, 0);

    expect(flat.brightness).toBeLessThan(5);
    expect(flat.edgeDensity).toBeLessThan(1);
    expect(flat.shape).toBe("gameplay");
    // A test pattern is bright, saturated and full of edges — a HUD-heavy
    // gameplay frame looks far more like this than like a face on a wall.
    expect(busy.brightness).toBeGreaterThan(flat.brightness);
    expect(busy.edgeDensity).toBeGreaterThan(flat.edgeDensity);
  });

  it("sees a seam between two stacked halves", async () => {
    const directory = process.env.TMPDIR ?? "/tmp";
    // White over black: the split screen this Studio actually publishes.
    const stacked = await clip("color=c=white:s=360x320,pad=360:640:0:0:black", `${directory}/frame-split.mp4`);
    const features = await frameFeatures(stacked, 0);
    expect(features.splitScore).toBeGreaterThan(25);
    expect(features.shape).toBe("split");
  });
});
