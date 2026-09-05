import type { APIContext } from "astro";
import { loadFeedItems } from "../server/public-site";
import { postSocialImagePath, postVisualMedia } from "../utils/media";
import { siteUrlFromContext } from "../utils/site";
import { excerptAfterTitle, getFirstSentence } from "../utils/text";

export const prerender = false;

function lastmod(date: string): string {
  const parsed = new Date(date);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString();
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function videoBlockFor(item: ReturnType<typeof loadFeedItems>[number], locale: "en" | "ru", siteUrl: string): string {
  const media = postVisualMedia(item, locale);
  if (media?.type !== "video") return "";
  const text = locale === "ru" ? item.text || "" : item.text_en || item.text || "";
  const title = getFirstSentence(text) || `Post ${item.post_id}`;
  const description = excerptAfterTitle(text, title, 2048) || title;
  const thumbnail = media.poster ? `${siteUrl}/${media.poster}` : `${siteUrl}${postSocialImagePath(item, locale)}`;
  const contentLoc = `${siteUrl}/${media.path}`;
  return `\n    <video:video>\n      <video:thumbnail_loc>${xmlEscape(thumbnail)}</video:thumbnail_loc>\n      <video:title>${xmlEscape(title)}</video:title>\n      <video:description>${xmlEscape(description)}</video:description>\n      <video:content_loc>${xmlEscape(contentLoc)}</video:content_loc>\n      <video:publication_date>${lastmod(item.date)}</video:publication_date>\n    </video:video>`;
}

export async function GET(context: APIContext) {
  const siteUrl = siteUrlFromContext(context);
  const items = loadFeedItems();
  const entries = items.flatMap((item) => {
    const urls: Array<{ loc: string; lastmod: string; video: string }> = [];
    if (item.has_en && item.post_id && item.slug_en)
      urls.push({
        loc: `${siteUrl}/${item.post_id}/${item.slug_en}/`,
        lastmod: lastmod(item.date),
        video: videoBlockFor(item, "en", siteUrl),
      });
    if (item.has_ru && item.post_id && item.slug_ru)
      urls.push({
        loc: `${siteUrl}/ru/${item.post_id}/${item.slug_ru}/`,
        lastmod: lastmod(item.date),
        video: videoBlockFor(item, "ru", siteUrl),
      });
    return urls;
  });
  const newest =
    entries
      .map((entry) => entry.lastmod)
      .sort()
      .at(-1) ?? "";
  const urls = [
    { loc: `${siteUrl}/`, lastmod: newest, video: "" },
    { loc: `${siteUrl}/ru/`, lastmod: newest, video: "" },
    { loc: `${siteUrl}/about/`, lastmod: newest, video: "" },
    { loc: `${siteUrl}/ru/about/`, lastmod: newest, video: "" },
    ...entries,
  ];
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:video="http://www.google.com/schemas/sitemap-video/1.1">\n${urls
    .map((url) => `  <url><loc>${url.loc}</loc>${url.lastmod ? `<lastmod>${url.lastmod}</lastmod>` : ""}${url.video}</url>`)
    .join("\n")}\n</urlset>\n`;

  return new Response(body, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
    },
  });
}
