import { exchangeYouTubeCode, youtubeOauthAuthorizeUrl } from "../../channels/youtube-oauth.js";
import { escapeHtml } from "../../foundation/html.js";
import { commandAllowed } from "../../foundation/http-auth.js";
import type { RouteModule } from "./context.js";

export const youtubeOauthRoutes: RouteModule = (app, { config, backendDb, studio }) => {
  app.get("/oauth/youtube/start", (c) => {
    try {
      if (!commandAllowed(c.req.raw, config)) throw new Error("Open this link from an authenticated Command Center");
      const locale = c.req.query("locale") === "en" ? "en" : "ru";
      return new Response(null, {
        status: 302,
        headers: { location: youtubeOauthAuthorizeUrl(config, locale), "cache-control": "no-store" },
      });
    } catch (error) {
      return page("YouTube connection link is invalid", String(error), 400);
    }
  });
  app.get("/oauth/youtube", async (c) => {
    try {
      const refused = c.req.query("error_description") ?? c.req.query("error");
      if (refused) throw new Error(`Google refused the authorization: ${refused}`);
      const code = c.req.query("code");
      const state = c.req.query("state");
      if (!code || !state) throw new Error("YouTube OAuth callback has no code or state");
      const { locale } = await exchangeYouTubeCode(config, backendDb, code, state);
      studio.channels.connect({ platform: "youtube", locale, provider: "native" });
      return page(`YouTube ${locale.toUpperCase()} connected`, "The channel is ready for publishing and comment collection.", 200);
    } catch (error) {
      return page("YouTube connection failed", String(error), 400);
    }
  });
};

function page(title: string, message: string, status: number): Response {
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><p><a href="/command-center?tab=studio">Return to Studio</a></p></main></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" } },
  );
}
