import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { BackendConfig } from "../config.js";
import { requestJson } from "../http.js";
import { recordTapTelegramCall } from "../tap-measurement.js";

const TELEGRAM_DOWNLOAD_TIMEOUT_MS = 300_000;

type TelegramFileResponse = { ok?: boolean; result?: { file_path?: string } };

type TelegramFileSource = { fileId: string; filePath?: never; token?: string } | { fileId?: never; filePath: string; token?: string };

/** Materializes one Telegram file into a caller-owned path, or into the bounded
 * incoming directory when the caller intends to import and discard it. */
export async function materializeTelegramFile(
  config: BackendConfig,
  source: TelegramFileSource,
  options: { target?: string; extension?: string; fetchImpl?: typeof fetch } = {},
): Promise<{ path: string; temporary: boolean }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const token = source.token || config.controllerBotToken;
  if (!token) throw new Error("Telegram bot token is not configured.");
  const filePath = source.filePath ?? (await telegramFilePath(config, source.fileId, token, fetchImpl));
  if (path.isAbsolute(filePath) && !options.target) return { path: filePath, temporary: false };

  const target =
    options.target ??
    path.join(config.STUDIO_MEDIA_DIR, ".incoming", `telegram-media-${crypto.randomUUID()}${options.extension ?? path.extname(filePath)}`);
  // Materialising the file is a Telegram call the Bot API transformer never
  // sees: it goes to the file endpoint, not to a method, and the bytes land on
  // disk after the response resolves. A 62 MB video arrived as 1.4 s that
  // belonged to no half of the account, and the only way to attribute it was to
  // read the log line that happened to sit next to it. The clock starts after
  // the path is known, because resolving it is a `getFile` already counted.
  const startedAt = performance.now();
  try {
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    if (path.isAbsolute(filePath)) {
      await copyAtomically(filePath, target);
      return { path: target, temporary: options.target == null };
    }

    const base = config.TELEGRAM_API_BASE_URL.replace(/\/$/, "");
    let response: Response;
    try {
      response = await fetchImpl(`${base}/file/bot${token}/${filePath}`, {
        signal: AbortSignal.timeout(TELEGRAM_DOWNLOAD_TIMEOUT_MS),
      });
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError")
        throw new Error(`Telegram file download timed out after ${TELEGRAM_DOWNLOAD_TIMEOUT_MS / 1000}s.`);
      throw new Error("Telegram file download failed.", { cause: error });
    }
    if (!response.ok) throw new Error(`Telegram file download failed: ${response.status}`);
    await writeAtomically(target, response);
    return { path: target, temporary: options.target == null };
  } finally {
    recordTapTelegramCall("downloadFile", performance.now() - startedAt);
  }
}

async function telegramFilePath(config: BackendConfig, fileId: string, token: string, fetchImpl: typeof fetch): Promise<string> {
  const base = config.TELEGRAM_API_BASE_URL.replace(/\/$/, "");
  const info = await requestJson<TelegramFileResponse>(fetchImpl, `${base}/bot${token}/getFile`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file_id: fileId }),
  });
  const filePath = info.result?.file_path;
  if (!info.ok || !filePath) throw new Error(`Telegram getFile failed for ${fileId}`);
  return filePath;
}

async function copyAtomically(source: string, target: string): Promise<void> {
  const temporary = `${target}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    await fs.promises.copyFile(source, temporary);
    await fs.promises.rename(temporary, target);
  } finally {
    await fs.promises.rm(temporary, { force: true }).catch(() => {});
  }
}

async function writeAtomically(target: string, response: Response): Promise<void> {
  const temporary = `${target}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    await Bun.write(temporary, response);
    await fs.promises.rename(temporary, target);
  } finally {
    await fs.promises.rm(temporary, { force: true }).catch(() => {});
  }
}
