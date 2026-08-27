import type { PipelinePost } from "../../../analytics/pipeline-payload.js";

function targetPublicUrl(target: string, externalId: string | null = null, url: string | null = null): string | null {
  if (url) return url.replace("threads.net", "threads.com");
  if (!externalId) return null;
  if (externalId.startsWith("http://") || externalId.startsWith("https://")) return externalId;
  if (target === "x") return `https://x.com/alexgetmancom/status/${externalId}`;
  if (target === "threads_ru") return `https://www.threads.com/@alexgetmanru/post/${externalId}`;
  if (target === "threads_en") return `https://www.threads.com/@alexgetmanco/post/${externalId}`;
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
