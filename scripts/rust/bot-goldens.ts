import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { CASES } from "./bot-goldens/cases.ts";
import { OUT, prepareFixtures, ROOT, record, SEEDS } from "./bot-goldens/harness.ts";

/**
 * Records the Telegram bot goldens under parity/bot-goldens/. See
 * scripts/rust/bot-goldens/harness.ts for how calls are captured and what is
 * normalised, and parity/bot-goldens/COVERAGE.md for what each case covers.
 *
 *   bun scripts/rust/bot-goldens.ts            # every case; stale case files are removed
 *   bun scripts/rust/bot-goldens.ts <filter>   # only case ids containing <filter>
 *   bun scripts/rust/bot-goldens.ts --seeds    # replay seeds for the Rust test instead
 *                                              # (_trash-rust/tmp/bot-goldens-seeds; parity/ untouched)
 */
const seeds = process.argv[2] === "--seeds";
const filter = process.argv[seeds ? 3 : 2];
await prepareFixtures();
if (seeds) {
  if (!filter) fs.rmSync(SEEDS, { recursive: true, force: true });
  let count = 0;
  for (const item of CASES) {
    if (filter && !item.id.includes(filter)) continue;
    await record(item, true);
    count += 1;
  }
  console.log(`wrote replay seeds for ${count} cases to ${path.relative(ROOT, SEEDS)}`);
  process.exit(0);
}
if (!filter && fs.existsSync(OUT))
  for (const entry of fs.readdirSync(OUT, { withFileTypes: true }))
    if (entry.isDirectory()) fs.rmSync(path.join(OUT, entry.name), { recursive: true });

const started = performance.now();
const written: string[] = [];
for (const item of CASES) {
  if (filter && !item.id.includes(filter)) continue;
  let golden: unknown;
  try {
    golden = await record(item);
  } catch (error) {
    console.error(`case ${item.id} failed`);
    throw error;
  }
  const file = path.join(OUT, item.area, `${item.id}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(golden, null, 2)}\n`);
  written.push(file);
}
// The repository's formatter has the last word on layout (it folds short arrays
// onto one line), so a re-run leaves `biome check parity` clean.
const format = spawnSync(path.join(ROOT, "node_modules/.bin/biome"), ["format", "--write", ...written], { cwd: ROOT, stdio: "ignore" });
if (format.status !== 0) throw new Error("biome format failed on the goldens");
console.log(`wrote ${written.length} cases to ${path.relative(ROOT, OUT)} in ${Math.round(performance.now() - started)} ms`);
process.exit(0);
