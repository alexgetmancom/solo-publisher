import type { Hono } from "hono";
import type { BackendDb } from "../../db/client.js";
import type { BackendConfig } from "../../foundation/config.js";
import type { StudioServices } from "../../studio/services/index.js";

/** What a route module is handed. Services are built once by the composition
 * root (api.ts) and shared, so registering a route never opens its own
 * connection or re-derives a service from config. */
type HttpDeps = {
  config: BackendConfig;
  backendDb: BackendDb;
  studio: StudioServices;
};

/** Every route module exports one of these. It registers its own paths on the
 * shared app and returns nothing: the app stays the single router, so path
 * conflicts surface at boot rather than as a silently shadowed handler. */
export type RouteModule = (app: Hono, deps: HttpDeps) => void;
