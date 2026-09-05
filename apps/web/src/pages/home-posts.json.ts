import type { APIContext } from "astro";
import { homePageSize } from "../features/story-player/config";
import { toPlayerPosts, watchedCutoffFor } from "../features/story-player/payload";
import { loadFeedItems } from "../server/public-site";
import { sortedHomePosts } from "../utils/home-posts";

export const prerender = false;

/** The home page's feed, one page at a time. The player asks for the next page
 * as the reader approaches the end of the one it has, so the first response of
 * the page carries twelve posts instead of the whole archive. */
export function GET(context: APIContext): Response {
  const params = context.url.searchParams;
  const locale = params.get("locale") === "ru" ? "ru" : "en";
  const posts = sortedHomePosts(loadFeedItems(), locale);
  const offset = boundedNumber(params.get("offset"), 0, posts.length);
  const limit = boundedNumber(params.get("limit"), homePageSize, homePageSize);
  // The cutoff comes from the whole feed: "watched" means the most viewed posts
  // of the archive, and a page of twelve has its own most viewed regardless.
  const page = toPlayerPosts(posts.slice(offset, offset + limit), watchedCutoffFor(posts));
  return Response.json({ posts: page, total: posts.length }, { headers: { "cache-control": "public, max-age=60" } });
}

/** A whole number within the page's own bounds. An absent parameter is the
 * fallback rather than zero: `Number(null)` is 0, and a missing `limit` served
 * an empty page that read as the end of the feed. */
function boundedNumber(value: string | null, fallback: number, max: number): number {
  if (value === null || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}
