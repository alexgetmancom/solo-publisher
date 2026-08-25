/** The longest first line still read as a title. Above this the "line, blank
 * line, body" shape is an opening paragraph, not a headline, and bolding it
 * would shout a whole paragraph at the reader. */
const TITLE_LIMIT = 120;

/** The entities of a text, with its title bold.
 *
 * A post written here is a title, a blank line, and a body, and the title is
 * always set bold by hand afterwards. That is a property of the text, not of
 * the interface that carried it or of the language it is in, so both drafting
 * a post and replacing either language's text run through here.
 *
 * Text without that shape is left alone, and so is a title the operator
 * already emphasized: the entity is added only when nothing bold covers the
 * first line yet. Offsets are UTF-16 code units, the unit Telegram entities
 * are measured in, so `length` is the plain `.length` of the title. */
export function emphasizeTitle(text: string, entities: readonly unknown[]): unknown[] {
  const existing = entities as Record<string, unknown>[];
  const title = titleOf(text);
  if (title === null) return [...existing];
  if (existing.some((entity) => entity.type === "bold" && Number(entity.offset) < title.length)) return [...existing];
  return [{ type: "bold", offset: 0, length: title.length }, ...existing];
}

function titleOf(text: string): string | null {
  const match = /^([^\n\r]+)\r?\n[ \t]*\r?\n\s*\S/.exec(text);
  const title = match?.[1]?.trimEnd() ?? "";
  return title && title.length <= TITLE_LIMIT ? title : null;
}
