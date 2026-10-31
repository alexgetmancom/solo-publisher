import crypto from "node:crypto";
import type { BackendConfig } from "./config.js";

/** Derives a privacy-preserving public visitor identity from the trusted proxy header.
 *
 * The header name is configured, never guessed: honouring whatever `X-Forwarded-For`
 * a client sends would let anyone mint a fresh identity per request. When the proxy
 * did not set it the request is genuinely unattributable and shares one bucket —
 * deliberately conservative, because the alternative (a unique identity per request)
 * would silently disable the public rate limit. */
export function clientIpHash(request: Request, config: BackendConfig): string {
  const address = request.headers.get(config.TRUSTED_CLIENT_IP_HEADER)?.trim() || "unknown";
  return crypto.createHmac("sha256", config.CLIENT_IP_HASH_SALT).update(address).digest("hex");
}
