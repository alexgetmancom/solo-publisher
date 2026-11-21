import { TelegramClient } from "@mtcute/bun";
import type { StoryCredentials } from "./send.js";

/** The Stories account from `TELEGRAM_CHANNEL_STORIES_*`, the same variables
 * the Studio reads; null when any is unset (blank counts as unset). */
export function storyCredentials(env: Record<string, string | undefined>): StoryCredentials | null {
  const value = (name: string): string | undefined => env[name]?.trim() || undefined;
  const apiIdText = value("TELEGRAM_CHANNEL_STORIES_API_ID");
  const apiHash = value("TELEGRAM_CHANNEL_STORIES_API_HASH");
  const session = value("TELEGRAM_CHANNEL_STORIES_SESSION");
  if (!apiIdText || !apiHash || !session) return null;
  const apiId = Number(apiIdText);
  if (!Number.isSafeInteger(apiId) || apiId <= 0) throw new Error("TELEGRAM_CHANNEL_STORIES_API_ID must be a positive integer");
  return { apiId, apiHash, session };
}

/** A user client on the session directory; updates are never consumed. */
export function createStoryClient(credentials: StoryCredentials): TelegramClient {
  return new TelegramClient({ apiId: credentials.apiId, apiHash: credentials.apiHash, storage: credentials.session, disableUpdates: true });
}
