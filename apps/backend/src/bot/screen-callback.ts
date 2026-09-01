import { StudioError } from "../foundation/errors.js";

/** Every button in the bot that is not a publication control, and what it
 * carries.
 *
 * A publication control already declares itself in the action registry, which
 * is why nothing there can be emitted with the wrong arguments, handled twice,
 * or handled by nobody. The screens did not: their callbacks were bare strings
 * matched by prefix, and that is where every unreachable screen, dead branch
 * and silently unanswered tap in this bot has come from. One declaration per
 * button, checked when it is built and again when it is read.
 *
 * `supersedable` says whether a newer tap on the same button makes this one
 * redundant. A listing, a page, a section, a period: whatever the older tap
 * would have drawn, the newer one draws over, and whatever it would have
 * written, the newer one writes again. Those may be dropped while they wait
 * their turn, which is what turns a burst of taps through the queue from one
 * round trip each into one round trip. A toggle is not supersedable -- two
 * taps on two targets are two changes, not one -- and neither is anything that
 * sends, prompts or acts. */
export const SCREEN_BUTTONS = {
  /** A label that only shows where you are, such as "2/5" under a listing.
   * Telegram needs callback data on every text button, so the do-nothing one
   * is named once instead of per screen. */
  noop: { args: [], supersedable: true },
  menu_home: { args: [], supersedable: true },
  queue_home: { args: [], supersedable: true },
  queue_page: { args: ["page"], supersedable: true },
  queue_attention: { args: [], supersedable: true },
  queue_attention_page: { args: ["page"], supersedable: true },
  analytics_home: { args: [], supersedable: true },
  analytics_section: { args: ["section", "days"], supersedable: true },
  analytics_milestones: { args: ["offset"], supersedable: true },
  archive_home: { args: [], supersedable: true },
  analytics_archive: { args: ["offset"], supersedable: true },
  analytics_post_archive: { args: ["offset"], supersedable: true },
  analytics_video: { args: ["id"], supersedable: true },
  analytics_post: { args: ["id"], supersedable: true },
  analytics_post_media: { args: ["id"], supersedable: false },
  progress: { args: ["draft"], supersedable: true },
  progress_details: { args: ["draft"], supersedable: true },
  progress_cancel: { args: ["draft"], supersedable: false },
  delivery_preview_threads: { args: ["kind", "id"], supersedable: false },
  delivery_preview_video: { args: ["id"], supersedable: false },
  stream_home: { args: [], supersedable: true },
  stream_field: { args: ["field"], supersedable: false },
  intake_kind: { args: ["choice"], supersedable: false },
  intake_locale: { args: ["locale"], supersedable: false },
  intake_target: { args: ["target"], supersedable: false },
  intake_cancel: { args: [], supersedable: false },
  deploy_menu: { args: ["revision"], supersedable: false },
  deploy_rb_ask: { args: ["target", "revision"], supersedable: false },
  deploy_pr_ask: { args: ["target", "revision"], supersedable: false },
  deploy_rollback: { args: ["target", "revision"], supersedable: false },
  deploy_promote: { args: ["target", "revision"], supersedable: false },
} as const satisfies Record<string, { args: readonly string[]; supersedable: boolean }>;

export type ScreenId = keyof typeof SCREEN_BUTTONS;

export type ScreenCallback = { id: ScreenId; args: Record<string, string> };

const SCREEN_IDS = new Set<string>(Object.keys(SCREEN_BUTTONS));

/** Builds one screen button's callback data. The arity is checked here, so a
 * button that would arrive unreadable fails where it is written instead. */
export function screenCallback<Id extends ScreenId>(id: Id, args: readonly (string | number)[] = []): string {
  const declared = SCREEN_BUTTONS[id].args as readonly string[];
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
  const declared = SCREEN_BUTTONS[screenId].args as readonly string[];
  if (values.length !== declared.length) return null;
  return { id: screenId, args: Object.fromEntries(declared.map((name, index) => [name, values[index] ?? ""])) };
}

/** The button a tap belongs to when a newer tap on the same button would make
 * it redundant, and null otherwise. The id is the grouping: a tap is superseded
 * only by another tap on the same button of the same message, so the newer one
 * is known to do everything the older would have. */
export function supersedableScreen(data: string): ScreenId | null {
  const callback = parseScreenCallback(data);
  return callback && SCREEN_BUTTONS[callback.id].supersedable ? callback.id : null;
}

/** A counting argument (a page, an offset, a row id) as a number, or null when
 * the tap carried something else. Callback data is attacker-controlled text. */
export function screenNumber(value: string | undefined, { min = 0 } = {}): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min ? parsed : null;
}
