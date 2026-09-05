/* =============================================================================
 * PLAYER DATA PREPARATION (runs on the server, during SSR)
 * -----------------------------------------------------------------------------
 * In:  HomePost[] — raw posts from utils/home-posts.ts (page level).
 * Out: PlayerPost[] — exactly the fields the player needs, with absolute media
 *      paths and feed modes already resolved.
 *
 * Why a separate layer: the Svelte island receives this as props and it is
 * serialized into the HTML. Anything computable ahead of time (paragraphs,
 * modes, view formatting) is computed HERE, not in the browser.
 *
 * A new player field: add it to PlayerPost and fill it in toPlayerPosts().
 * ========================================================================== */

import { metricValue, paragraphsFor } from "../../components/home-news/storyHelpers";
import type { HomeMedia, HomePost } from "../../components/home-news/types";

export interface PlayerPost {
  id: string;
  url: string;
  title: string;
  /** Paragraphs for the right-hand panel (capped at 7, no repeated title). */
  body: string[];
  /** Full body text (for the noscript SEO fallback and Deep mode). */
  fullBody: string[];
  excerpt: string;
  date: string;
  relativeDate: string;
  image: string | null;
  fallbackImage: string | null;
  posterSrc: string | null;
  mediaType: "image" | "video" | null;
  gallery: Array<{ type: "image" | "video"; path: string | null; poster: string | null }>;
  audioUrl: string | null;
  spotifyUrl: string | null;
  imageSrcSet: string;
  /** Formatted for display: "1.2k". */
  views: string;
  category: string;
  /** Which feed modes show this post: latest / deep / watched. */
  feedModes: string[];
}

const publicSrc = (value?: string | null): string | null => (value ? `/${String(value).replace(/^\/+/, "")}` : null);

function fullTextFor(post: HomePost): string[] {
  return (post.body || post.excerpt || post.title)
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Deep = long posts; Watched = the ~8 most viewed.
 * fullBody arrives already computed: this is SSR on every request for the
 * home page. */
function feedModesFor(post: HomePost, fullBody: string[], watchedCutoff: number): string[] {
  const modes = ["latest"];
  if (fullBody.join(" ").length >= 700 || fullBody.length >= 4) modes.push("deep");
  if ((post.views || 0) >= watchedCutoff && watchedCutoff > 0) modes.push("watched");
  return modes;
}

/** The view count that makes a post one of the ~8 most watched. It is a property
 * of the whole feed, not of the page being serialized: the home page sends the
 * player one page at a time, and a cutoff taken from a page would call the most
 * watched of the first twelve posts "watched". */
export function watchedCutoffFor(posts: HomePost[]): number {
  return posts.map((post) => post.views || 0).sort((a, b) => b - a)[Math.min(7, Math.max(0, posts.length - 1))] || 0;
}

export function toPlayerPosts(posts: HomePost[], watchedCutoff = watchedCutoffFor(posts)): PlayerPost[] {
  return posts.map((post) => {
    const fullBody = fullTextFor(post);
    return {
      id: String(post.id),
      url: post.url,
      title: post.title,
      body: paragraphsFor(post),
      fullBody,
      excerpt: post.excerpt,
      date: post.date,
      relativeDate: post.relativeDate,
      image: publicSrc(post.image),
      fallbackImage: publicSrc(post.fallbackImage),
      posterSrc: publicSrc(post.posterSrc),
      mediaType: post.mediaType || null,
      gallery: (post.gallery || []).map((media: HomeMedia) => ({
        type: media.type,
        path: publicSrc(media.path),
        poster: publicSrc(media.poster),
      })),
      audioUrl: post.audioUrl || null,
      spotifyUrl: post.spotifyUrl || null,
      imageSrcSet: post.imageSrcSet || "",
      views: metricValue(post.views),
      category: post.category,
      feedModes: feedModesFor(post, fullBody, watchedCutoff),
    };
  });
}
