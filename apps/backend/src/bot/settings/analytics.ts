import fs from "node:fs";
import { Menu } from "@grammyjs/menu";
import type { Context } from "grammy";
import { importManualAnalytics, manualThreadsFollowers } from "../../analytics/import-manual-analytics.js";
import { importXAnalyticsCsv } from "../../analytics/import-x-csv.js";
import type { BackendDb } from "../../db/client.js";
import type { BackendConfig } from "../../foundation/config.js";
import { materializeTelegramFile } from "../../foundation/external/telegram-files.js";
import { t } from "../../foundation/i18n/index.js";
import type { StudioLocale } from "../../foundation/locale.js";
import { settingsService } from "../../studio/services/settings.js";
import { clearConversationState } from "../conversation-state.js";
import { showScreen } from "../effects.js";
import { askSettingsInput, settingsUpdate, THREADS_FOLLOWERS_MENU_ID, X_IMPORT_MENU_ID } from "./shared.js";

/** The two analytics screens. They used to hang off a category of their own,
 * which held nothing but them: a screen whose only job was to be passed through. */
export function buildAnalyticsMenus(backendDb: BackendDb, systemBody: (locale: StudioLocale) => string): Menu<Context>[] {
  const threadsFollowers = new Menu<Context>(THREADS_FOLLOWERS_MENU_ID, { autoAnswer: false }).dynamic((ctx, range) => {
    const actorId = Number(ctx.from?.id);
    const locale = settingsService(backendDb).locale(actorId);
    for (const account of ["ru", "en"] as const)
      range.text(t(locale, "settings.threads-edit", { account: account.toUpperCase() }), (ctx) =>
        askSettingsInput(
          ctx,
          backendDb,
          actorId,
          "threads_followers",
          threadsFollowers,
          t(locale, "settings.threads-ask", { account: account.toUpperCase() }),
          { account },
        ),
      );
    range.row().back(
      t(locale, "settings.back-to-system"),
      settingsUpdate({
        apply: () => clearConversationState(backendDb, actorId, "settings"),
        body: () => systemBody(locale),
        plainText: true,
      }),
    );
  });

  const xImport = new Menu<Context>(X_IMPORT_MENU_ID, { autoAnswer: false }).dynamic((ctx, range) => {
    const actorId = Number(ctx.from?.id);
    const locale = settingsService(backendDb).locale(actorId);
    range
      .text(t(locale, "settings.x-import-start"), (ctx) =>
        askSettingsInput(ctx, backendDb, actorId, "x_import", xImport, t(locale, "settings.x-import-ask")),
      )
      .row()
      .back(
        t(locale, "settings.back-to-system"),
        settingsUpdate({
          apply: () => clearConversationState(backendDb, actorId, "settings"),
          body: () => systemBody(locale),
          plainText: true,
        }),
      );
  });

  return [threadsFollowers, xImport];
}

/** The stored follower counts as both screens print them, unknown included. */
function followerCounts(backendDb: BackendDb, locale: StudioLocale): { ru: string; en: string } {
  const followers = manualThreadsFollowers(backendDb);
  const value = (count: number | null) => (count == null ? t(locale, "settings.threads-unknown") : String(count));
  return { ru: value(followers.ru), en: value(followers.en) };
}

export async function collectThreadsFollowers(
  ctx: Context,
  backendDb: BackendDb,
  actorId: number,
  text: string,
  settingsMenu: Menu<Context>,
  account: "ru" | "en",
): Promise<boolean> {
  const locale = settingsService(backendDb).locale(actorId);
  const count = Number(text.replace(/[\s,]/gu, ""));
  if (!Number.isSafeInteger(count) || count < 0) {
    await showScreen(ctx, t(locale, "err.threads-followers-invalid"));
    return true;
  }
  importManualAnalytics(backendDb, {
    sampledAt: messageSampledAt(ctx),
    ...(account === "ru" ? { threadsRuFollowers: count } : { threadsEnFollowers: count }),
  });
  await showScreen(ctx, t(locale, "settings.threads-saved", { account: account.toUpperCase(), count }));
  await showScreen(ctx, threadsFollowersText(backendDb, locale), {
    parse_mode: "Markdown",
    reply_markup: settingsMenu.at(THREADS_FOLLOWERS_MENU_ID),
  });
  return true;
}

export async function collectXAnalyticsCsv(
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  actorId: number,
  settingsMenu: Menu<Context>,
): Promise<boolean> {
  const locale = settingsService(backendDb).locale(actorId);
  const document = ctx.message && "document" in ctx.message ? ctx.message.document : undefined;
  if (!document) {
    await showScreen(ctx, t(locale, "settings.x-import-expects-file"));
    return true;
  }
  if (!/\.csv$/iu.test(document.file_name ?? "")) {
    await showScreen(ctx, t(locale, "settings.x-import-expects-file"));
    return true;
  }
  // Only once the file is the one being asked for: anything else leaves the
  // import waiting, exactly as a message with no document does.
  clearConversationState(backendDb, actorId, "settings");
  const apiFile = await ctx.api.getFile(document.file_id);
  if (!apiFile.file_path) {
    await showScreen(ctx, t(locale, "settings.x-import-failed", { error: "no file path" }));
    return true;
  }
  const downloaded = await materializeTelegramFile(config, { filePath: apiFile.file_path }, { extension: ".csv" });
  try {
    const result = importXAnalyticsCsv(backendDb, downloaded.path, messageSampledAt(ctx), document.file_name ?? undefined);
    await showScreen(
      ctx,
      result.duplicateImport
        ? t(locale, "settings.x-import-duplicate")
        : t(locale, "settings.x-import-done", {
            rows: result.rows,
            items: result.activityItems,
            linked: result.linkedByExternalId + result.linkedByText,
            samples: result.insertedSamples,
          }),
      { parse_mode: "Markdown", reply_markup: settingsMenu.at(X_IMPORT_MENU_ID) },
    );
  } catch (error) {
    await showScreen(ctx, t(locale, "settings.x-import-failed", { error: error instanceof Error ? error.message : String(error) }));
  } finally {
    if (downloaded.temporary) await fs.promises.rm(downloaded.path, { force: true });
  }
  return true;
}

export function threadsFollowersText(backendDb: BackendDb, locale: StudioLocale): string {
  return t(locale, "settings.threads-body", {
    ...followerCounts(backendDb, locale),
    updated: manualThreadsFollowers(backendDb).updatedAt?.slice(0, 16).replace("T", " ") ?? t(locale, "settings.threads-unknown"),
  });
}

function messageSampledAt(ctx: Context): string {
  const seconds = ctx.message?.date;
  return new Date(seconds ? seconds * 1000 : Date.now()).toISOString();
}
