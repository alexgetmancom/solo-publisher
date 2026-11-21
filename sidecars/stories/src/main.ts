import { createStoryClient, storyCredentials } from "./client.js";
import { type SidecarOptions, serve } from "./server.js";

/** Same line shape as the Studio's logger: one JSON object per line. */
const log: SidecarOptions["log"] = (level, message, details) => {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, message, ...(details ? { details } : {}) });
  if (level === "error") console.error(line);
  else console.log(line);
};

function settings(env: Record<string, string | undefined>): { options: SidecarOptions; hostname: string; port: number } {
  const token = env.STORIES_SIDECAR_TOKEN?.trim() ?? "";
  if (token.length < 32) throw new Error("STORIES_SIDECAR_TOKEN must be set (at least 32 characters)");
  const port = Number(env.STORIES_SIDECAR_PORT?.trim() || 8790);
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) throw new Error("STORIES_SIDECAR_PORT must be a TCP port");
  const hostname = env.STORIES_SIDECAR_HOST?.trim() || "127.0.0.1";
  return { options: { token, credentials: storyCredentials(env), createClient: createStoryClient, log }, hostname, port };
}

// mtcute loads its WASM from the working directory once bundled, and the
// bundle carries it beside this file.
process.chdir(import.meta.dir);

try {
  const { options, hostname, port } = settings(process.env);
  const server = serve(options, hostname, port);
  log("info", "stories sidecar listening", { hostname, port, credentials: options.credentials !== null });
  for (const signal of ["SIGTERM", "SIGINT"] as const)
    process.on(signal, () => {
      // Lets a Story in flight finish; the container's stop timeout bounds it.
      void server.stop().then(() => process.exit(0));
    });
} catch (error) {
  log("error", "stories sidecar could not start", { error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
}
