import type { PipelinePost } from "../../../analytics/pipeline-payload.js";

function targetPublicUrl(target: string, externalId: string | null = null, url: string | null = null): string | null {
  if (url) return url.replace("threads.net", "threads.com");
  if (!externalId) return null;
  if (externalId.startsWith("http://") || externalId.startsWith("https://")) return externalId;
  // Handle-free forms only. Threads and Instagram hand back a permalink at
  // publish time and it arrives above as `url`; X does not, so this rebuilds
  // the same `/i/web/status/` link its adapter stores. A link built from a
  // hardcoded handle carries this installation's post id under some other
  // installation's account, and lands the operator on a stranger's post.
  if (target === "x") return `https://x.com/i/web/status/${externalId}`;
  return null;
}

/** Site URLs are built per locale from that locale's own slug. `post.site_url` is
 * not usable here: the read model falls back to the English URL when the Russian
 * locale is disabled, so the `site_ru` row linked to the English page. Both
 * branches return a site-relative path — the dashboard is served from the site's
 * own origin, and a hardcoded host would mislink the second account sharing this
 * image. */
function siteUrl(post: PipelinePost, locale: "ru" | "en"): string | null {
  const postId = post.post_id;
  const slug = locale === "ru" ? post.slug_ru : post.slug_en;
  if (!postId || !slug) return null;
  return locale === "ru" ? `/ru/${postId}/${slug}/` : `/${postId}/${slug}/`;
}

export function getTargetUrl(post: PipelinePost, target: string): string | null {
  const record = post.targets?.[target];
  const url = typeof record?.url === "string" ? record.url : null;
  const externalId = typeof record?.external_id === "string" ? record.external_id : null;
  if (target === "telegram") return post.telegram_url ?? targetPublicUrl(target, externalId, url);
  if (target === "site_ru") return siteUrl(post, "ru") ?? targetPublicUrl(target, externalId, url);
  if (target === "site_en") return siteUrl(post, "en") ?? targetPublicUrl(target, externalId, url);
  return targetPublicUrl(target, externalId, url);
}
