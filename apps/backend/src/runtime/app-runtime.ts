import { createBot } from "../bot.js";
import { type BackendDb, openBackendDb } from "../db/client.js";
import { type BackendConfig, loadConfig } from "../foundation/config.js";
import { configureLogging, log } from "../foundation/logger.js";
import { checkDataDirectoriesWritable, requiredDataDirectories } from "../foundation/runtime/data-dirs.js";
import { assertFfmpegAvailable, configureFfmpegConcurrency } from "../foundation/runtime/ffmpeg.js";
import type { ScheduledLoop } from "../foundation/scheduler.js";
import { startTelegramWorkers } from "../interfaces/telegram/worker.js";
import { createStudioServices, type StudioServices } from "../studio/services/index.js";
import { loadRuntimeConfig } from "./config.js";
import { startCoreWorkers } from "./workers.js";

export type AppRuntime = {
  config: BackendConfig;
  backendDb: BackendDb;
  studio: StudioServices;
  bot: ReturnType<typeof createBot>;
  loops: ScheduledLoop[];
};

let runtime: AppRuntime | undefined;
const FFMPEG_MAX_CONCURRENCY = 2;

/** Opens the database, builds the services and starts the workers, once per process. */
export function startRuntime(): AppRuntime {
  if (runtime) return runtime;
  const env = loadConfig(Bun.env);
  configureLogging(env.LOG_LEVEL);
  configureFfmpegConcurrency(FFMPEG_MAX_CONCURRENCY);
  // The database is opened before the configuration is complete, because the
  // Studio's own settings and its stored platform tokens live in it. Only
  // PIPELINE_DB is needed to get here.
  const backendDb = openBackendDb(env.PIPELINE_DB);
  const config = loadRuntimeConfig(Bun.env, backendDb);
  const studio = createStudioServices(backendDb, config);
  const bot = createBot(config, backendDb);
  const loops = config.NODE_ENV === "test" ? [] : [...startCoreWorkers(config, backendDb), ...startTelegramWorkers(config, backendDb, bot)];
  runtime = { config, backendDb, studio, bot, loops };
  if (!assertFfmpegAvailable()) log("warn", "ffmpeg is not available; video poster generation will fail until Docker/runtime installs it");
  reportUnwritableDataDirectories(config, backendDb);
  return runtime;
}

/** A directory a bind-mounted volume auto-vivified for is often owned by root,
 * silently blocking the unprivileged app user until a real upload or worker
 * cycle first touches it — hours or days after the deploy that broke it. Check
 * once at boot so a misconfigured mount is loud immediately, both in logs and
 * as an admin alert, instead of surfacing as a confusing EACCES mid-request. */
function reportUnwritableDataDirectories(config: BackendConfig, backendDb: BackendDb): void {
  const unwritable = checkDataDirectoriesWritable(requiredDataDirectories(config)).filter((check) => !check.writable);
  if (!unwritable.length) return;
  const summary = unwritable.map((check) => `${check.name} (${check.path}): ${check.error}`).join("; ");
  log("error", "one or more data directories are not writable by this process", { directories: unwritable });
  backendDb.events.record({
    ref: "runtime:data-dirs",
    type: "runtime.data_directory_unwritable",
    severity: "error",
    message: `Data directory not writable: ${summary}. Check bind-mount ownership on the host.`,
    details: { directories: unwritable },
    cooldownSeconds: 60 * 60,
  });
}

export async function stopRuntime(signal: string): Promise<void> {
  if (!runtime) return;
  log("info", "shutdown requested", { signal });
  await Promise.all(runtime.loops.map((loop) => loop.stop()));
  runtime.backendDb.close();
  runtime = undefined;
}
