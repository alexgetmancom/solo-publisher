import { afterAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { rangedFileResponse } from "./media-file";

const BODY = "0123456789";
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "media-file-test-"));
const filePath = path.join(directory, "clip.bin");
fs.writeFileSync(filePath, BODY);
afterAll(() => fs.rmSync(directory, { recursive: true, force: true }));

function respond(range: string): Response {
  const request = new Request("https://example.test/media/clip.mp4", { headers: { range } });
  return rangedFileResponse(Bun.file(filePath), request, { headers: { "Content-Type": "text/plain" }, headOnly: false });
}

describe("ranged file responses", () => {
  it("answers a suffix range from the end of the file", async () => {
    const response = respond("bytes=-4");
    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe(`bytes 6-9/${BODY.length}`);
    expect(await response.text()).toBe("6789");
  });

  it("clamps a suffix range longer than the file to the whole file", async () => {
    const response = respond("bytes=-99");
    expect(response.headers.get("Content-Range")).toBe(`bytes 0-9/${BODY.length}`);
    expect(await response.text()).toBe(BODY);
  });

  it("rejects a suffix range that names no bytes", () => {
    expect(respond("bytes=-0").status).toBe(416);
    expect(respond("bytes=-").status).toBe(416);
  });

  it("still answers an ordinary range from the requested offset", async () => {
    const response = respond("bytes=2-4");
    expect(response.status).toBe(206);
    expect(await response.text()).toBe("234");
  });
});
