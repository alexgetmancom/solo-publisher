import type { Bot } from "grammy";
import { candidateView } from "../../bot/radar-screen.js";
import type { BackendDb } from "../../db/client.js";
import { type RadarRunOptions, type RadarRunResult, runRadar } from "../../editorial/radar.js";
import { selectForDelivery } from "../../editorial/ranking.js";
import { markOffered, unofferedCandidates } from "../../editorial/store.js";
import type { BackendConfig } from "../../foundation/config.js";
import { t } from "../../foundation/i18n/index.js";
import { log } from "../../foundation/logger.js";
import { settingsService } from "../../studio/services/settings.js";

/** The radar's Telegram side: run the producers, then put a few findings in
 * front of the operator as answerable cards.
 *
 * How many arrive at once is the whole delivery policy. Ten did not get read;
 * three get answered, and the rest keep on the radar screen rather than being
 * pushed again tomorrow. */
const CARDS_PER_DELIVERY = 3;

export type RadarDeliveryResult = { runs: RadarRunResult[]; delivered: number };

/** One scheduled pass: the search, the archive read, and the cards. */
export async function sendDailyRadar(
  config: BackendConfig,
  backendDb: BackendDb,
  bot: Bot | null,
  now = new Date(),
  options: RadarRunOptions = {},
): Promise<RadarDeliveryResult> {
  if (!bot || config.CONTROLLER_ADMIN_IDS.length === 0) return { runs: [{ status: "disabled" }], delivered: 0 };
  const runs: RadarRunResult[] = [];
  for (const producer of ["news", "ideas"] as const) {
    const result = await runRadar(config, backendDb, producer, { ...options, now });
    runs.push(result);
    // Silence reads as "nothing happened today". Whatever went wrong, the
    // operator hears about it on the day it happened, with what the producer
    // actually said.
    if (result.status === "failed") await notifyFailure(config, backendDb, bot, producer, result.error);
  }
  const delivered = await deliverCards(config, backendDb, bot, now);
  return { runs, delivered };
}

/** Sends the findings worth an answer now, and remembers that it did. */
async function deliverCards(config: BackendConfig, backendDb: BackendDb, bot: Bot, now: Date): Promise<number> {
  const waiting = unofferedCandidates(backendDb, 20);
  if (waiting.length === 0) return 0;
  // The exploration slot moves with the day, so it is not the same rank every
  // time and the choice needs no stored counter.
  const chosen = selectForDelivery(waiting, CARDS_PER_DELIVERY, Math.floor(now.getTime() / 86_400_000));
  let delivered = 0;
  for (const actorId of config.CONTROLLER_ADMIN_IDS) {
    const locale = settingsService(backendDb).locale(actorId);
    for (const candidate of chosen) {
      const view = candidateView(candidate, locale);
      try {
        await bot.api.sendMessage(actorId, view.text, {
          parse_mode: "Markdown",
          reply_markup: view.keyboard,
          link_preview_options: { is_disabled: true },
        });
        delivered += 1;
      } catch (error) {
        log("warn", "radar card was not delivered", { actorId, candidate: candidate.id, error: String(error) });
      }
    }
  }
  if (delivered > 0)
    markOffered(
      backendDb,
      chosen.map((candidate) => candidate.id),
    );
  return delivered;
}

async function notifyFailure(config: BackendConfig, backendDb: BackendDb, bot: Bot, producer: string, error: string): Promise<void> {
  for (const actorId of config.CONTROLLER_ADMIN_IDS) {
    const locale = settingsService(backendDb).locale(actorId);
    try {
      await bot.api.sendMessage(actorId, t(locale, "radar.run-failed", { producer, error: error.slice(0, 1_000) }));
    } catch (notifyError) {
      log("warn", "radar failure notice was not delivered", { actorId, error: String(notifyError) });
    }
  }
}
