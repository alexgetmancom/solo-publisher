import type { Menu } from "@grammyjs/menu";
import { type Context, Keyboard } from "grammy";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { t } from "../foundation/i18n/index.js";
import type { StudioLocale } from "../foundation/locale.js";
import { truncateUnicode } from "../foundation/text.js";
import { formatZonedClock, zonedDayDistance } from "../foundation/time.js";
import { queueService, type StudioQueueActivity } from "../studio/services/queue.js";
import { settingsService } from "../studio/services/settings.js";
import { formatQueueTime } from "./queue-time.js";

/** Rendering the main menu, separated from building it.
 *
 * These two helpers used to live in navigation.ts next to `buildMainMenu`, which
 * put them behind that module's imports of every screen it can open — so a
 * screen needing nothing but the persistent keyboard had to import back into
 * navigation, and post-screen and settings each closed an import cycle.
 * Neither helper knows how the menu is assembled: `showMainMenu` takes the built
 * menu as an argument. */

export function persistentKeyboard(locale: StudioLocale = "en"): Keyboard {
  return new Keyboard().text(t(locale, "menu.button")).resized().persistent();
}

export async function showMainMenu(
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  mainMenu: Menu<Context>,
  edit = false,
): Promise<void> {
  const options = { reply_markup: mainMenu };
  const text = mainMenuText(backendDb, config, Number(ctx.from?.id));
  if (edit) await ctx.editMessageText(text, options);
  else await ctx.reply(text, options);
}

export function mainMenuText(backendDb: BackendDb, config: BackendConfig, actorId: number): string {
  const locale = settingsService(backendDb).locale(actorId);
  const timeZone = settingsService(backendDb).timeConfig(actorId, config).TIMEZONE;
  return renderMainMenuHeadline(queueService(backendDb, config).headline(actorId), locale, timeZone, backendDb.clock.now());
}

export function renderMainMenuHeadline(
  activity: { upcoming: StudioQueueActivity | null; published: StudioQueueActivity | null },
  locale: StudioLocale,
  timeZone: string,
  now: Date,
): string {
  const item = activity.upcoming ?? activity.published;
  if (!item) return t(locale, "menu.queue-empty");
  const prefix = activity.upcoming ? (activity.upcoming.overdue ? "⏰" : "⏭") : "✅";
  return `${prefix} ${headlineTime(item.time, now, locale, timeZone)} · ${headlineLabel(item.label)}`;
}

/** The headline says the time of one item, so today needs no name: it is what
 * the nearest queued publication almost always is, and the word costs the room
 * the label is short of. The queue list, which spans days, keeps the full form. */
function headlineTime(time: Date, now: Date, locale: StudioLocale, timeZone: string): string {
  if (zonedDayDistance(time, now, timeZone) === 0) return formatZonedClock(time, locale, timeZone);
  return formatQueueTime(time, now, locale, timeZone);
}

/** What the headline shows of the item itself.
 *
 * The kind icon is gone: the buttons directly under this line are the text and
 * video screens with those same two icons, so on the headline it only competed
 * with the status. The label's own leading emoji goes for the same reason --
 * posts here open with one, and beside the status marker it read as decoration
 * rather than as the state of the queue. */
function headlineLabel(value: string): string {
  const label = value.replace(/^\p{Extended_Pictographic}(\uFE0F|\p{Emoji_Modifier})*\s*/u, "").trim() || value;
  const limit = 20;
  if (Array.from(label).length <= limit) return label;
  // The line has to survive one row on a phone, and the status marker and the
  // time are spent before the label starts. Cutting mid-word looked like the
  // text had been damaged rather than shortened, so the cut falls back to the
  // last word that fits whole -- unless the first word alone overruns, which
  // leaves nothing to fall back to.
  const clipped = truncateUnicode(label, limit);
  // A cut that already lands on a word boundary keeps the word it just fitted.
  const whole = clipped.trimEnd().length < clipped.length || Array.from(label)[limit] === " ";
  const lastSpace = clipped.lastIndexOf(" ");
  const kept = whole || lastSpace <= 0 ? clipped.trimEnd() : clipped.slice(0, lastSpace);
  return `${kept}...`;
}
