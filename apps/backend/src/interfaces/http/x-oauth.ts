import { exchangeXCode, xOauthAuthorizeUrl } from "../../channels/x-oauth.js";
import { escapeHtml } from "../../foundation/html.js";
import { commandAllowed } from "../../foundation/http-auth.js";
import type { RouteModule } from "./context.js";

export const xOauthRoutes: RouteModule = (app, { config, backendDb, studio }) => {
  app.get("/oauth/x/start", (c) => {
    try {
      if (!commandAllowed(c.req.raw, config)) throw new Error("Open an authorized Studio connection link");
      return new Response(null, { status: 302, headers: { location: xOauthAuthorizeUrl(config), "cache-control": "no-store" } });
    } catch (error) {
      return page("X connection link is invalid", String(error), 400);
    }
  });
  app.get("/oauth/x", async (c) => {
    try {
      const refused = c.req.query("error_description") ?? c.req.query("error");
      if (refused) throw new Error(`X refused the authorization: ${refused}`);
      const code = c.req.query("code");
      const state = c.req.query("state");
      if (!code || !state) throw new Error("X OAuth callback has no code or state");
      const identity = await exchangeXCode(config, backendDb, code, state);
      studio.channels.connect({
        platform: "x",
        locale: "en",
        provider: "native",
        providerAccountId: identity.id,
        targetId: "x",
        label: `X EN · ${identity.username ? `@${identity.username}` : identity.id}`,
      });
      return page("X connected", `${identity.username ? `@${identity.username}` : identity.id} is ready for publishing.`, 200);
    } catch (error) {
      return page("X connection failed", String(error), 400);
    }
  });
};

function page(title: string, message: string, status: number): Response {
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><p>You can close this page and return to the publishing bot.</p></main></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" } },
  );
}
