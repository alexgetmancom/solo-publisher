import { eq } from "drizzle-orm";
import { z } from "zod";
import { isKnownTarget } from "../botTargets.js";
import type { BackendDb } from "../db/client.js";
import { unsafeDb } from "../db/client.js";
import { drafts } from "../db/schema.js";
import { editPublishedTargets } from "../delivery/external-edits.js";
import { attemptPublishedTargetRemovals, settlePublishedTargetRemovals } from "../delivery/external-removals.js";
import type { BackendConfig } from "../foundation/config.js";
import { parsePublicationSource } from "../publishing/publication-source.js";
import { parseManualSchedule } from "../publishing/schedule.js";
import { createStudioServices } from "../studio/services/index.js";
import { recordOperationAction } from "./action-audit.js";
import { editLocaleContentTx, parseLocaleMedia, refreshLocaleSiteTx, replaceLocaleMediaTx } from "./commands/content-repair.js";
import { attemptTextFallbackRemovals, requeueAfterRemovalTx, requeuePublicationScopeTx } from "./commands/requeue.js";
import { publicationScope, scopePlan } from "./commands/scope-plan.js";
import { resolvePublicationRef, sourcePayload } from "./publication-ref.js";

/** A boolean an HTML form, a JSON body or a CLI flag can all express. Not
 * `z.coerce.boolean()`: that reads the string "false" as true, which on `apply`
 * would arm the very gate the caller wrote out to keep shut. */
const commandFlag = z
  .preprocess((value) => (typeof value === "string" ? !["", "0", "false", "off", "no"].includes(value.toLowerCase()) : value), z.boolean())
  .default(false);

/** Explicit maintenance command accepted by the Operations boundary.
 *
 * One name per action and one field per value: the locale is an argument, so
 * `edit_en`, `replace_en_media`, `text_en` and `media_en_json` were the English
 * case spelled twice, and every dispatch below had to test for both. */
export const commandActionSchema = z.strictObject({
  action: z.string().default(""),
  ref: z.string().optional(),
  target: z.string().optional(),
  locale: z.preprocess((value) => (value === "" ? undefined : value), z.enum(["ru", "en"]).optional()),
  text: z.string().optional(),
  media_json: z.string().optional(),
  at: z.string().optional(),
  schedule_locale: z.enum(["ru", "en", "both"]).optional(),
  /** Publish the scope again after taking it down; `delete` alone leaves it down. */
  republish: commandFlag,
  /** Commands that reach a live audience report their scope unless this is set. */
  apply: commandFlag,
  token: z.string().optional(),
  actor_type: z.string().optional(),
});

/** What a caller writes; defaults are filled in by the dispatcher's own parse. */
export type CommandAction = z.input<typeof commandActionSchema>;

/** Actions whose effect is visible outside this system. */
const AUDIENCE_ACTIONS = new Set(["retry", "edit", "replace_media", "use_other_media", "delete"]);

