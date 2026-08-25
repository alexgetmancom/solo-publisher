import { describe, expect, it } from "bun:test";
import { emphasizeTitle } from "../src/content/title-emphasis.js";
import { postService } from "../src/studio/services/posts.js";
import { registerTestChannels, TEXT_TEST_CHANNELS } from "./helpers/channels.js";
import { openBackendDb } from "./helpers/open-db.js";
import { loadTestConfig } from "./helpers/studio-config.js";

describe("emphasizeTitle", () => {
  it("bolds a first line followed by a blank line", () => {
    const result = emphasizeTitle("🚨 OpenAI возвращает лимиты\n\nСо следующей недели.", []);
    expect(result).toEqual([{ type: "bold", offset: 0, length: "🚨 OpenAI возвращает лимиты".length }]);
  });

  it("keeps the entities the operator already sent", () => {
    const link = { type: "text_link", offset: 30, length: 4, url: "https://example.com" };
    expect(emphasizeTitle("Заголовок\n\nТело с ссылкой на что-то тут", [link])).toEqual([{ type: "bold", offset: 0, length: 9 }, link]);
  });

  it("leaves text without the title shape alone", () => {
    expect(emphasizeTitle("Одна строка без тела", [])).toEqual([]);
    expect(emphasizeTitle("Строка\nсразу тело без пустой строки", [])).toEqual([]);
    expect(emphasizeTitle(`${"д".repeat(121)}\n\nТело`, [])).toEqual([]);
  });

  it("does not bold a title twice", () => {
    const bold = { type: "bold", offset: 0, length: 9 };
    expect(emphasizeTitle("Заголовок\n\nТело", [bold])).toEqual([bold]);
  });
});

describe("a post's title through the Studio", () => {
  it("bolds the title on creation and on either language's replacement text", () => {
    const backendDb = openBackendDb(":memory:");
    try {
      registerTestChannels(backendDb, TEXT_TEST_CHANNELS);
      const posts = postService(backendDb, loadTestConfig({ CONTROLLER_ADMIN_IDS: "42" }));
      const draftId = posts.create(42, { text: "Заголовок\n\nТело поста.", entities: [], media: [] });
      posts.edit(42, draftId, { locale: "en", text: "Headline\n\nThe body.", entities: [], media: [] });
      posts.edit(42, draftId, { locale: "ru", text: "Новый заголовок\n\nНовое тело.", entities: [], media: [] });

      const draft = posts.get(42, draftId);
      expect(JSON.parse(String(draft.text_ru_entities_json))).toEqual([{ type: "bold", offset: 0, length: 15 }]);
      expect(JSON.parse(String(draft.text_en_entities_json))).toEqual([{ type: "bold", offset: 0, length: 8 }]);
    } finally {
      backendDb.close();
    }
  });
});
