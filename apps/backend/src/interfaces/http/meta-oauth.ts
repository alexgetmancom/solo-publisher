import { exchangeMetaCode, metaOauthAuthorizeUrl, metaOauthConnectUrl, verifyMetaOauthState } from "../../channels/meta-oauth.js";
import { META_PROVIDERS, type MetaOauthPlatform } from "../../channels/meta-providers.js";
import { installMetaToken } from "../../channels/meta-tokens.js";
import { escapeHtml } from "../../foundation/html.js";
import { commandAllowed } from "../../foundation/http-auth.js";
import type { RouteModule } from "./context.js";

export const metaOauthRoutes: RouteModule = (app, { config, backendDb, studio }) => {
  for (const platform of Object.keys(META_PROVIDERS) as MetaOauthPlatform[]) {
    app.get(`/oauth/${platform}/start`, (c) => {
      try {
        let state = c.req.query("state") ?? "";
        if (!state) {
          if (!commandAllowed(c.req.raw, config)) throw new Error("Open this link from an authenticated Command Center");
          const locale = c.req.query("locale");
          if (locale !== "ru" && locale !== "en") throw new Error("OAuth link has no valid locale");
          state = new URL(metaOauthConnectUrl(config, platform, locale)).searchParams.get("state") ?? "";
        }
        const parsed = verifyMetaOauthState(config, state);
        if (parsed.platform !== platform) throw new Error("OAuth link names a different platform");
        return new Response(null, {
          status: 302,
          headers: { location: metaOauthAuthorizeUrl(config, state), "cache-control": "no-store" },
        });
      } catch (error) {
        return oauthPage("Connection link is invalid", String(error), 400);
      }
    });

    app.get(`/oauth/${platform}`, async (c) => {
      try {
        const state = c.req.query("state") ?? "";
        const parsed = verifyMetaOauthState(config, state);
        if (parsed.platform !== platform) throw new Error("OAuth callback reached the wrong platform route");
        const refused = c.req.query("error_description") ?? c.req.query("error");
        if (refused) throw new Error(`${META_PROVIDERS[platform].label} refused the authorization: ${refused}`);
        const code = c.req.query("code");
        if (!code) throw new Error("OAuth callback has no code");
        const provider = META_PROVIDERS[platform];
        const identity = await exchangeMetaCode(config, platform, code);
        installMetaToken(config, backendDb, provider.tokenTarget(parsed.locale), identity.accessToken, identity.userId);
        studio.channels.connect(
          provider.registryRow(parsed.locale, identity.userId, identity.username ? `@${identity.username}` : identity.userId),
        );
        return oauthPage(
          `${provider.label} connected`,
          `${identity.username ? `@${identity.username}` : identity.userId} is ready for ${parsed.locale.toUpperCase()} publishing.`,
          200,
        );
      } catch (error) {
        return oauthPage(`${META_PROVIDERS[platform].label} connection failed`, String(error), 400);
      }
    });
  }
};

function oauthPage(title: string, message: string, status: number): Response {
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><p><a href="/command-center?tab=studio">Return to Studio</a></p></main></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" } },
  );
}
