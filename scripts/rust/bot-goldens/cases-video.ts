import type { TestChannelId } from "../../../apps/backend/tests/helpers/channels.js";
import { type Case, FIXTURE, type Harness, textOf, untilCall } from "./harness.ts";

/** Both video platforms in both languages, nothing else. */
export const VIDEO_CHANNELS: readonly TestChannelId[] = ["youtube_ru", "youtube_en", "instagram_ru", "instagram_en"];

/** The background download has reported: the first screen after "⏳ Downloading". */
const downloaded = untilCall(
  "the video download outcome",
  (call) => (call.method === "editMessageText" || call.method === "sendMessage") && !textOf(call).startsWith("⏳"),
);

/** 🎬 Video → file → audience RU → downloaded: the wizard is at its first step. */
async function startVideo(h: Harness, source = FIXTURE.clip, fileId = "clip"): Promise<void> {
  await h.text("🎬 Видео");
  await h.video(fileId, source);
  await h.tapData("intake_locale:ru", { until: downloaded });
}

/** Walks the wizard from the script step to the schedule choice. */
async function fillMetadata(h: Harness): Promise<void> {
  await h.text("Сценарий: показываем, как пройти первый уровень.");
  await h.text("Первый уровень за минуту");
  await h.text("Короткое прохождение первого уровня.");
  await h.text("https:/store.steampowered.com/app/1");
  await h.text("игра, прохождение, shorts");
  await h.text("Проходим первый уровень #shorts");
}

/** A video draft through the whole wizard, scheduled at one slot for both platforms. */
export async function scheduledVideo(h: Harness): Promise<void> {
  await startVideo(h);
  await fillMetadata(h);
  await h.tapData(/^sv\d+\|p:video:common:1$/);
  await h.tapData(/^sv\d+\|p:video:sched_pick:1:youtube_shorts:1800$/);
  await h.tapData(/^sv\d+\|p:video:sched_confirm:1$/);
}

