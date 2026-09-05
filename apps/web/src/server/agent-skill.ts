import { createHash } from "node:crypto";

export const READ_FEED_SKILL = "read-feed";
export const READ_FEED_DESCRIPTION = "Read the latest AI news, automation notes and developer posts from this site.";

/** The skill document an agent fetches after finding it in the discovery index.
 * It is built from the install's own origin, so the index must hash this exact
 * body rather than carry a digest someone remembered to update. */
export function readFeedSkill(site: string): string {
  const host = new URL(site).host;
  return `---
name: ${READ_FEED_SKILL}
description: ${READ_FEED_DESCRIPTION}
license: MIT
---
# Read Feed Skill

This skill lets agents fetch, digest, and search posts published on ${host}.

## How to use
1. Fetch the JSON Feed 1.1 document from \`${site}/feed.json\`.
2. Iterate \`items\`; each carries \`title\`, \`url\`, \`content_text\`, \`date_published\` and \`tags\`.
3. For a compact digest with entities already extracted, fetch \`${site}/feed-ai.json\` instead.
4. Present the relevant posts to the user.
`;
}

export function skillDigest(body: string): string {
  return `sha256:${createHash("sha256").update(body, "utf8").digest("hex")}`;
}
