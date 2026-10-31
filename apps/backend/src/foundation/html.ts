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
