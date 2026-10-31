import { Hono, type MiddlewareHandler } from "hono";
import type { BackendDb } from "./db/client.js";
import type { BackendConfig } from "./foundation/config.js";
import { text } from "./foundation/http-response.js";
import { discoveryRoutes } from "./interfaces/http/discovery.js";
import { healthRoutes } from "./interfaces/http/health.js";
import { metaOauthRoutes } from "./interfaces/http/meta-oauth.js";
import { publicSiteRoutes } from "./interfaces/http/public-site.js";
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
  };
  // Trailing slashes have always matched; clients and bookmarks rely on it.
  const app = new Hono({ strict: false });

  // Operator surfaces. They authenticate, but a crawler that indexes the login
  // screen turns a private page into a search result, and a shared cache that
  // kept one would serve one operator's screen to the next caller.
  app.use("/oauth/*", unindexed);
  app.use("/stats", unindexed);
  app.use("/stats/*", unindexed);

  healthRoutes(app, deps);
  metaOauthRoutes(app, deps);
  xOauthRoutes(app, deps);
  youtubeOauthRoutes(app, deps);
  studioRoutes(app, deps);
  publicSiteRoutes(app, deps);
  discoveryRoutes(app, deps);
  app.notFound(() => text("not found\n", 404));
  return app;
}

const unindexed: MiddlewareHandler = async (c, next) => {
  await next();
  c.res.headers.set("X-Robots-Tag", "noindex, nofollow");
  c.res.headers.set("Cache-Control", "no-store");
};
