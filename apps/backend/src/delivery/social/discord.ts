import fs from "node:fs";
import { splitText } from "../../content/text.js";
import type { BackendConfig } from "../../foundation/config.js";
import { externalFetch } from "../../foundation/http.js";
import { log } from "../../foundation/logger.js";
import type { PublishResult } from "../../publishing/errors.js";
import { httpPublishError, publishJson } from "../../publishing/errors.js";
import { platformProfile } from "../../publishing/platform-profiles.js";
import { ambiguousExternalMutation } from "../ambiguous-publication.js";
import { guessContentType, mediaExtension, payloadMedia, payloadText } from "./payload.js";

const DISCORD_API_BASE_URL = "https://discord.com/api/v10";

/** Discord accepts at most ten attachments on one message. */
const MAX_ATTACHMENTS = 10;

type DiscordMessage = { id?: string };

type DiscordCredentials = { token: string; channelId: string; guildId: string | null };

function discordCredentials(config: BackendConfig): DiscordCredentials {
  const missing = [config.DISCORD_BOT_TOKEN ? null : "DISCORD_BOT_TOKEN", config.DISCORD_CHANNEL_ID ? null : "DISCORD_CHANNEL_ID"].filter(
    (name): name is string => name !== null,
  );
  if (missing.length) throw new Error(`Discord is not configured: ${missing.join(", ")}`);
  return {
    token: config.DISCORD_BOT_TOKEN as string,
    channelId: config.DISCORD_CHANNEL_ID as string,
    guildId: config.DISCORD_GUILD_ID ?? null,
  };
}

/**
 * A post becomes one message per text part, with the media attached to the last
 * one so the picture sits under the text a reader has just finished. Every id is
 * returned: a two-part post is two objects to verify, edit or delete later.
 */
export async function publishToDiscord(
  payload: Record<string, unknown>,
  config: BackendConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<PublishResult> {
  const credentials = discordCredentials(config);
  const limit = platformProfile("discord")?.limits?.text ?? 2000;
  const parts = splitText(payloadText(payload), limit);
  const media = payloadMedia(payload)
    .filter((item) => item.localPath && fs.existsSync(item.localPath))
    .slice(0, MAX_ATTACHMENTS);

  const ids: string[] = [];
  for (const [index, part] of parts.entries()) {
    const last = index === parts.length - 1;
    const message = await createMessage(credentials, part, last ? media : [], fetchImpl);
    if (!message.id) throw new Error("Discord message create returned no id");
    ids.push(message.id);
    await crosspost(credentials, message.id, fetchImpl);
  }

  const first = ids[0] ?? null;
  return {
    ok: Boolean(first),
    id: first,
    ids,
    url: first ? messageUrl(credentials, first) : null,
  };
}

export async function verifyDiscordMessage(
  id: string,
  config: BackendConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<{ id: string; url: string | null }> {
  const credentials = discordCredentials(config);
  const response = await discordFetch(credentials, `/channels/${credentials.channelId}/messages/${encodeURIComponent(id)}`, fetchImpl, {
    method: "GET",
  });
  const message = await publishJson<DiscordMessage>(response, "Discord message verify");
  if (message.id !== id) throw new Error("Discord verification did not return the expected message");
  return { id, url: messageUrl(credentials, id) };
}

export async function deleteDiscordMessage(id: string, config: BackendConfig, fetchImpl: typeof fetch = fetch): Promise<void> {
  const credentials = discordCredentials(config);
  const response = await discordFetch(credentials, `/channels/${credentials.channelId}/messages/${encodeURIComponent(id)}`, fetchImpl, {
    method: "DELETE",
  });
  if (!response.ok) throw httpPublishError(response, await response.text(), "Discord message delete");
}

export async function editDiscordMessage(
  id: string,
  content: string,
  config: BackendConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
  const credentials = discordCredentials(config);
  const response = await discordFetch(credentials, `/channels/${credentials.channelId}/messages/${encodeURIComponent(id)}`, fetchImpl, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  return await publishJson<Record<string, unknown>>(response, "Discord message edit");
}

async function createMessage(
  credentials: DiscordCredentials,
  content: string,
  media: ReturnType<typeof payloadMedia>,
  fetchImpl: typeof fetch,
): Promise<DiscordMessage> {
  const path = `/channels/${credentials.channelId}/messages`;
  const init: RequestInit = media.length
    ? { method: "POST", body: attachmentForm(content, media) }
    : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content }) };
  const response = await ambiguousExternalMutation("discord", () => discordFetch(credentials, path, fetchImpl, init));
  return await publishJson<DiscordMessage>(response, "Discord message create");
}

/**
 * The channel is an announcement channel, so a message only reaches the servers
 * following it once it is published. That is a second call, and its failure is
 * deliberately not the publication's failure: the message is already in the
 * channel, and throwing here would retry the job and post it a second time.
 */
async function crosspost(credentials: DiscordCredentials, id: string, fetchImpl: typeof fetch): Promise<void> {
  const path = `/channels/${credentials.channelId}/messages/${encodeURIComponent(id)}/crosspost`;
  try {
    const response = await discordFetch(credentials, path, fetchImpl, { method: "POST" });
    if (!response.ok) throw httpPublishError(response, await response.text(), "Discord crosspost");
  } catch (error) {
    log("warn", "Discord crosspost failed", { messageId: id, channelId: credentials.channelId, error: String(error) });
  }
}

function attachmentForm(content: string, media: ReturnType<typeof payloadMedia>): FormData {
  const form = new FormData();
  form.set(
    "payload_json",
    JSON.stringify({
      content,
      attachments: media.map((item, index) => ({ id: index, filename: `media-${index}${mediaExtension(item)}` })),
    }),
  );
  for (const [index, item] of media.entries()) {
    const localPath = item.localPath as string;
    form.set(`files[${index}]`, Bun.file(localPath, { type: guessContentType(localPath) }), `media-${index}${mediaExtension(item)}`);
  }
  return form;
}

function messageUrl(credentials: DiscordCredentials, id: string): string | null {
  if (!credentials.guildId) return null;
  return `https://discord.com/channels/${credentials.guildId}/${credentials.channelId}/${id}`;
}

function discordFetch(credentials: DiscordCredentials, path: string, fetchImpl: typeof fetch, init: RequestInit): Promise<Response> {
  return externalFetch(fetchImpl, `${DISCORD_API_BASE_URL}${path}`, {
    ...init,
    headers: { ...init.headers, Authorization: `Bot ${credentials.token}` },
  });
}
