import { writeFileSync } from "node:fs";
import path from "node:path";
import { catalog } from "../../apps/backend/src/foundation/i18n/catalog.js";

/**
 * Writes the Russian interface catalog the Rust `foundation` crate embeds.
 *
 * Every key of `catalog.en`, in its order, carrying the `ru` text when there is
 * one and the `en` text otherwise — exactly what `t("ru", key)` renders today.
 *
 *   bun scripts/rust/export-ru-catalog.ts
 */
const ru: Record<string, string> = {};
for (const [key, en] of Object.entries(catalog.en)) ru[key] = (catalog.ru as Record<string, string | undefined>)[key] ?? en;

const target = path.join(import.meta.dir, "../../crates/foundation/locales/ru.json");
writeFileSync(target, `${JSON.stringify(ru, null, 2)}\n`);
console.log(`${Object.keys(ru).length} keys -> ${path.relative(process.cwd(), target)}`);
