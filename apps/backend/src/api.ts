import { Hono } from "hono";
import type { BackendDb } from "./db/client.js";
import { engagementService } from "./engagement/service.js";
import type { BackendConfig } from "./foundation/config.js";
import { text } from "./foundation/http-response.js";
import { commandCenterRoutes } from "./interfaces/http/command-center.js";
import { engagementRoutes } from "./interfaces/http/engagement.js";
import { healthRoutes } from "./interfaces/http/health.js";
import { metaOauthRoutes } from "./interfaces/http/meta-oauth.js";
import { studioRoutes } from "./interfaces/http/studio.js";
import { xOauthRoutes } from "./interfaces/http/x-oauth.js";
import { youtubeOauthRoutes } from "./interfaces/http/youtube-oauth.js";
import { createStudioServices, type StudioServices } from "./studio/services/index.js";

type ApiContext = {
  config: BackendConfig;
  backendDb: BackendDb;
  studio?: StudioServices;
};
const apps = new WeakMap<ApiContext, Hono>();

/** One Hono app per runtime context (config/backendDb/bot identity), built once
 * and reused for every request — routes and the services they close over don't
 * change for the life of that context. */
export function createApiHandler(context: ApiContext) {
  const app = apps.get(context) ?? buildApp(context);
  apps.set(context, app);
  return async (request: Request): Promise<Response> => app.fetch(request);
}

/** The composition root for HTTP: it builds the services once, hands them to
 * each route module, and owns nothing else. Handlers live under
 * interfaces/http/ (and interfaces/telegram/ for the webhook, which is the only
 * one that touches grammy); response and auth helpers live in foundation/. */
function buildApp({ config, backendDb, studio: providedStudio }: ApiContext): Hono {
  const studio = providedStudio ?? createStudioServices(backendDb, config);
  const deps = {
    config,
    backendDb,
    studio,
    engagement: engagementService(backendDb, config),
  };
  // Trailing slashes reached this dispatcher un-normalized under the old Astro
  // catch-all route (`/api/${route}`.replace(/\/$/, "")); keep matching them.
  const app = new Hono({ strict: false });

  healthRoutes(app, deps);
  metaOauthRoutes(app, deps);
  xOauthRoutes(app, deps);
  youtubeOauthRoutes(app, deps);
  commandCenterRoutes(app, deps);
  engagementRoutes(app, deps);
  studioRoutes(app, deps);
  app.notFound(() => text("not found\n", 404));
  return app;
}
