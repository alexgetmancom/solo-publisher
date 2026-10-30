import { createApiHandler } from "../api.js";
import { type BotRunner, startBotRunner } from "../bot/runner.js";
import { STUDIO_MEDIA_MAX_BYTES } from "../content/assets.js";
import { log } from "../foundation/logger.js";
import { startRuntime, stopRuntime } from "./app-runtime.js";

/** The Studio process: database, workers, the bot, and its HTTP surface. The
 * public site is a separate service that reads `/api/public/site` from here. */

const runtime = startRuntime();
let botRunner: BotRunner | undefined;
if (runtime.bot) {
  await runtime.bot.init();
  botRunner = startBotRunner(runtime.bot);
}

const handle = createApiHandler(runtime);

const server = Bun.serve({
  port: runtime.config.PORT,
  hostname: runtime.config.BIND_HOST,
  // A video upload is one body of up to a gigabyte; Bun's default cap is 128 MB.
  maxRequestBodySize: STUDIO_MEDIA_MAX_BYTES + 1024 * 1024,
  // The MCP stream pings every 30 seconds and a slow upload can pause; Bun's
  // default closes a connection after 10 idle seconds. 255 is its maximum.
  idleTimeout: 255,
  async fetch(request) {
    // A route that throws must answer, not take the process with it.
    try {
      return await handle(request);
    } catch (reason) {
      log("error", "request handler failed", { error: String(reason) });
      return new Response("Internal error\n", { status: 500, headers: { "content-type": "text/plain; charset=utf-8" } });
    }
  },
});

log("info", "studio listening", { hostname: server.hostname, port: server.port });

async function shutdown(signal: string): Promise<void> {
  setTimeout(() => process.exit(1), 10_000).unref();
  await server.stop();
  if (botRunner?.isRunning()) await botRunner.stop();
  await stopRuntime(signal);
  process.exit(0);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
