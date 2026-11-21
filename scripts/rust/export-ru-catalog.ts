import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { catalog } from "../../apps/backend/src/foundation/i18n/catalog.js";

/**
 * Writes the Russian interface catalog the Rust `foundation` crate embeds, once.
 *
 * Every key of `catalog.en`, in its order, carrying the `ru` text when there is
 * one and the `en` text otherwise — exactly what `t("ru", key)` rendered at the
 * export. Since then `ru.json` is the source of truth and is edited by hand
 * (plans/rust/DECISIONS.md), so an existing file is never overwritten.
 *
 *   bun scripts/rust/export-ru-catalog.ts
 */
const ru: Record<string, string> = {};
for (const [key, en] of Object.entries(catalog.en)) ru[key] = (catalog.ru as Record<string, string | undefined>)[key] ?? en;

const target = path.join(import.meta.dir, "../../crates/foundation/locales/ru.json");
if (existsSync(target)) {
  throw new Error(
    `${path.relative(process.cwd(), target)} exists and is the source of truth (plans/rust/DECISIONS.md); edit it, do not re-export`,
  );
}
writeFileSync(target, `${JSON.stringify(ru, null, 2)}\n`);
console.log(`${Object.keys(ru).length} keys -> ${path.relative(process.cwd(), target)}`);
