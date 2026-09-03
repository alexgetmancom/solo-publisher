import { asc, eq } from "drizzle-orm";
import { publicationRef } from "../application/publication-ref.js";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { drafts, publicationTargets } from "../db/schema.js";
import { isPartialDelivery } from "../publishing/state.js";

/** Read-only target verification for the Operations CLI and API. */
export async function verifyPostTargets(backendDb: BackendDb, ref: string): Promise<Record<string, unknown>[]> {
  const numeric = Number(ref.replace(/^post:/, ""));
  // A non-numeric ref must not reach the query as NaN: bind it only when it is a
  // usable id, and otherwise match on the post key alone.
  const id = Number.isSafeInteger(numeric) ? numeric : null;
  const post = unsafeDb(backendDb)
    .db.select({ postId: drafts.postId })
    .from(drafts)
    .where(eq(drafts.postId, id ?? -1))
    .get();
  if (!post?.postId) throw new Error(`post not found: ${ref}`);
  const publicationKey = publicationRef("post", post.postId);
  const targets = unsafeDb(backendDb)
    .db.select({
      target: publicationTargets.target,
      status: publicationTargets.status,
      url: publicationTargets.url,
      error: publicationTargets.error,
      externalId: publicationTargets.externalId,
    })
    .from(publicationTargets)
    .where(eq(publicationTargets.publicationKey, publicationKey))
    .orderBy(asc(publicationTargets.target))
    .all();
  return Promise.all(
    targets.map(async (record) => {
      // An unfinished target holding an external id put something in front of
      // the audience: it is still not ok, and it is not "nothing was sent"
      // either. Naming the id is what makes the live remains reachable.
      if (record.status !== "published")
        return {
          ...record,
          ok: false,
          partial: isPartialDelivery(record.status, record.externalId),
          reason: record.externalId ? `published_in_part:${record.externalId}` : (record.error ?? "not_published"),
        };
      if (!record.url) return { ...record, ok: true, partial: false, reason: "no_public_url_known" };
      try {
        const probe = await probePublication(record.url);
        return { ...record, ...probe, partial: false };
      } catch (error) {
        return { ...record, ok: false, partial: false, reason: error instanceof Error ? error.message : String(error) };
      }
    }),
  );
}

/** Asks the publication's own address whether it is still there.
 *
 * Redirects are not followed. `redirect: "follow"` was answering the question
 * with somebody else's page: a deleted post that the platform answers by
 * redirecting to a profile or a login wall ended the chain on a 200, and this
 * command called that a live publication. A redirect is now reported as what it
 * is and left to be read. Not following also settles where this request can go:
 * the URL is not the operator's — it is whatever the platform's API reported at
 * publish time — so a chain was free to walk from a public host into this
 * container's own network with nothing looking at the hops. */
async function probePublication(url: string): Promise<{ ok: boolean; reason: string }> {
  const target = publicUrl(url);
  if (!target) return { ok: false, reason: "unverifiable_url" };
  const response = await fetch(target, {
    headers: { "user-agent": "solo-publisher-verify/1.0" },
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  // The question this answers is "is the publication still there", so a 404 or
  // 410 is a failure, not a pass: a deleted post used to verify as ok. 5xx stays
  // a failure too, but as a provider fault rather than a verdict about the post.
  if (response.status >= 300 && response.status <= 399)
    return { ok: false, reason: `http_${response.status}:${response.headers.get("location") ?? "no_location"}` };
  return { ok: response.status < 400, reason: `http_${response.status}` };
}

/** A published post lives at a public HTTPS name. Anything else — another
 * scheme, a bare address, a private or loopback host — is not a post URL, and
 * asking it would only tell an outsider what this container can reach. */
function publicUrl(value: string): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  // A real post URL is a name, never a literal address, so every literal is
  // refused rather than picked apart range by range.
  if (/^[0-9.]+$/.test(host) || host.includes(":")) return null;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) return null;
  if (!host.includes(".")) return null;
  return parsed;
}
