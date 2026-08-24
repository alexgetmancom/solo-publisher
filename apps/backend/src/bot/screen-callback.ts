import { StudioError } from "../foundation/errors.js";

/** Every button in the bot that is not a publication control, and what it
 * carries.
 *
 * A publication control already declares itself in the action registry, which
 * is why nothing there can be emitted with the wrong arguments, handled twice,
 * or handled by nobody. The screens did not: their callbacks were bare strings
 * matched by prefix, and that is where every unreachable screen, dead branch
 * and silently unanswered tap in this bot has come from. One declaration per
 * button, checked when it is built and again when it is read. */
export const SCREEN_ARGUMENTS = {
  /** A label that only shows where you are, such as "2/5" under a listing.
   * Telegram needs callback data on every text button, so the do-nothing one
   * is named once instead of per screen. */
  noop: [],
  menu_home: [],
  queue_home: [],
  queue_page: ["page"],
  queue_attention: [],
  queue_attention_page: ["page"],
  analytics_home: [],
  analytics_section: ["section", "days"],
  analytics_milestones: ["offset"],
  archive_home: [],
  analytics_archive: ["offset"],
  analytics_post_archive: ["offset"],
  analytics_video: ["id"],
  analytics_post: ["id"],
  analytics_post_media: ["id"],
  progress: ["draft"],
  progress_details: ["draft"],
  progress_cancel: ["draft"],
  delivery_preview_threads: ["kind", "id"],
  stream_home: [],
  stream_field: ["field"],
  intake_kind: ["choice"],
  intake_locale: ["locale"],
  intake_cancel: [],
  deploy_menu: ["revision"],
  deploy_rb_ask: ["target", "revision"],
  deploy_pr_ask: ["target", "revision"],
  deploy_rollback: ["target", "revision"],
  deploy_promote: ["target", "revision"],
} as const satisfies Record<string, readonly string[]>;

export type ScreenId = keyof typeof SCREEN_ARGUMENTS;

export type ScreenCallback = { id: ScreenId; args: Record<string, string> };

const SCREEN_IDS = new Set<string>(Object.keys(SCREEN_ARGUMENTS));

/** Builds one screen button's callback data. The arity is checked here, so a
 * button that would arrive unreadable fails where it is written instead. */
export function screenCallback<Id extends ScreenId>(id: Id, args: readonly (string | number)[] = []): string {
  const declared = SCREEN_ARGUMENTS[id] as readonly string[];
  if (args.length !== declared.length)
    throw new StudioError("action.invalid-callback-argument", { detail: `${id} takes ${declared.length} arguments` });
  const values = args.map(String);
  // ":" separates arguments, so one inside a value would arrive as two.
  if (values.some((value) => value.includes(":") || value === ""))
    throw new StudioError("action.invalid-callback-argument", { detail: id });
  return [id, ...values].join(":");
}

/** Reads a screen button, or null when the data is not one: an unknown name, or
 * a known one carrying arguments it never declared. */
export function parseScreenCallback(data: string): ScreenCallback | null {
  const [id, ...values] = data.split(":");
  if (!id || !SCREEN_IDS.has(id)) return null;
  const screenId = id as ScreenId;
  const declared = SCREEN_ARGUMENTS[screenId] as readonly string[];
  if (values.length !== declared.length) return null;
  return { id: screenId, args: Object.fromEntries(declared.map((name, index) => [name, values[index] ?? ""])) };
}

/** A counting argument (a page, an offset, a row id) as a number, or null when
 * the tap carried something else. Callback data is attacker-controlled text. */
export function screenNumber(value: string | undefined, { min = 0 } = {}): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min ? parsed : null;
}
