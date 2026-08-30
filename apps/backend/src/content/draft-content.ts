import { jsonRecordArray } from "../json.js";

type DraftLocale = "ru" | "en";

type DraftLocaleContent = {
  text: string;
  entities: Record<string, unknown>[];
  media: Record<string, unknown>[];
  /** The media this locale has of its own, before it borrows the other's.
   * Images carry no language so borrowing them is right at delivery time — but
   * it is not evidence that this locale has anything to publish. */
  ownMedia: Record<string, unknown>[];
};

type DraftContentSource = {
  text_ru?: string | null;
  text_en_approved?: string | null;
  text_en_machine?: string | null;
  text_ru_entities_json?: unknown;
  text_en_entities_json?: unknown;
  media_ru_json?: unknown;
  media_en_json?: unknown;
};

/** Resolves the content that a locale actually receives at delivery time. */
export function draftLocaleContent(draft: DraftContentSource, locale: DraftLocale): DraftLocaleContent {
  const ruMedia = jsonRecordArray(draft.media_ru_json);
  if (locale === "ru") {
    return {
      text: String(draft.text_ru ?? ""),
      entities: jsonRecordArray(draft.text_ru_entities_json),
      media: ruMedia,
      ownMedia: ruMedia,
    };
  }

  const enMedia = jsonRecordArray(draft.media_en_json);
  return {
    // No `?? text_ru` here: borrowing the Russian text is how an English target
    // published Russian. A locale with nothing in it reads as empty, and
    // preflight refuses to publish that.
    text: String(draft.text_en_approved ?? draft.text_en_machine ?? ""),
    entities: jsonRecordArray(draft.text_en_entities_json),
    media: enMedia.length ? enMedia : ruMedia,
    ownMedia: enMedia,
  };
}
