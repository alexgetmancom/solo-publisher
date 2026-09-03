import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { type BotRunner, startBotRunner } from "../backend/src/bot/runner.js";
import { log } from "../backend/src/foundation/logger.js";
import { startRuntime, stopRuntime } from "./src/server/runtime.js";

const runtime = startRuntime();
let botRunner: BotRunner | undefined;
if (runtime.bot) {
  await runtime.bot.init();
  botRunner = startBotRunner(runtime.bot);
}
const distDirectory = path.resolve(process.env.ASTRO_DIST_DIR ?? "/app/dist");
const entry = process.env.ASTRO_DIST_ENTRY ?? path.join(distDirectory, "server/entry.mjs");
const { handler } = await import(entry);

const CLIENT_DIR = path.join(distDirectory, "client");

const MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".json": "application/json; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

const server = createServer((req, res) => {
  const urlPath = req.url?.split("?")[0] || "/";
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(urlPath);
  } catch {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Bad request\n");
    return;
  }
  // A percent-encoded null byte survives decoding and reaches fs.stat, which
  // rejects it by throwing from the request handler and taking the process
  // down. Vulnerability scanners send these by the dozen.
  if (decodedPath.includes("\0")) {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Bad request\n");
    return;
  }
  const safePath = path.normalize(decodedPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(CLIENT_DIR, safePath);
  // normalize() already collapses ".." against the leading slash, but the
  // containment invariant is what actually keeps this safe — assert it rather
  // than leaving it implicit in a regex.
  if (filePath !== CLIENT_DIR && !filePath.startsWith(CLIENT_DIR + path.sep)) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Forbidden\n");
    return;
  }

  // Serve static client assets directly if they exist on disk. Every SSR route
  // reaches this stat as a guaranteed miss, so it must not block the loop.
  fs.stat(filePath, (error, stat) => {
    if (error || !stat.isFile()) {
      handler(req, res);
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      "Cache-Control":
        safePath.startsWith("/_astro/") || safePath.startsWith("/generated/")
          ? "public, max-age=31536000, immutable"
          : "public, max-age=3600",
    });
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(runtime.config.PORT, runtime.config.BIND_HOST, () => {
  log("info", "Astro SSR listening", { hostname: runtime.config.BIND_HOST, port: runtime.config.PORT });
});

async function shutdown(signal: string): Promise<void> {
  server.close(async () => {
    if (botRunner?.isRunning()) await botRunner.stop();
    await stopRuntime(signal);
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
