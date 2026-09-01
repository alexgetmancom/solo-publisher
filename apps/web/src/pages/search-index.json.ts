import { type FeedItem, loadFeedItems } from "../server/public-site";
import { postImagePath } from "../utils/media";
import { siteUrlFromContext } from "../utils/site";
import { localizedCategory } from "../utils/taxonomy";
import { compactText, excerptAfterTitle, getFirstSentence, truncateText } from "../utils/text";

export const prerender = false;

/** The host serving this index, so a self-hosted Studio does not attribute
 * every one of its own entries to somebody else. */
export function telegramToSearchItems(item: FeedItem, source: string) {
  const postId = item.post_id;
  const entries = [];

  if (item.has_en && item.text_en && item.slug_en) {
    const text = compactText(item.text_en || item.html_en || "");
    const title = compactText(getFirstSentence(item.text_en || text)) || `Post ${postId}`;
    entries.push({
      id: `post:${postId}:en`,
      type: "post",
      title: truncateText(title, 120),
      excerpt: excerptAfterTitle(text, title, 180),
      url: `/${postId}/${item.slug_en}/`,
      date: item.date,
      source,
      category: localizedCategory(text, "en"),
      image: postImagePath(item, "en"),
    });
  }

  if (item.has_ru && item.text && item.slug_ru) {
    const text = compactText(item.text || item.html || "");
    const title = compactText(getFirstSentence(item.text || text)) || `Публикация ${postId}`;
    entries.push({
      id: `post:${postId}:ru`,
      type: "post",
      title: truncateText(title, 120),
      excerpt: excerptAfterTitle(text, title, 180),
      url: `/ru/${postId}/${item.slug_ru}/`,
      date: item.date,
      source,
      category: localizedCategory(item.text || text, "ru"),
      image: postImagePath(item, "ru"),
    });
  }

  return entries;
}

export async function GET(context: { site?: URL | string | null }) {
  const source = new URL(siteUrlFromContext(context)).host;
  const telegramItems = loadFeedItems()
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .flatMap((item) => telegramToSearchItems(item, source));

  return new Response(
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        items: telegramItems,
      },
      null,
      2,
    ),
    {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=300",
        "X-Robots-Tag": "noindex, follow",
      },
    },
  );
}
