import fs from "node:fs";
import { MtArgumentError, type TelegramClient, tl } from "@mtcute/bun";
import { type Answer, posted, refused, type StoryRequest } from "./contract.js";

/** The part of mtcute's client a Story needs; tests stand in for it. */
export type StoryClient = Pick<TelegramClient, "connect" | "getMe" | "sendStory" | "destroy">;

export type StoryCredentials = { apiId: number; apiHash: string; session: string };

export type Deadlines = { connectMs: number; identityMs: number; sendMs: number; destroyMs: number };

/** TypeScript's deadlines (`delivery/social/telegramStories.ts`). Their sum
 * stays under the Rust client's 200 s, so this side is the one that says what
 * timed out. */
const STORY_DEADLINES: Deadlines = { connectMs: 30_000, identityMs: 30_000, sendMs: 120_000, destroyMs: 5_000 };

class DeadlineError extends Error {}

async function within<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new DeadlineError(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

type SendStoryParams = Parameters<TelegramClient["sendStory"]>[0];

/** `telegramStoryUploadMedia` + `telegramStoryCaptionInput`, as mtcute wants
 * them. `file:` selects a filesystem upload: a bare string is a Bot API file
 * id to mtcute. Without width, height and duration mtcute writes zeros into
 * documentAttributeVideo, which `stories.sendStory` rejects as
 * MEDIA_FILE_INVALID. */
export function sendStoryParams(request: StoryRequest): SendStoryParams {
  const file = `file:${request.media.path}`;
  const media =
    request.media.type === "photo"
      ? { type: "photo" as const, file }
      : {
          type: "video" as const,
          file,
          width: request.media.width,
          height: request.media.height,
          duration: request.media.duration,
          supportsStreaming: request.media.supportsStreaming,
        };
  const { text, links } = request.caption;
  const caption = links.length
    ? {
        text,
        entities: links.map(
          (link): tl.TypeMessageEntity => ({ _: "messageEntityTextUrl", offset: link.offset, length: link.length, url: link.url }),
        ),
      }
    : text;
  return { peer: request.peer, media, caption, period: request.periodSeconds };
}

/** Did a failed `sendStory` leave the Story possibly posted? Telegram's own
 * refusal (an RPC error, the upload's included) and mtcute rejecting the
 * arguments before any request mean it did not; a deadline, a dropped
 * connection or anything unrecognised means it may have. */
const notSent = (error: unknown): boolean => tl.RpcError.is(error) || error instanceof MtArgumentError;

/** One Story: connect, load the account (mtcute must have its own peer cached
 * before resolving the channel), send, and always tear the client down. */
export async function sendStory(
  request: StoryRequest,
  credentials: StoryCredentials | null,
  createClient: (credentials: StoryCredentials) => StoryClient,
  deadlines: Deadlines = STORY_DEADLINES,
): Promise<Answer> {
  if (!credentials) return refused(503, "missing_channel_story_credentials", false);
  // mtcute would only find out inside sendStory, where an unrecognised error
  // has to count as "may have posted".
  if (!fs.statSync(request.media.path, { throwIfNoEntry: false })?.isFile())
    return refused(422, `story_media_missing: ${request.media.path}`, false);

  let client: StoryClient;
  try {
    client = createClient(credentials);
  } catch (error) {
    return refused(502, messageOf(error), false);
  }
  try {
    try {
      await within(client.connect(), deadlines.connectMs, "telegram_channel_story_connect_timeout");
      await within(client.getMe(), deadlines.identityMs, "telegram_channel_story_identity_timeout");
    } catch (error) {
      return refused(502, messageOf(error), false);
    }
    try {
      const story = await within(client.sendStory(sendStoryParams(request)), deadlines.sendMs, "telegram_channel_story_timeout");
      return posted(story.id);
    } catch (error) {
      if (notSent(error)) return refused(502, messageOf(error), false);
      return refused(error instanceof DeadlineError ? 504 : 500, messageOf(error), true);
    }
  } finally {
    // Teardown is best effort: a stalled socket close must not hold the answer.
    await within(client.destroy(), deadlines.destroyMs, "telegram_channel_story_destroy_timeout").catch(() => undefined);
  }
}
