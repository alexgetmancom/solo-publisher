import { unsafeDb } from "../../../apps/backend/src/db/client.js";
import { addEnglish, newPost, RU_CHANNELS, TEXT_CHANNELS } from "./cases-post.ts";
import { ADMIN, type Case, DEPLOY_AGENT_URL, FIXTURE, fileDownload, type Harness, setHttp, textOf, untilCall } from "./harness.ts";

const RELEASE = "0123456789abcdef0123456789abcdef01234567";
const PREVIOUS = "fedcba9876543210fedcba9876543210fedcba98";

/** The message the deploy agent posts into the operator's chat (deploy/deploy-agent.ts):
 * plain text, its own two hard-coded buttons. The bot does not send it. */
function agentMessage(h: Harness): number {
  const message = h.telegram.inject(ADMIN, `Deploy alex ${RELEASE.slice(0, 12)} successful and healthy.`, {
    inline_keyboard: [
      [{ text: "Откатить alex", callback_data: `deploy_rb_ask:alex:${RELEASE}` }],
      [{ text: "Раскатить maru", callback_data: `deploy_pr_ask:maru:${RELEASE}` }],
    ],
  });
  h.note(`The deploy agent's message "Deploy alex ${RELEASE.slice(0, 12)} successful and healthy." with its two buttons is in the chat.`);
  return message.message_id;
}

/** Answers the deploy agent's POST /v1/<action>/<target>. */
function agentAnswers(h: Harness, status: number, body: Record<string, unknown>): void {
  h.note(`The deploy agent answers ${status} ${JSON.stringify(body)}.`);
  setHttp((url) => (url.startsWith(DEPLOY_AGENT_URL) ? Response.json(body, { status }) : fileDownload(url)));
}

const deployOutcome = untilCall("the deploy outcome edit", (call) => call.method === "editMessageText" && !textOf(call).startsWith("⏳"));

/** Marks the draft's Story cards rendered, the state the Story worker leaves:
 * status ready with a local image. */
function renderStoryCards(h: Harness, draftId: number): void {
  unsafeDb(h.backendDb)
    .sqlite.prepare("UPDATE draft_story_cards SET status='ready', local_path=?, updated_at=? WHERE draft_id=?")
    .run(FIXTURE.photo, new Date().toISOString(), draftId);
  h.note(`Story cards of draft ${draftId} rendered (status ready, local_path = the 1x1 JPEG fixture).`);
}

const STORY_CHANNELS = ["telegram", "telegram_stories", "threads_ru"] as const;

export const OPS_CASES: Case[] = [
  {
    id: "deploy-promote",
    area: "deploy",
    specRef: "§10 #83, #84, #85; §4.12 deploy_pr_ask, deploy_promote, deploy_menu",
    channels: RU_CHANNELS,
    run: async (h) => {
      const message = agentMessage(h);
      await h.callback(`deploy_pr_ask:maru:${RELEASE}`, { messageId: message });
      await h.tapData(`deploy_menu:${RELEASE}`);
      await h.tapData(`deploy_pr_ask:maru:${RELEASE}`);
      agentAnswers(h, 200, { ok: true, release: RELEASE, currentRevision: RELEASE });
      await h.tapData(`deploy_promote:maru:${RELEASE}`, { until: deployOutcome });
    },
  },
  {
    id: "deploy-rollback-failed",
    area: "deploy",
    specRef: "§10 #83, #84, #85; §4.12 deploy_rb_ask, deploy_rollback (failure)",
    channels: RU_CHANNELS,
    run: async (h) => {
      const message = agentMessage(h);
      await h.callback(`deploy_rb_ask:alex:${RELEASE}`, { messageId: message });
      agentAnswers(h, 409, { ok: false, message: `No previous release to roll back to (current ${PREVIOUS.slice(0, 12)}).` });
      await h.tapData(`deploy_rollback:alex:${RELEASE}`, { until: deployOutcome });
    },
  },
  {
    id: "deploy-invalid",
    area: "deploy",
    specRef: "§4.12 validation → Unknown action",
    channels: RU_CHANNELS,
    run: async (h) => {
      const message = agentMessage(h);
      await h.callback("deploy_pr_ask:Production:0123", { messageId: message });
      await h.callback("deploy_menu:not-a-revision", { messageId: message });
    },
  },
  {
    id: "story-choice-publish",
    area: "post",
    specRef: "§10 #39 (publish); §6.3.2; §5.2.2 story_publish_all",
    channels: STORY_CHANNELS,
    run: async (h) => {
      await newPost(h);
      renderStoryCards(h, 1);
      await h.tapData("p:post:publish:1");
      await h.tapData("p:post:story_publish_all:1");
    },
  },
  {
    id: "story-choice-schedule",
    area: "post",
    specRef: "§10 #39 (schedule); §6.3.2; §5.2.2 story_schedule_site",
    channels: STORY_CHANNELS,
    run: async (h) => {
      await newPost(h);
      renderStoryCards(h, 1);
      await h.tapData("p:post:schedule:1");
      await h.tapData("p:post:story_schedule_site:1");
    },
  },
  {
    id: "story-cards-wait",
    area: "post",
    specRef: "§10 #39; §6.3.2 cards still rendering → follow-up when ready; §5.2.2 story_publish_site",
    channels: STORY_CHANNELS,
    run: async (h) => {
      await newPost(h);
      await h.tapData("p:post:publish:1");
      await h.trigger(
        "Story worker finishes the cards while the bot waits",
        () => renderStoryCards(h, 1),
        untilCall(
          "the Story-card question",
          (call) => call.method === "sendMessage" && JSON.stringify(call.payload).includes("story_publish_all"),
        ),
      );
      await h.tapData("p:post:story_publish_site:1");
    },
  },
  {
    id: "story-cards-timeout",
    area: "post",
    specRef: "§10 #40; §6.3.2 60 s timeout",
    channels: STORY_CHANNELS,
    run: async (h) => {
      await newPost(h);
      h.fastStoryWait();
      await h.tapData("p:post:publish:1", {
        until: untilCall(
          "the Story-card timeout message",
          (call) => call.method === "sendMessage" && JSON.stringify(call.payload).includes("p:post:view:1:overview"),
        ),
      });
    },
  },
  {
    id: "post-previews-with-media",
    area: "post",
    specRef: "§10 #66; §7.6 delivery previews with media",
    channels: TEXT_CHANNELS,
    run: async (h) => {
      await h.text("📝 Текст");
      await h.photo("preview-photo", "Пост с фотографией");
      await addEnglish(h);
      await h.tapData("p:post:publish:1");
    },
  },
];
