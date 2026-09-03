import type { UnsafeBackendDb } from "../../src/db/client.js";
import { drafts, postLocales } from "../../src/db/schema.js";

type TextPostFixture = {
  postId?: number | null;
  draftId?: number;
  actorId?: number;
  status?: string;
  messageId?: number | null;
  targets?: Record<string, boolean>;
  ru?: string;
  en?: string;
  mediaRu?: Record<string, unknown>[];
  mediaEn?: Record<string, unknown>[];
  storyMediaRu?: Record<string, unknown>[];
  storyMediaEn?: Record<string, unknown>[];
  siteMediaRu?: Record<string, unknown>[];
  siteMediaEn?: Record<string, unknown>[];
  slugRu?: string;
  slugEn?: string;
  siteRu?: boolean;
  siteEn?: boolean;
  publishedAt?: string | null;
  scheduledAt?: string | null;
  scheduledEnAt?: string | null;
  publishMode?: string | null;
  now?: string;
};

/** Creates the same aggregate shape production owns, without reviving any of
 * the removed persistence representations in test setup. */
export function seedTextPost(backendDb: UnsafeBackendDb, input: TextPostFixture): number {
  const draftId = input.draftId ?? input.postId;
  if (draftId == null) throw new Error("text post fixture needs a draftId or postId");
  const now = input.now ?? new Date().toISOString();
  backendDb.db
    .insert(drafts)
    .values({
      id: draftId,
      actorId: input.actorId ?? 0,
      status: input.status ?? "published",
      targetsJson: JSON.stringify(input.targets ?? {}),
      postId: input.postId ?? null,
      scheduledAt: input.scheduledAt ?? null,
      scheduledEnAt: input.scheduledEnAt ?? null,
      publishMode: input.publishMode ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  backendDb.db
    .insert(postLocales)
    .values([
      {
        draftId,
        locale: "ru",
        sourceText: input.ru ?? "",
        mediaJson: input.mediaRu ?? [],
        storyMediaJson: input.storyMediaRu ?? [],
        siteMediaJson: input.siteMediaRu ?? input.mediaRu ?? [],
        slug: input.slugRu ?? (input.postId ? `post-${input.postId}-ru` : null),
        siteEnabled: input.siteRu ? 1 : 0,
        publishedAt: input.siteRu ? (input.publishedAt ?? now) : null,
        updatedAt: now,
      },
      {
        draftId,
        locale: "en",
        sourceText: input.en ?? "",
        mediaJson: input.mediaEn ?? input.mediaRu ?? [],
        storyMediaJson: input.storyMediaEn ?? [],
        siteMediaJson: input.siteMediaEn ?? input.mediaEn ?? input.mediaRu ?? [],
        slug: input.slugEn ?? (input.postId ? `post-${input.postId}-en` : null),
        siteEnabled: input.siteEn ? 1 : 0,
        publishedAt: input.siteEn ? (input.publishedAt ?? now) : null,
        updatedAt: now,
      },
    ])
    .run();
  return draftId;
}
