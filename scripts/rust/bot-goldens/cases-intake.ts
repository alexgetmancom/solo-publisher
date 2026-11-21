import { finalizePendingAlbums } from "../../../apps/backend/src/bot/albums.js";
import { newPost, TEXT_CHANNELS } from "./cases-post.ts";
import { type Case, FIXTURE, type Harness } from "./harness.ts";

const LONG_TEXT = "Абзац о том, как устроена публикация в нескольких сетях сразу и почему это важно для автора. ".repeat(12).trim();

/** Runs one album-worker pass with the clock past the 4 s settle window. */
async function finalizeAlbums(h: Harness, seconds: number): Promise<void> {
  h.clock(new Date(Date.now() + seconds * 1000));
  await h.trigger(`album worker tick (+${seconds} s)`, () => finalizePendingAlbums(h.bot, h.backendDb, h.config));
}

export const INTAKE_CASES: Case[] = [
  {
    id: "intake-menu-buttons",
    area: "intake",
    specRef: "§10 #2, #3; §4.1 [📝 Text] [🎬 Video]; §4.2 intake_cancel",
    channels: TEXT_CHANNELS,
    run: async (h) => {
      await h.text("☰ Меню");
      await h.tap("📝 Текст");
      await h.tapData("intake_cancel");
      await h.tap("🎬 Видео");
      await h.tapData("intake_cancel");
    },
  },
  {
    id: "intake-unsupported",
    area: "intake",
    specRef: "§10 #4 (intake.unsupported); §6.1.2",
    channels: TEXT_CHANNELS,
    run: async (h) => {
      await h.text("📝 Текст");
      await h.send({
        sticker: { file_id: "sticker", file_unique_id: "s", type: "regular", width: 512, height: 512, is_animated: false, is_video: false },
      });
      await h.text("   ");
    },
  },
  {
    id: "intake-kind-choice",
    area: "intake",
    specRef: "§10 #5, #6 (asked: no 'rather post'); §6.1.2, §6.1.4",
    channels: TEXT_CHANNELS,
    run: async (h) => {
      await h.text("📝 Текст");
      await h.text(LONG_TEXT);
      await h.tapData("intake_kind:article");
      await h.tapData("intake_cancel");
    },
  },
  {
    id: "intake-kind-post",
    area: "intake",
    specRef: "§10 #5; §6.1.3 post from the choice",
    channels: TEXT_CHANNELS,
    run: async (h) => {
      await h.text("📝 Текст");
      await h.text(LONG_TEXT);
      await h.tapData("intake_kind:post");
    },
  },
  {
    id: "intake-markdown-article",
    area: "intake",
    specRef: "§10 #6, #7; §6.1.2 Markdown download; §6.1.4 article_confirm",
    channels: TEXT_CHANNELS,
    run: async (h) => {
      await h.text("📝 Текст");
      await h.document("article-md", FIXTURE.markdown, "article.md", "text/markdown");
      await h.tapData("intake_kind:article_confirm");
      await h.tapData("queue_home");
    },
  },
  {
    id: "intake-markdown-rather-post",
    area: "intake",
    specRef: "§10 #6 (decided: 'rather post' offered); §6.1.4",
    channels: TEXT_CHANNELS,
    run: async (h) => {
      await h.text("📝 Текст");
      await h.document("article-md", FIXTURE.markdown, "article.md", "text/markdown");
      await h.tapData("intake_kind:post");
    },
  },
  {
    id: "intake-text-entry-video",
    area: "intake",
    specRef: "§10 #4 (text entry never rejects, §11.4); §6.1.3 post carrying a video",
    channels: TEXT_CHANNELS,
    run: async (h) => {
      await h.text("📝 Текст");
      await h.video("text-entry-video", FIXTURE.clip, { caption: "Пост с видео" });
    },
  },
  {
    id: "intake-photo-large",
    area: "intake",
    specRef: "§10 #37 media-large advice; §6.1.3",
    channels: TEXT_CHANNELS,
    run: async (h) => {
      await h.text("📝 Текст");
      h.telegram.files.set("big-photo", FIXTURE.photo);
      await h.send({
        photo: [
          { file_id: "big-photo-small", file_unique_id: "bs", width: 90, height: 90, file_size: 1200 },
          { file_id: "big-photo", file_unique_id: "bl", width: 8000, height: 8000, file_size: 62_000_000 },
        ],
        caption: "Фото в полном разрешении",
      });
    },
  },
  {
    id: "post-need-new-post",
    area: "intake",
    specRef: "§10 #36; §6.2 no open step",
    channels: TEXT_CHANNELS,
    run: async (h) => {
      await h.text("Просто сообщение без открытого сценария");
      await h.text("/unknown");
    },
  },
  {
    id: "post-album",
    area: "intake",
    specRef: "§10 #35; §6.5 album collector → new draft",
    channels: TEXT_CHANNELS,
    run: async (h) => {
      await h.text("📝 Текст");
      await h.photo("album-1", "Альбом из двух фото", { media_group_id: "album-a" });
      await h.photo("album-2", undefined, { media_group_id: "album-a" });
      await finalizeAlbums(h, 5);
    },
  },
  {
    id: "post-album-edit",
    area: "intake",
    specRef: "§6.5 album into an open edit_text step",
    channels: TEXT_CHANNELS,
    run: async (h) => {
      await newPost(h);
      await h.tapData("p:post:edit_ru:1");
      await h.photo("edit-album-1", "Новая подпись альбома", { media_group_id: "album-b" });
      await h.photo("edit-album-2", undefined, { media_group_id: "album-b" });
      await finalizeAlbums(h, 5);
    },
  },
  {
    id: "post-album-thread-part",
    area: "intake",
    specRef: "§6.5 album as a thread part",
    channels: TEXT_CHANNELS,
    run: async (h) => {
      await newPost(h);
      await h.tapData("p:post:thread_add:1");
      await h.photo("part-album-1", "Часть треда альбомом", { media_group_id: "album-c" });
      await h.photo("part-album-2", undefined, { media_group_id: "album-c" });
      await finalizeAlbums(h, 5);
    },
  },
  {
    id: "post-album-give-up",
    area: "intake",
    specRef: "§10 #92; §6.5 attempts > 5",
    channels: TEXT_CHANNELS,
    run: async (h) => {
      await h.text("📝 Текст");
      await h.photo("broken-1", "Альбом, который не собрать", { media_group_id: "album-d" });
      await h.photo("broken-2", undefined, { media_group_id: "album-d" });
      // Telegram no longer serves the files: every import attempt fails.
      h.telegram.files.delete("broken-1");
      h.telegram.files.delete("broken-2");
      h.note("After both album items arrive, getFile answers 'wrong file_id' for them.");
      for (let attempt = 1; attempt <= 6; attempt += 1) await finalizeAlbums(h, 5);
    },
  },
];
