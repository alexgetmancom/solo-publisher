/** The one HTML escaper. Every server-rendered surface interpolates DB-derived
 * values straight into markup, so escaping happens at that boundary rather than
 * relying on every future field staying numeric. Single implementation on
 * purpose: the copies this replaced had quietly drifted, two of them leaving `'`
 * unescaped inside pages the other copies escaped it in. */
export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** XML entity set: `&apos;` where HTML uses `&#39;`. One implementation for the
 * same reason as escapeHtml -- the three this replaced escaped three, four and
 * five characters respectively. */
export function escapeXml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/**
 * A finished fragment of HTML.
 *
 * The point of the type is what it excludes: a plain string interpolated into
 * the `html` tag is escaped, always, because the tag has no way to know whether
 * a caller meant markup or a post title with a quote in it. Only what this
 * module produced -- `html` itself, or `raw` for a fragment that came from
 * somewhere else -- passes through untouched.
 *
 * Escaping used to be a call every author had to remember at every hole in
 * every template, forty-five times across the Command Center, and one omission
 * renders a broken row rather than an error anyone would see.
 */
export class Html {
  constructor(readonly value: string) {}

  toString(): string {
    return this.value;
  }
}

/** Marks a string that is already markup: a static icon, a fragment assembled
 * before this module existed. Everything else belongs in the tag. */
export function raw(value: string): Html {
  return new Html(value);
}

/** Builds one fragment. Interpolated values are escaped unless they are already
 * `Html`; an array is joined, each item by the same rule; `null`, `undefined`
 * and `false` render as nothing, so `${condition && html`...`}` reads the way
 * it looks. */
export function html(strings: TemplateStringsArray, ...values: readonly unknown[]): Html {
  let out = strings[0] ?? "";
  for (const [index, value] of values.entries()) out += interpolate(value) + (strings[index + 1] ?? "");
  return new Html(out);
}

function interpolate(value: unknown): string {
  if (value instanceof Html) return value.value;
  if (Array.isArray(value)) return value.map(interpolate).join("");
  if (value === null || value === undefined || value === false) return "";
  return escapeHtml(value);
}
