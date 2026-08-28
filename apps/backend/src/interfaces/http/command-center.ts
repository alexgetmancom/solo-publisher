import { DIRECT_CONNECT_TARGET_IDS, type TargetId } from "../../botTargets.js";
import type { ZernioConnectionKey } from "../../channels/zernio-connections.js";
import { allowPublicRequest } from "../../engagement/rate-limit.js";
import { escapeHtml } from "../../foundation/html.js";
import { commandAllowed, sameOriginCommandLogin } from "../../foundation/http-auth.js";
import { html, json, loginRedirect, queryTokenRedirect, text } from "../../foundation/http-response.js";
import { parseStudioLocale } from "../../foundation/locale.js";
import { measureMemorySync } from "../../observability/memory.js";
import { trackUsageSync } from "../../observability/usage.js";
import { commandCenterFingerprint } from "../../operations/command-center.js";
import {
  invalidateDashboardRenderCache,
  renderCommandCenterLogin,
  renderDashboard,
  renderDashboardPublicationDetails,
} from "../web/dashboard.js";
import type { RouteModule } from "./context.js";

/** Enough for a mistyped token on a phone, far too few to search a secret. */
const LOGIN_ATTEMPT_LIMIT = 10;
const LOGIN_ATTEMPT_WINDOW_SECONDS = 300;

