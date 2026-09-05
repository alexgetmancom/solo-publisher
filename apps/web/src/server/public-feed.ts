import rss from "@astrojs/rss";
import type { APIContext } from "astro";
import { formatDate } from "../utils/dates";
import { keyEntities } from "../utils/key-entities";
import { localePath, SITE_LOCALE_TAGS, SITE_LOCALES, type SiteLocale } from "../utils/locale";
import { hasPublishedLocale, localizedHtml, localizedSlug, localizedText, sortedPublishedItems } from "../utils/public-feed";
import { siteUrlFromContext } from "../utils/site";
import { compactText, truncateText } from "../utils/text";
import { findFeedItem, loadFeedItems } from "./public-site";
import { getRuntime } from "./runtime";
import { fill, siteCopy } from "./site-copy";

const LLMS_POST_LIMIT = 30;

/** Absolute canonical URL of one post in one language. */
function postUrl(item: { post_id?: number | string | null }, slug: string, locale: SiteLocale, origin = siteUrlFromContext()): string {
  return `${origin}${localePath(locale, `/${item.post_id}/${slug}/`)}`;
}

/** The post's title, or a numbered fallback when its text opens with nothing usable. */
function postTitle(text: string, id: number | string | undefined | null, locale: SiteLocale, limit = 86): string {
  return truncateText(text, limit) || fill(siteCopy(locale).postFallback, { id: String(id ?? "") });
}

export async function publicRssResponse(context: APIContext, locale: SiteLocale): Promise<Response> {
  const items = sortedPublishedItems(loadFeedItems(), locale, 50);
  const copy = siteCopy(locale);

  return rss({
    title: copy.feedTitle,
    description: copy.feedDescription,
    site: siteUrlFromContext(context),
    items: items.map((item) => {
      const slug = localizedSlug(item, locale) ?? "";
      return {
        title: postTitle(localizedText(item, locale), item.post_id, locale),
        pubDate: new Date(item.date),
        description: localizedHtml(item, locale),
        link: localePath(locale, `/${item.post_id}/${slug}/`),
      };
    }),
    customData: `<language>${locale}</language>`,
  });
}

/**
 * JSON Feed 1.1. The endpoint used to serve the site's internal row shape under
 * this name, which no feed reader and no generic agent can parse — `/feed-ai.json`
 * is where this site's own vocabulary belongs, and this address answers in the
 * spec every reader already implements.
 */
export function publicJsonFeedResponse(context: APIContext, locale: SiteLocale): Response {
  const siteUrl = siteUrlFromContext(context);
  const copy = siteCopy(locale);
  const items = sortedPublishedItems(loadFeedItems(), locale, 50).map((item) => {
    const slug = localizedSlug(item, locale) ?? "";
    const url = postUrl(item, slug, locale, siteUrl);
    const text = localizedText(item, locale);
    const image = locale === "ru" ? item.image : item.image_en || item.image;
    return {
      id: url,
      url,
      title: postTitle(text, item.post_id, locale),
      content_html: localizedHtml(item, locale),
      content_text: compactText(text),
      date_published: new Date(item.date).toISOString(),
      language: locale,
      ...(image ? { image: `${siteUrl}/${String(image).replace(/^\//, "")}` } : {}),
      ...(item.entities.length > 0
        ? { tags: item.entities.map((entity) => (locale === "ru" ? entity.title_ru : entity.title_en || entity.title_ru)).filter(Boolean) }
        : {}),
    };
  });

  const body = {
    version: "https://jsonfeed.org/version/1.1",
    title: copy.feedTitle,
    home_page_url: `${siteUrl}${localePath(locale)}`,
    feed_url: `${siteUrl}${localePath(locale, "/feed.json")}`,
    description: copy.feedDescription,
    language: locale,
    authors: [{ name: copy.llmsTitle, url: `${siteUrl}${localePath(locale)}`, avatar: `${siteUrl}/avatar.png` }],
    items,
  };

  return new Response(JSON.stringify(body, null, 2), {
    headers: {
      "Content-Type": "application/feed+json; charset=utf-8",
      "Cache-Control": "public, max-age=60",
      "X-Robots-Tag": "noindex, follow",
    },
  });
}

