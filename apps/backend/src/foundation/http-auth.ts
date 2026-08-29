import { timingSafeEqual } from "node:crypto";
import { actorFromStudioToken, type StudioActorId } from "./actors.js";
import type { BackendConfig } from "./config.js";

export function commandAllowed(request: Request, config: BackendConfig, payloadToken?: string | null): boolean {
  if (!config.commandCenterToken) return false;
  // A `?token=` in the URL survives in proxy access logs, Referer headers and
  // browser history, so it is accepted only for safe reads: the Command Center's
  // GET bootstrap immediately trades it for an HttpOnly cookie, and diagnostic
  // GET links keep working. Anything that changes state must present the token
  // in a header, the form body, or that cookie.
  const queryToken = isSafeMethod(request.method) ? new URL(request.url).searchParams.get("token") : null;
  const token =
    payloadToken?.trim() ||
    request.headers.get("X-Command-Token") ||
    request.headers.get("X-Admin-Token") ||
    queryToken ||
    cookieValue(request.headers.get("Cookie") ?? undefined, "command_token") ||
    "";
  return safeEqual(token, config.commandCenterToken);
}

function isSafeMethod(method: string): boolean {
  const value = method.toUpperCase();
  return value === "GET" || value === "HEAD";
}

function cookieValue(cookieHeader: string | undefined, name: string): string {
  if (!cookieHeader) return "";
  for (const chunk of cookieHeader.split(";")) {
    const [key, ...value] = chunk.trim().split("=");
    if (key === name) return decodedCookie(value.join("="));
  }
  return "";
}

/** A cookie the browser never wrote — a truncated or hand-edited `command_token`
 * — must fail authorization, not the request: `decodeURIComponent` throws on a
 * stray `%`, and that reached the client as a 500. */
function decodedCookie(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Cookie authority is ambient: a cross-site form can ride it. Routes that act
 * on a cookie alone pair `commandAllowed` with this check, so a POST has to come
 * from the Command Center's own origin. A caller presenting the token explicitly
 * is a script, not a drive-by browser form, and is exempt. */
export function sameOriginCommandLogin(request: Request, config: BackendConfig): boolean {
  const expectedOrigin = new URL(config.COMMAND_CENTER_URL).origin;
  const origin = request.headers.get("origin");
  if (origin) return origin === expectedOrigin;
  const referer = request.headers.get("referer");
  if (!referer) return false;
  try {
    return new URL(referer).origin === expectedOrigin;
  } catch {
    return false;
  }
}

/** Resolves the bearer token on a Studio request to the actor it authorizes, or
 * null when Studio access is unconfigured or the token does not match. */
export function mcpStudioActor(request: Request, config: BackendConfig): StudioActorId | null {
  const authorization = request.headers.get("authorization") ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";
  return actorFromStudioToken(config, token, safeEqual);
}

function safeEqual(left: string, right: string): boolean {
  if (!left || !right) return false;
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
