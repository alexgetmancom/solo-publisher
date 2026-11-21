import type { TestChannelId } from "../../../apps/backend/tests/helpers/channels.js";
import type { Case, Harness } from "./harness.ts";

/** A text Studio without Story targets: the publish and schedule screens are
 * reached without the Story-card question (that question has its own cases). */
export const TEXT_CHANNELS: readonly TestChannelId[] = ["telegram", "site_ru", "site_en", "threads_ru", "threads_en", "x", "discord"];
/** A Studio that publishes Russian only. */
export const RU_CHANNELS: readonly TestChannelId[] = ["telegram", "threads_ru"];

/** Opens 📝 Text and sends the post text: the draft card is the last message. */
export async function newPost(h: Harness, text = "Первый пост\n\nНемного текста о запуске."): Promise<void> {
  await h.text("📝 Текст");
  await h.text(text);
}

/** Gives draft `id` its English text through Edit EN. */
export async function addEnglish(h: Harness, id = 1, text = "First post\n\nA few words about the launch."): Promise<void> {
  await h.tapData(`p:post:edit_en:${id}`);
  await h.text(text);
}

export const POST_CASES: Case[] = [
  {
    id: "post-card-overview",
    area: "post",
    specRef: "§10 #13; §4.5.1; §6.1.3",
    channels: TEXT_CHANNELS,
    run: async (h) => {
      await newPost(h);
      await addEnglish(h);
    },
  },
  {
    id: "post-card-overview-ru-only",
    area: "post",
    specRef: "§10 #13 (RU-only Studio); §4.5.1",
    channels: RU_CHANNELS,
    run: async (h) => {
      await newPost(h);
    },
  },
  {
    id: "post-platforms",
    area: "post",
    specRef: "§10 #16; §4.5.4; §5.2.2 toggle",
    channels: TEXT_CHANNELS,
    run: async (h) => {
      await newPost(h);
      await h.tapData("p:post:view:1:platforms");
      await h.tapData("p:post:toggle:1:x");
      await h.tapData("p:post:toggle:1:threads_ru");
      await h.tapData("p:post:view:1:overview");
    },
  },
  {
    id: "post-cycle-mode",
    area: "post",
    specRef: "§10 #13; §5.2.2 cycle_mode",
    channels: TEXT_CHANNELS,
    run: async (h) => {
      await newPost(h);
      for (let index = 0; index < 5; index += 1) await h.tapData("p:post:cycle_mode:1");
    },
  },
  {
    id: "post-edit-ru",
    area: "post",
    specRef: "§10 #29; §5.2.2 edit_ru; §6.2 edit_text",
    channels: TEXT_CHANNELS,
    run: async (h) => {
      await newPost(h);
      await h.tapData("p:post:edit_ru:1");
      await h.text("Исправленный пост *с разметкой* и [ссылкой]");
    },
  },
  {
    id: "post-edit-cancel",
    area: "post",
    specRef: "§10 #29; §5.2.2 cancel_dialog",
    channels: TEXT_CHANNELS,
    run: async (h) => {
      await newPost(h);
      await h.tapData("p:post:edit_ru:1");
      await h.tapData(/^sv\d+\|p:post:cancel_dialog$/);
    },
  },
  {
    id: "post-schedule-chooser",
    area: "post",
    specRef: "§10 #17 (EN served); §4.5.5",
    channels: TEXT_CHANNELS,
    run: async (h) => {
      await newPost(h);
      await addEnglish(h);
      await h.tapData("p:post:schedule:1");
      await h.tapData("p:post:view:1:overview");
    },
  },
  {
    id: "post-schedule-chooser-ru-only",
    area: "post",
    specRef: "§10 #17 (RU only); §4.5.5",
    channels: RU_CHANNELS,
    run: async (h) => {
      await newPost(h);
      await h.tapData("p:post:schedule:1");
    },
  },
  {
    id: "post-slot-grids",
    area: "post",
    specRef: "§10 #19-#23; §4.5.6",
    channels: TEXT_CHANNELS,
    run: async (h) => {
      await newPost(h);
      await addEnglish(h);
      await h.tapData("p:post:schedule:1");
      await h.tapData("p:post:sched_scope:1:both");
      await h.tapData("p:post:view:1:schedule_ru_day");
      await h.tapData("p:post:view:1:schedule_ru");
      await h.tapData("p:post:view:1:schedule_ru_evening");
      await h.tapData("p:post:view:1:schedule_ru");
      await h.tapData("p:post:sched_pick:1:ru:0900");
      await h.tapData("p:post:view:1:schedule_en_us");
      await h.tapData("p:post:view:1:schedule_en");
      await h.tapData("p:post:view:1:overview");
    },
  },
  {
    id: "post-schedule-both-slots",
    area: "post",
    specRef: "§10 #14, #18; §6.3.3 commit hand-off; §4.5.2; §4.5.5 change time",
    channels: TEXT_CHANNELS,
    run: async (h) => {
      await newPost(h);
      await addEnglish(h);
      await h.tapData("p:post:schedule:1");
      await h.tapData("p:post:sched_scope:1:both");
      await h.tapData("p:post:sched_pick:1:ru:1000");
      await h.tapData("p:post:sched_pick:1:en:2100");
      await h.tapData("p:post:schedule:1");
      await h.tapData("p:post:view:1:schedule_en");
    },
  },
  {
    id: "post-schedule-ru-now",
    area: "post",
    specRef: "§5.2.2 sched_scope ru_now; §6.3.3",
    channels: TEXT_CHANNELS,
    run: async (h) => {
      await newPost(h);
      await addEnglish(h);
      await h.tapData("p:post:schedule:1");
      await h.tapData("p:post:sched_scope:1:ru_now");
      await h.tapData("p:post:sched_pick:1:en:2000");
    },
  },
  {
    id: "post-schedule-manual",
    area: "post",
    specRef: "§10 #32, #33, #34; §5.2.2 sched_manual, sched_confirm; §6.2 schedule_manual; §7.6",
    channels: TEXT_CHANNELS,
    run: async (h) => {
      await newPost(h);
      await addEnglish(h);
      await h.tapData("p:post:schedule:1");
      await h.tapData("p:post:sched_scope:1:both");
      await h.tapData("p:post:sched_manual:1:ru");
      await h.text("завтра утром");
      await h.text("01.01.2020 10:00");
      await h.text("21.08 15:30");
      await h.tapData(/^sv\d+\|p:post:sched_confirm:1$/);
    },
  },
  {
    id: "post-schedule-manual-errors",
    area: "post",
    specRef: "§10 #34; §6.2 schedule_manual errors",
    channels: RU_CHANNELS,
    run: async (h) => {
      await newPost(h);
      await h.tapData("p:post:schedule:1");
      await h.tapData("p:post:view:1:schedule_ru");
      await h.tapData("p:post:sched_manual:1:ru");
      await h.text("10:00 19.08");
      await h.text("19.08 10:00");
      await h.text("20.08.2026 08:00");
      await h.text("30.10.2026 10:00");
      await h.text("8:15");
      await h.tapData(/^sv\d+\|p:post:view:1:schedule_ru$/);
    },
  },
  {
    id: "post-confirm-publish",
    area: "post",
    specRef: "§10 #24, #41, #42; §4.5.7; §6.3.2 queue now; §7.6 previews",
    channels: TEXT_CHANNELS,
    run: async (h) => {
      await newPost(h);
      await addEnglish(h);
      await h.tapData("p:post:publish:1");
      await h.tapData("p:post:publish_confirm:1");
      await h.tapData("progress_details:1");
      await h.tapData("progress:1");
    },
  },
  {
    id: "post-progress-cancel",
    area: "post",
    specRef: "§10 #42, #43; §4.6 progress_cancel, progress_cancel_confirm",
    channels: TEXT_CHANNELS,
    run: async (h) => {
      await newPost(h);
      await addEnglish(h);
      await h.tapData("p:post:publish:1");
      await h.tapData("p:post:publish_confirm:1");
      await h.tapData("progress_cancel:1");
      await h.tapData("progress:1");
      await h.tapData("progress_cancel:1");
      await h.tapData("progress_cancel_confirm:1");
    },
  },
  {
    id: "post-delete",
    area: "post",
    specRef: "§10 #25, #44; §4.5.8 confirm_delete; §5.2.2 cancel_confirm",
    channels: TEXT_CHANNELS,
    run: async (h) => {
      await newPost(h);
      await h.tapData("p:post:cancel:1:confirm_delete");
      await h.tapData("p:post:view:1:overview");
      await h.tapData("p:post:cancel:1:confirm_delete");
      await h.tapData("p:post:cancel_confirm:1");
      await h.tapData("queue_home");
    },
  },
  {
    id: "post-cancel-scheduled",
    area: "post",
    specRef: "§10 #26, #44; §4.5.8 confirm_cancel",
    channels: RU_CHANNELS,
    run: async (h) => {
      await newPost(h);
      await h.tapData("p:post:schedule:1");
      await h.tapData("p:post:view:1:schedule_ru");
      await h.tapData("p:post:sched_pick:1:ru:1000");
      await h.tapData("p:post:cancel:1:confirm_cancel");
      await h.tapData("p:post:cancel_confirm:1");
    },
  },
  {
    id: "post-thread",
    area: "post",
    specRef: "§10 #28, #30, #31; §4.5.10; §5.2.2 thread_add, thread_done, thread_edit, thread_remove; §6.2 thread_part, thread_edit",
    channels: TEXT_CHANNELS,
    run: async (h) => {
      await newPost(h);
      await h.tapData("p:post:thread_add:1");
      await h.text("Второй пост цепочки");
      await h.tapData("p:post:thread_add:1");
      await h.photo("thread-photo", "Третий пост с фото");
      await h.tapData("p:post:thread_done:1");
      await h.tapData("p:post:thread_edit:1:2:ru");
      await h.text("Второй пост, исправленный");
      await h.tapData("p:post:thread_edit:1:2:en");
      await h.text("Second post in English");
      await h.tapData("p:post:thread_remove:1:3:ru");
      await h.tapData("p:post:thread_remove:1:2:ru");
    },
  },
  {
    id: "post-preflight-thread-offer",
    area: "post",
    specRef: "§10 #38; §6.3.1; §5.2.2 make_thread",
    channels: ["telegram"],
    run: async (h) => {
      // Over 900 characters, so the intake asks what it is; a photo added
      // afterwards turns the Telegram text limit into the 1024-character caption one.
      const paragraph = "Длинный абзац о том, как устроена публикация в нескольких сетях сразу и почему это важно. ";
      await h.text("📝 Текст");
      await h.text(paragraph.repeat(16).trim());
      await h.tapData("intake_kind:post");
      await h.tapData("p:post:edit_ru:1");
      await h.photo("preflight-photo");
      await h.tapData("p:post:publish:1");
      await h.tapData(/p:post:make_thread:1$/);
    },
  },
  {
    id: "post-preflight-toast",
    area: "post",
    specRef: "§10 #93 (error toast); §6.3.1 preflight toast",
    channels: TEXT_CHANNELS,
    run: async (h) => {
      await newPost(h);
      await h.tapData("p:post:publish:1");
    },
  },
];