export function publicAiFeedResponse(locale: SiteLocale): Response {
  // sortedPublishedItems already orders newest-first and applies the cap.
  const items = sortedPublishedItems(loadFeedItems(), locale, 100).map((item) => {
    const text = compactText(localizedText(item, locale));
    const canonicalUrl = postUrl(item, localizedSlug(item, locale) ?? "", locale);
    return {
      id: `post:${item.post_id}`,
      title: truncateText(text, 100),
      tldr: truncateText(text, 280),
      key_entities: keyEntities(text),
      published_at: item.date,
      canonical_url: canonicalUrl,
      markdown_url: `${canonicalUrl.slice(0, -1)}.md`,
      // Every language this post also exists in, the current one excluded: the
      // reader is already holding that one.
      translations: Object.fromEntries(
        SITE_LOCALES.filter((other) => other !== locale && hasPublishedLocale(item, other)).map((other) => [
          other,
          postUrl(item, localizedSlug(item, other) ?? "", other),
        ]),
      ),
      actions: [],
    };
  });

  return new Response(JSON.stringify({ version: 1, updated_at: new Date().toISOString(), items }, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=60",
      "X-Robots-Tag": "noindex, follow",
    },
  });
}

export async function publicMarkdownResponse(context: APIContext, locale: SiteLocale): Promise<Response> {
  const found = findFeedItem(context.params.postId);
  const slug = found ? localizedSlug(found, locale) : null;
  const item = found && hasPublishedLocale(found, locale) && slug === context.params.slug ? found : undefined;
  if (!item || !slug) return new Response("Markdown file not found\n", { status: 404 });

  const siteUrl = siteUrlFromContext(context);
  const copy = siteCopy(locale);
  const text = localizedText(item, locale);
  const lines = [
    `# ${text.split("\n")[0] || postTitle("", item.post_id, locale)}`,
    "",
    `*${copy.publishedOn}: ${new Date(item.date).toUTCString()}*`,
    "",
    text,
    "",
    "---",
    `[${copy.backHome}](${siteUrl}${localePath(locale)}) | [${copy.viewArticle}](${postUrl(item, slug, locale, siteUrl)})`,
  ];

  return new Response(`${lines.join("\n")}\n`, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
    },
  });
}

/**
 * llms.txt: the link-shaped map of the site an agent reads first. Every entry
 * is a link, including the posts — a full-text dump belongs behind the `.md`
 * URLs each row points at, not in the index itself.
 */
export async function publicLlmsResponse(context: APIContext, locale: SiteLocale, contentType: string): Promise<Response> {
  const timeZone = getRuntime().config.TIMEZONE;
  const items = sortedPublishedItems(loadFeedItems(), locale);
  const copy = siteCopy(locale);
  const siteUrl = siteUrlFromContext(context);
  const others = SITE_LOCALES.filter((other) => other !== locale);

  const lines = [
    `# ${copy.llmsTitle}`,
    "",
    `> ${copy.llmsTagline}`,
    "",
    `## ${copy.headingAbout}`,
    "",
    copy.llmsAbout,
    "",
    `## ${copy.headingLinks}`,
    "",
    `- ${copy.labelWebsite}: ${siteUrl}${localePath(locale)}`,
    `- ${copy.aboutTitle}: ${siteUrl}${localePath(locale, "/about/")}`,
    `- ${copy.labelJsonFeed}: ${siteUrl}${localePath(locale, "/feed.json")}`,
    `- ${copy.labelRss}: ${siteUrl}${localePath(locale, "/feed.xml")}`,
    `- ${copy.labelMarkdownIndex}: ${siteUrl}${localePath(locale, "/index.md")}`,
    ...others.flatMap((other) => [
      `- ${siteCopy(other).nativeName}: ${siteUrl}${localePath(other)}`,
      `- ${siteCopy(other).nativeName} ${siteCopy(other).labelRss}: ${siteUrl}${localePath(other, "/feed.xml")}`,
    ]),
    `- ${copy.labelSitemap}: ${siteUrl}/sitemap.xml`,
    "",
    `## ${copy.headingSocial}`,
    "",
    ...copy.social.map(([label, url]) => `- ${label}: ${url}`),
    "",
    `## ${copy.headingPosts}`,
    "",
  ];

  if (items.length === 0) {
    lines.push(`- ${copy.noPosts}`);
  } else {
    for (const item of items.slice(0, LLMS_POST_LIMIT)) {
      const slug = localizedSlug(item, locale);
      if (!slug) continue;
      const title = postTitle(localizedText(item, locale), item.post_id, locale);
      const date = formatDate(item.date, SITE_LOCALE_TAGS[locale], timeZone);
      lines.push(`- [${title}](${siteUrl}${localePath(locale, `/${item.post_id}/${slug}.md`)}) - ${date} MSK`);
    }
  }

  // One document, two addresses: /llms.txt by the convention's name, and
  // /index.md as the Markdown twin of the home page. They differ only in what
  // the caller says the body is, so the type is an argument rather than a
  // branch on which route arrived here.
  return new Response(`${lines.join("\n")}\n`, { headers: { "Content-Type": contentType } });
}