/** Dispatches authorised Operations commands; persistence lives in command modules. */
export async function runOperationCommand(
  backendDb: BackendDb,
  raw: CommandAction,
  config?: BackendConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
  // Parsed here rather than at each caller so `apply` and `republish` cannot
  // reach the dispatch as undefined: an unarmed gate must fail closed.
  const input = commandActionSchema.parse(raw);
  const ref = input.ref?.trim() ?? "";
  if (!ref) throw new Error("missing publication ref");
  const publicationRef = resolvePublicationRef(backendDb, ref);
  if (!publicationRef) throw new Error(`publication not found: ${ref}`);
  // Checked here rather than in commandActionSchema because the CLI builds its
  // input directly and never parses it, and the HTTP route falls back to an
  // empty command on a parse failure -- so the schema is not a choke point and
  // this is. An unknown target used to reach a worker as a durable job for a
  // target no publisher serves, failing hours later instead of at the keystroke.
  if (input.target && !isKnownTarget(input.target)) throw new Error(`unknown target: ${input.target}`);
  // Every command below this line either sends something to an audience or
  // takes something away from one, so each reports its scope until told to act.
  // `reschedule` and `refresh_site` move nothing public and are not gated.
  if (!input.apply && AUDIENCE_ACTIONS.has(input.action))
    return scopePlan(input.action, publicationRef, publicationScope(backendDb, publicationRef, input.target, input.locale), {
      ...(input.action === "delete" ? { republish: input.republish } : {}),
    });
  if (input.action === "retry") {
    const source = parsePublicationSource(sourcePayload(backendDb, publicationRef));
    return commitOperation(backendDb, input, publicationRef, (tx) =>
      requeuePublicationScopeTx(tx, publicationRef, source, input.target, input.locale),
    );
  }
  if (input.action === "reschedule") {
    if (!config) throw new Error("reschedule requires runtime config");
    const result = reschedulePost(backendDb, publicationRef, config, input.schedule_locale, input.at);
    return commitOperation(backendDb, input, publicationRef, () => result);
  }
  if (input.action === "refresh_site") {
    const locale = input.locale ?? "en";
    return commitOperation(backendDb, input, publicationRef, (tx) => refreshLocaleSiteTx(tx, publicationRef, locale));
  }
  if (input.action === "edit") {
    const locale = input.locale ?? "en";
    const text = input.text ?? "";
    if (!text.trim()) throw new Error(`text_${locale} is required`);
    const source = parsePublicationSource(sourcePayload(backendDb, publicationRef));
    let external: Array<Record<string, unknown>> = [];
    let fallbacks: Awaited<ReturnType<typeof attemptTextFallbackRemovals>> = [];
    if (config) {
      external = await editPublishedTargets(
        backendDb,
        {
          publicationKey: publicationRef.publicationKey,
          textRu: locale === "ru" ? text : null,
          textEn: locale === "en" ? text : null,
          ...(input.target ? { target: input.target } : {}),
          locale,
        },
        config,
        fetchImpl,
      );
      fallbacks = await attemptTextFallbackRemovals(backendDb, publicationRef, config, input.target, locale, fetchImpl, external);
    }
    const nextSource = {
      ...source,
      locales: { ...source.locales, [locale]: { ...source.locales[locale], text: text.trim() } },
    };
    return commitOperation(backendDb, input, publicationRef, (tx) => {
      const result = editLocaleContentTx(tx, publicationRef, locale, text);
      if (config) {
        result.external = external;
        result.replaced = fallbacks.flatMap(({ target, attempts }) => {
          const removed = settlePublishedTargetRemovals(tx, attempts);
          if (!removed.some((item) => item.ok)) return [];
          return [{ target, removed, republish: requeueAfterRemovalTx(tx, publicationRef, nextSource, removed, target) }];
        });
      }
      return result;
    });
  }
  if (input.action === "replace_media" || input.action === "use_other_media") {
    const locale = input.locale ?? "en";
    const media = input.action === "replace_media" ? parseLocaleMedia(input.media_json) : null;
    const source = parsePublicationSource(sourcePayload(backendDb, publicationRef));
    const fallback = locale === "en" && media == null ? source.locales.ru.media : [];
    const nextMedia = media ?? fallback;
    const nextSource = {
      ...source,
      locales: { ...source.locales, [locale]: { ...source.locales[locale], media: nextMedia, siteMedia: nextMedia } },
    };
    const attempts = config
      ? await attemptPublishedTargetRemovals(
          backendDb,
          config,
          { publicationKey: publicationRef.publicationKey, ...(input.target ? { target: input.target } : {}), locale },
          fetchImpl,
        )
      : [];
    return commitOperation(backendDb, input, publicationRef, (tx) => {
      const result = replaceLocaleMediaTx(tx, publicationRef, locale, media);
      if (config) {
        const removed = settlePublishedTargetRemovals(tx, attempts);
        result.removed = removed;
        result.republish = requeueAfterRemovalTx(tx, publicationRef, nextSource, removed, input.target);
      } else result.republish = requeuePublicationScopeTx(tx, publicationRef, nextSource, input.target, locale);
      return result;
    });
  }
  if (input.action === "delete") {
    if (!config) throw new Error("external removal requires runtime config");
    const source = parsePublicationSource(sourcePayload(backendDb, publicationRef));
    const attempts = await attemptPublishedTargetRemovals(
      backendDb,
      config,
      {
        publicationKey: publicationRef.publicationKey,
        ...(input.target ? { target: input.target } : {}),
        ...(input.locale ? { locale: input.locale } : {}),
      },
      fetchImpl,
    );
    return commitOperation(backendDb, input, publicationRef, (tx) => {
      const removed = settlePublishedTargetRemovals(tx, attempts);
      const result: Record<string, unknown> = { ok: true, removed };
      if (input.republish) result.republish = requeueAfterRemovalTx(tx, publicationRef, source, removed, input.target);
      return result;
    });
  }
  throw new Error(`unknown action: ${input.action}`);
}

type OperationTransaction = Parameters<Parameters<ReturnType<typeof unsafeDb>["db"]["transaction"]>[0]>[0];

function commitOperation(
  backendDb: BackendDb,
  input: z.output<typeof commandActionSchema>,
  ref: NonNullable<ReturnType<typeof resolvePublicationRef>>,
  mutate: (tx: OperationTransaction) => Record<string, unknown>,
): Record<string, unknown> {
  return unsafeDb(backendDb).db.transaction((tx) => {
    const result = mutate(tx);
    result.applied = true;
    recordOperationAction(tx, input.action, ref, input.target ?? null, result, input.actor_type ?? "operations");
    return result;
  });
}

function reschedulePost(
  backendDb: BackendDb,
  ref: ReturnType<typeof resolvePublicationRef> & {},
  config: BackendConfig,
  locale: "ru" | "en" | "both" | undefined,
  rawAt: string | undefined,
): Record<string, unknown> {
  if (ref.postId == null) throw new Error("reschedule requires a Studio post ref");
  if (!locale) throw new Error("missing schedule locale");
  if (!rawAt?.trim()) throw new Error("missing schedule time");
  const draft = unsafeDb(backendDb)
    .db.select({ id: drafts.id, actorId: drafts.actorId })
    .from(drafts)
    .where(eq(drafts.postId, ref.postId))
    .get();
  if (!draft) throw new Error(`draft not found for publication: ${ref.publicationKey}`);
  const at = parseOperationSchedule(rawAt, config);
  const posts = createStudioServices(backendDb, config).posts;
  const input = posts.scheduleAt(draft.actorId, draft.id, locale, at);
  const postId = posts.schedule(draft.actorId, draft.id, input);
  const updated = posts.get(draft.actorId, draft.id);
  return {
    ok: true,
    action: "reschedule",
    draft_id: draft.id,
    post_id: postId,
    locale,
    at: at.toISOString(),
    ru_at: updated.scheduled_at,
    en_at: updated.scheduled_en_at,
    status: updated.status,
  };
}

/** The one reading of a time an operator typed, shared by every command that
 * takes one: an explicit offset is honoured as written, and a bare wall clock
 * belongs to the Studio's time zone. Two readings of "06.08.2026 08:00" put a
 * post on two days. */
export function parseOperationSchedule(value: string, config: BackendConfig): Date {
  const trimmed = value.trim();
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(trimmed)) {
    const parsed = new Date(trimmed);
    if (!Number.isNaN(parsed.getTime())) return parsed;
    throw new Error(`invalid schedule time: ${value}`);
  }
  return parseManualSchedule(trimmed, config.TIMEZONE, new Date());
}