export const commandCenterRoutes: RouteModule = (app, { config, backendDb, studio, engagement }) => {
  app.get("/command-center", (c) => {
    const request = c.req.raw;
    const url = new URL(request.url);
    const queryToken = url.searchParams.get("token");
    if (queryToken && commandAllowed(request, config)) return queryTokenRedirect(url, "command_token", queryToken);
    if (!commandAllowed(request, config)) return html(renderCommandCenterLogin(parseStudioLocale(url.searchParams.get("locale"))));
    return html(
      measureMemorySync("command_center.dashboard.render", dashboardMemoryContext(url), () =>
        trackUsageSync(backendDb, "command_center.dashboard.render", () =>
          renderDashboard(
            config,
            backendDb,
            Number(url.searchParams.get("week_offset") ?? 0) || 0,
            url.searchParams.get("tab") ?? undefined,
            url.searchParams.get("locale") ?? undefined,
            url.searchParams.get("panel") ?? undefined,
            url.searchParams.get("period") ?? undefined,
            url.searchParams.get("view") ?? undefined,
            url.searchParams.get("metric") ?? undefined,
            url.searchParams.get("video_view") ?? undefined,
          ),
        ),
      ),
    );
  });

  app.post("/command-center", async (c) => {
    const request = c.req.raw;
    if (!sameOriginCommandLogin(request, config)) return text("forbidden\n", 403);
    const form = await request.formData().catch(() => new FormData());
    const token = form.get("token");
    // The token is the only thing guarding the dashboard from the open
    // internet, and it is submitted here in a loop-friendly form post, so
    // guessing has to cost wall-clock time. Only a *failed* attempt spends
    // budget: behind a proxy that does not set the trusted client header every
    // caller hashes to one key, and counting successes there would let a
    // stranger's guessing lock the owner out of their own dashboard.
    if (typeof token !== "string" || !commandAllowed(request, config, token)) {
      const attempt = allowPublicRequest(
        `command-login:${engagement.clientKey(request)}`,
        LOGIN_ATTEMPT_LIMIT,
        LOGIN_ATTEMPT_WINDOW_SECONDS,
      );
      if (!attempt.allowed)
        return new Response("too many attempts\n", {
          status: 429,
          headers: { "content-type": "text/plain; charset=utf-8", "retry-after": String(attempt.retryAfter) },
        });
      return html(renderCommandCenterLogin(parseStudioLocale(form.get("locale")), true));
    }
    return loginRedirect("/command-center", "command_token", token);
  });

  app.get("/api/command-center/fingerprint", (c) =>
    commandAllowed(c.req.raw, config)
      ? json(trackUsageSync(backendDb, "command_center.fingerprint.poll", () => commandCenterFingerprint(backendDb)))
      : json({ detail: "forbidden" }, 403),
  );

  app.get("/api/command-center/publication-details", (c) => {
    if (!commandAllowed(c.req.raw, config)) return json({ detail: "forbidden" }, 403);
    const requestedPeriod = Number(c.req.query("period") ?? 1);
    const periodDays = [1, 7, 30, 90, 365].includes(requestedPeriod) ? requestedPeriod : 1;
    const weekOffset = Number(c.req.query("week_offset") ?? 0) || 0;
    const offset = Math.max(0, Number(c.req.query("offset") ?? 0) || 0);
    const limit = Math.max(1, Number(c.req.query("limit") ?? 10) || 10);
    return json(
      measureMemorySync(
        "command_center.dashboard.publication_details",
        { route: "/api/command-center/publication-details", period: periodDays, weekOffset, offset, limit },
        () =>
          trackUsageSync(backendDb, "command_center.publication_details.render", () =>
            renderDashboardPublicationDetails(
              config,
              backendDb,
              weekOffset,
              periodDays,
              c.req.query("view") ?? undefined,
              offset,
              limit,
              c.req.query("track") ?? undefined,
              c.req.query("video_view") ?? undefined,
              c.req.query("locale") ?? undefined,
            ),
          ),
      ),
    );
  });

  app.post("/command-center/channels/connect", async (c) => {
    const request = c.req.raw;
    if (!commandAllowed(request, config) || !sameOriginCommandLogin(request, config)) return text("forbidden\n", 403);
    const form = await request.formData().catch(() => new FormData());
    try {
      const provider = form.get("provider");
      const accountId = form.get("account_id");
      const zernioKey = form.get("connection");
      const zernioLocale = form.get("locale");
      if (
        provider === "zernio" &&
        typeof accountId === "string" &&
        typeof zernioKey === "string" &&
        (zernioLocale === "ru" || zernioLocale === "en")
      ) {
        await studio.channels.connectZernio(accountId, zernioLocale, zernioKey as ZernioConnectionKey);
        invalidateDashboardRenderCache(backendDb);
        return new Response(null, { status: 303, headers: { location: "/command-center?tab=studio" } });
      }
      const target = form.get("target");
      if (typeof target === "string" && (DIRECT_CONNECT_TARGET_IDS as readonly string[]).includes(target)) {
        studio.channels.connectTarget(target as TargetId);
        invalidateDashboardRenderCache(backendDb);
        return new Response(null, { status: 303, headers: { location: "/command-center?tab=studio" } });
      }
      const platform = form.get("platform");
      const locale = form.get("locale");
      if (platform !== "youtube" || (locale !== "ru" && locale !== "en")) throw new Error("Unknown channel connection");
      const started = await studio.channels.startConnect("youtube", locale);
      if (started.kind !== "device") throw new Error("YouTube did not return a device code");
      return connectionPage(
        "YouTube authorization",
        `Open ${started.verificationUrl}, enter the code ${started.userCode}, and approve access within ${Math.round(started.expiresInSeconds / 60)} minutes. The channel will connect itself.`,
        200,
      );
    } catch (error) {
      return connectionPage("Channel connection failed", error instanceof Error ? error.message : String(error), 400);
    }
  });

  app.post("/command-center/channels/disable", async (c) => {
    const request = c.req.raw;
    if (!commandAllowed(request, config) || !sameOriginCommandLogin(request, config)) return text("forbidden\n", 403);
    const form = await request.formData().catch(() => new FormData());
    const channel = form.get("channel");
    if (typeof channel !== "string" || !channel) return text("invalid channel\n", 400);
    try {
      studio.channels.disable(channel);
      invalidateDashboardRenderCache(backendDb);
      return new Response(null, { status: 303, headers: { location: "/command-center?tab=studio" } });
    } catch (error) {
      return connectionPage("Channel disable failed", error instanceof Error ? error.message : String(error), 400);
    }
  });

  app.get("/command-center/channels/zernio", async (c) => {
    if (!commandAllowed(c.req.raw, config)) return text("forbidden\n", 403);
    const locale = c.req.query("locale");
    if (locale !== "ru" && locale !== "en") return connectionPage("Zernio connection failed", "Choose RU or EN.", 400);
    try {
      const options = await studio.channels.discoverZernioConnections(locale);
      const forms = options.length
        ? options
            .map(
              (option) =>
                `<form method="post" action="/command-center/channels/connect"><input type="hidden" name="provider" value="zernio"><input type="hidden" name="account_id" value="${escapeHtml(option.accountId)}"><input type="hidden" name="connection" value="${option.key}"><input type="hidden" name="locale" value="${locale}"><button type="submit">${escapeHtml(option.label)}</button></form>`,
            )
            .join("")
        : "<p>No publishable Zernio accounts found.</p>";
      return connectionHtmlPage("Connect a Zernio route", forms, 200);
    } catch (error) {
      return connectionPage("Zernio connection failed", error instanceof Error ? error.message : String(error), 400);
    }
  });
};

function connectionPage(title: string, message: string, status: number): Response {
  return connectionHtmlPage(title, `<p>${escapeHtml(message)}</p>`, status);
}

function connectionHtmlPage(title: string, body: string, status: number): Response {
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title><body><main><h1>${escapeHtml(title)}</h1>${body}<p><a href="/command-center?tab=studio">Return to Studio</a></p></main></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" } },
  );
}

function dashboardMemoryContext(url: URL): Record<string, string | null> {
  return {
    route: url.pathname,
    tab: url.searchParams.get("tab") ?? "posts",
    panel: url.searchParams.get("panel") ?? "overview",
    period: url.searchParams.get("period") ?? "1",
    view: url.searchParams.get("view"),
    metric: url.searchParams.get("metric"),
  };
}
