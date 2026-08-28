import { publicationRef } from "../application/publication-ref.js";
import { targetLocale, targetsFor } from "../botTargets.js";
import { effectivePostTargets } from "../channels/registry.js";
import { parseMarkdownArticle } from "../content/markdown.js";
import { slugify } from "../content/message.js";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { articleLocales, articles } from "../db/schema.js";
import type { BackendConfig } from "../foundation/config.js";
import { primaryStudioActorId } from "../studio/access.js";
import { newDeliveryPayload } from "./delivery-payload.js";
import { enqueuePublishJobTx } from "./queue.js";

type PublishArticleInput = {
  locale: "ru" | "en";
  targets: string[];
  markdown: string;
};

/** Creates one long-form publication and queues it, in a single transaction.
 *
 * Delivery is the one that already exists: jobs land in `publish_jobs` under an
 * `article:{id}` key, settle into `publication_targets`, and fold back into the
 * article's own status. Nothing here is a second pipeline. */
export function publishArticle(backendDb: BackendDb, config: BackendConfig, input: PublishArticleInput) {
  const targets = [...new Set(input.targets)];
  if (!targets.length) throw new Error("publish needs at least one target");
  const carriers = new Set(targetsFor("article").map(({ id }) => String(id)));
  for (const target of targets) {
    if (!carriers.has(target)) throw new Error(`${target} does not carry articles; it publishes posts`);
    const locale = targetLocale(target);
    if (locale !== input.locale) throw new Error(`${target} is ${locale}, not ${input.locale}`);
  }
  const deliverable = effectivePostTargets(backendDb, Object.fromEntries(targets.map((target) => [target, true])));
  const unconnected = targets.filter((target) => !deliverable[target]);
  if (unconnected.length) throw new Error(`no connected channel for ${unconnected.join(", ")}; run \`channels\` to see what is connected`);

  const { title, body } = parseMarkdownArticle(input.markdown);
  // The title is a field, not the first line of the body. Without one there is
  // nothing to publish under, and X refuses an untitled Article outright.
  if (!title) throw new Error("an article needs a `# Title` heading");
  const actorId = primaryStudioActorId(config);
  if (!actorId) throw new Error("publish needs a configured Studio actor");
  const now = new Date().toISOString();

  return unsafeDb(backendDb)
    .sqlite.transaction(() => {
      const db = unsafeDb(backendDb).db;
      const article = db
        .insert(articles)
        .values({ actorId, status: "draft", createdAt: now, updatedAt: now })
        .returning({ id: articles.id })
        .get();
      if (!article) throw new Error("article insert did not return an id");
      const publicationKey = publicationRef("article", article.id);
      db.insert(articleLocales)
        .values({
          articleId: article.id,
          locale: input.locale,
          slug: slugify(title, article.id),
          title,
          bodyText: body.text,
          entitiesJson: JSON.stringify(body.entities),
          mediaJson: null,
          updatedAt: now,
        })
        .run();
      for (const target of targets)
        enqueuePublishJobTx(db, {
          publicationKey,
          target,
          // A brand-new article: nothing of it has been published anywhere.
          payload: newDeliveryPayload({ locale: input.locale, title, text: body.text, entities: body.entities, media: [] }),
          publishAt: now,
        });
      return { ok: true, article_id: article.id, ref: publicationKey, title, targets, queued: true };
    })
    .immediate();
}