export const VIDEO_CASES: Case[] = [
  {
    id: "video-intake-destination",
    area: "video",
    specRef: "§10 #3, #8, #9, #10; §6.1.5, §6.1.6; §5.3 intake_target, intake_locale",
    channels: VIDEO_CHANNELS,
    run: async (h) => {
      await h.text("🎬 Видео");
      await h.video("clip", FIXTURE.clip);
      await h.tapData("intake_target:instagram_reels");
      await h.tapData("intake_target:youtube_shorts");
      await h.tapData("intake_target:instagram_reels");
      await h.tapData("intake_locale:en", { until: downloaded });
    },
  },
  {
    id: "video-intake-single-platform",
    area: "video",
    specRef: "§10 #8 (one connected platform: no toggles)",
    channels: ["youtube_ru"],
    run: async (h) => {
      await h.text("🎬 Видео");
      await h.video("clip", FIXTURE.clip);
    },
  },
  {
    id: "video-intake-rejects-text",
    area: "video",
    specRef: "§10 #4 (intake.need-video); §6.1.2",
    channels: VIDEO_CHANNELS,
    run: async (h) => {
      await h.text("🎬 Видео");
      await h.text("Это не видео");
      await h.send({
        sticker: { file_id: "sticker", file_unique_id: "s", type: "regular", width: 512, height: 512, is_animated: false, is_video: false },
      });
    },
  },
  {
    id: "video-download-failed",
    area: "video",
    specRef: "§10 #9 (download failed); §6.1.6 retry; §5.3 intake_download",
    channels: VIDEO_CHANNELS,
    run: async (h) => {
      await h.text("🎬 Видео");
      await h.video("clip", FIXTURE.clip);
      h.telegram.failures.set("getFile", [{ error_code: 400, description: "Bad Request: file is too big" }]);
      h.note("The first getFile answers 400 'Bad Request: file is too big' (not retried by the intake).");
      await h.tapData("intake_locale:ru", { until: downloaded });
      await h.tapData(/^intake_download:\d+:ru$/, { until: downloaded });
    },
  },
  {
    id: "video-download-cancel",
    area: "video",
    specRef: "§6.1.7 intake_download cancel; §5.3",
    channels: VIDEO_CHANNELS,
    run: async (h) => {
      await h.text("🎬 Видео");
      await h.video("clip", FIXTURE.clip);
      h.telegram.failures.set("getFile", [{ error_code: 400, description: "Bad Request: file is too big" }]);
      h.note("The first getFile answers 400 'Bad Request: file is too big'.");
      await h.tapData("intake_locale:ru", { until: downloaded });
      const retry = h.button(/^intake_download:\d+:ru$/, undefined, true);
      await h.tapData(/^intake_download:\d+:cancel$/);
      // The retry button of the screen the cancel replaced: the intake has expired.
      await h.callback(retry.data, { messageId: retry.messageId });
    },
  },
  {
    id: "video-wizard-common",
    area: "video",
    specRef: "§10 #54, #55, #57, #58, #60, #61, #65, #66; §6.4.2-§6.4.6; §5.3 delivery_preview_video",
    channels: VIDEO_CHANNELS,
    run: async (h) => {
      await startVideo(h);
      await fillMetadata(h);
      await h.tapData(/^sv\d+\|p:video:common:1$/);
      await h.tapData(/^sv\d+\|p:video:sched_pick:1:youtube_shorts:1800$/);
      await h.tapData("delivery_preview_video:1");
      await h.tapData(/^sv\d+\|p:video:sched_confirm:1$/);
    },
  },
  {
    id: "video-wizard-individual",
    area: "video",
    specRef: "§10 #57, #58, #59, #60; §6.4.4; §5.2.3 individual, sched_manual, sched_now",
    channels: VIDEO_CHANNELS,
    run: async (h) => {
      await startVideo(h);
      await fillMetadata(h);
      await h.tapData(/^sv\d+\|p:video:individual:1$/);
      await h.text("21.08 19:00");
      await h.tapData(/^sv\d+\|p:video:sched_manual:1$/);
      await h.text("никогда");
      await h.tapData(/^sv\d+\|p:video:sched_now:1$/);
      await h.tapData(/^sv\d+\|p:video:schedule:1$/);
      await h.tapData(/^sv\d+\|p:video:common:1$/);
      await h.text("22.08 20:15");
      await h.tapData(/^sv\d+\|p:video:sched_confirm:1$/);
    },
  },
  {
    id: "video-wizard-skip-back",
    area: "video",
    specRef: "§10 #55, #56, #62; §5.2.3 script_skip, game_skip, meta_back; §6.4.3",
    channels: VIDEO_CHANNELS,
    run: async (h) => {
      await startVideo(h);
      await h.photo("not-a-script");
      await h.tapData(/^sv\d+\|p:video:script_skip$/);
      await h.text("Т".repeat(101));
      await h.text("Заголовок для Shorts");
      await h.tapData(/^sv\d+\|p:video:meta_back$/);
      await h.text("Заголовок, второй вариант");
      await h.text("-");
      await h.tapData(/^sv\d+\|p:video:game_skip$/);
      await h.tapData(/^sv\d+\|p:video:meta_back$/);
      await h.tapData(/^sv\d+\|p:video:game_skip$/);
      await h.text("-");
      await h.text("-");
      await h.text("Сообщение на шаге с кнопками");
      await h.tapData(/^sv\d+\|p:video:cancel_dialog$/);
    },
  },
  {
    id: "video-wizard-cancel-before-draft",
    area: "video",
    specRef: "§10 #53; §6.4.1 length warning; §6.4.8 cancel_dialog without draft",
    channels: VIDEO_CHANNELS,
    run: async (h) => {
      await startVideo(h, FIXTURE.long, "long");
      await h.tapData(/^sv\d+\|p:video:cancel_dialog$/);
    },
  },
  {
    id: "video-length-ok",
    area: "video",
    specRef: "§10 #53; §5.2.3 length_ok",
    channels: VIDEO_CHANNELS,
    run: async (h) => {
      await startVideo(h, FIXTURE.long, "long");
      await h.tapData(/^sv\d+\|p:video:length_ok$/);
    },
  },
  {
    id: "video-length-replace",
    area: "video",
    specRef: "§6.4.1 a new file at the length warning replaces it (direct asset message)",
    channels: VIDEO_CHANNELS,
    run: async (h) => {
      await startVideo(h, FIXTURE.long, "long");
      await h.video("replacement", FIXTURE.clip);
      await h.send({
        document: { file_id: "not-video", file_unique_id: "nv", file_name: "notes.pdf", mime_type: "application/pdf", file_size: 10 },
      });
    },
  },
  {
    id: "video-music-aspect-warnings",
    area: "video",
    specRef: "§10 #52, #61 (not 9:16, no audio); §6.4.1; §6.4.6",
    channels: VIDEO_CHANNELS,
    run: async (h) => {
      await startVideo(h, FIXTURE.silent, "silent");
      await h.tapData(/^sv\d+\|p:video:script_skip$/);
      await h.text("Тихий ролик");
      await h.text("-");
      await h.tapData(/^sv\d+\|p:video:game_skip$/);
      await h.text("-");
      await h.text("-");
      await h.tapData(/^sv\d+\|p:video:common:1$/);
      await h.tapData(/^sv\d+\|p:video:sched_now:1$/);
      await h.tapData(/^sv\d+\|p:video:sched_confirm:1$/);
    },
  },
  {
    id: "video-card-actions",
    area: "video",
    specRef:
      "§10 #46, #47, #48, #49, #50, #51, #63; §4.7; §4.8; §5.2.3 edit_menu, edit_field, time, remove_ask, cancel, cancel_confirm, publish",
    channels: VIDEO_CHANNELS,
    run: async (h) => {
      await scheduledVideo(h);
      await h.tapData("p:video:edit_menu:1");
      await h.tapData("p:video:edit_field:1:youtube_title");
      await h.text("Первый уровень: новый заголовок");
      await h.tapData("p:video:edit_menu:1");
      await h.tapData("p:video:edit_field:1:youtube_tags");
      await h.text("игра, уровень");
      await h.tapData("p:video:time:1:instagram_reels");
      await h.text("23.08 11:00");
      await h.tapData(/^sv\d+\|p:video:sched_confirm:1$/);
      await h.tapData("p:video:cancel:1");
      await h.tapData("p:video:view:1:overview");
      await h.tapData("p:video:cancel:1");
      await h.tapData("p:video:cancel_confirm:1");
    },
  },
  {
    id: "video-card-draft-actions",
    area: "video",
    specRef: "§10 #46, #47, #49, #50, #51, #64; §5.2.3 publish, publish_confirm, remove_ask, remove, edit_media, edit_field script",
    channels: VIDEO_CHANNELS,
    run: async (h) => {
      await startVideo(h);
      await fillMetadata(h);
      await h.tapData(/^sv\d+\|p:video:cancel_dialog$/);
      await h.tapData("p:video:edit_menu:1");
      await h.tapData("p:video:edit_field:1:label");
      await h.text("Ролик про первый уровень");
      await h.tapData("p:video:edit_menu:1");
      await h.tapData("p:video:edit_field:1:script");
      await h.text("Новый сценарий");
      await h.tapData("p:video:edit_menu:1");
      await h.tapData("p:video:edit_media:1");
      await h.video("replacement", FIXTURE.clip);
      await h.tapData("p:video:remove_ask:1:instagram_reels");
      await h.tapData("p:video:view:1:overview");
      await h.tapData("p:video:remove_ask:1:instagram_reels");
      await h.tapData("p:video:remove:1:instagram_reels");
    },
  },
  {
    id: "video-publish-now",
    area: "video",
    specRef: "§10 #47, #61; §5.2.3 publish, publish_confirm; §11.10 unversioned confirm_now",
    channels: VIDEO_CHANNELS,
    run: async (h) => {
      await startVideo(h);
      await fillMetadata(h);
      await h.tapData(/^sv\d+\|p:video:cancel_dialog$/);
      const card = h.button("p:video:publish:1", undefined, true).messageId;
      // confirm_now reached without a revision renders a confirm button that is stale on arrival.
      await h.callback("p:video:view:1:confirm_now", { messageId: card });
      await h.tapData("p:video:publish_confirm:1");
      await h.tapData("p:video:view:1:overview");
      await h.tapData("p:video:publish:1");
      await h.tapData(/^sv\d+\|p:video:publish_confirm:1$/);
    },
  },
  {
    id: "video-remove-all",
    area: "video",
    specRef: "§10 #64; §5.2.3 remove (last platform)",
    channels: ["youtube_ru"],
    run: async (h) => {
      await startVideo(h);
      await h.tapData(/^sv\d+\|p:video:cancel_dialog$/);
      await h.tapData("p:video:remove_ask:1:youtube_shorts");
      await h.tapData("p:video:remove:1:youtube_shorts");
    },
  },
];
