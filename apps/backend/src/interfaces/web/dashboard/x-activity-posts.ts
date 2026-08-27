import type { PipelinePost } from "../../../analytics/pipeline-payload.js";
import type { XActivityDashboardItem } from "../../../analytics/x-activity-dashboard.js";

/** Standalone X activity in the single shape used by dashboard charts and
 * publication lists. Linked activity is already represented by its post. */
export function additionalXActivityPosts(posts: PipelinePost[], items: XActivityDashboardItem[]): PipelinePost[] {
  const representedPostKeys = new Set(posts.map((post) => post.publication_key).filter((key): key is string => Boolean(key)));
  return items.filter((item) => !item.linkedPublicationKey || !representedPostKeys.has(item.linkedPublicationKey)).map(xActivityPost);
}

export function xActivityPost(item: XActivityDashboardItem): PipelinePost {
  return {
    publication_key: `x-activity:${item.xPostId}`,
    date: item.publishedAt,
    text_en: item.text,
    targets: { x: { status: "published", url: item.url } },
    metrics: {
      x: {
        views: { value: Number(item.metrics.views ?? 0) },
        likes: { value: Number(item.metrics.interactions ?? 0) },
        replies: { value: Number(item.metrics.replies ?? 0) },
      },
    },
  };
}
