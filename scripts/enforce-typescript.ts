import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// runtime, ops and entrypoint hold bundles built from TypeScript sources. CI
// only builds them after this gate runs, so it never saw them; a local image
// build does, and the gate then fails on generated JavaScript.
const ignoredDirectories = new Set([
  ".git",
  ".astro",
  "node_modules",
  "dist",
  "coverage",
  "runtime",
  "ops",
  "entrypoint",
  "story-renderer",
]);
const forbiddenExtensions = new Set([".py", ".pyi", ".js", ".jsx", ".mjs", ".cjs"]);
// The one file that cannot be TypeScript: it runs on a bare host through
// `curl … | sh`, before Docker has pulled anything and long before a Bun exists
// to interpret it. Everything it sets up afterwards is TypeScript.
const allowedShellSources = new Set(["install.sh"]);
const shellNames = new Set(["sh", "bash", "zsh"]);
const violations: string[] = [];

function visit(directory: string): void {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      visit(absolute);
      continue;
    }
    if (!entry.isFile()) continue;
    const relative = path.relative(root, absolute);
    const extension = path.extname(entry.name);
    if (allowedShellSources.has(relative)) continue;
    if (forbiddenExtensions.has(extension)) violations.push(relative);
    if (relative.startsWith("apps/web/src/features/story-player/") && extension === ".svelte") {
      const text = fs.readFileSync(absolute, "utf8");
      const comments = [...text.matchAll(/<!--[\s\S]*?-->|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g)].map((match) => match[0]).join("\n");
      if (/[А-Яа-яЁё]/.test(comments)) violations.push(relative);
    }
    const disabledTypecheckDirective = "@ts-" + "nocheck";
    if (extension === ".ts" && fs.readFileSync(absolute, "utf8").includes(disabledTypecheckDirective)) violations.push(relative);
    if (!extension || extension === ".sh") {
      const descriptor = fs.openSync(absolute, "r");
      const buffer = Buffer.alloc(256);
      const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
      fs.closeSync(descriptor);
      const firstLine = buffer.subarray(0, bytes).toString("utf8").split(/\r?\n/, 1)[0] ?? "";
      if (firstLine.startsWith("#!") && [...shellNames].some((name) => firstLine.includes(name))) violations.push(relative);
    }
  }
}

visit(root);
if (violations.length > 0) {
  console.error(
    `Non-TypeScript executable source found:\n${[...new Set(violations)]
      .sort()
      .map((file) => `- ${file}`)
      .join("\n")}`,
  );
  process.exit(1);
}
console.log("Language gate passed: executable sources and Story-player comments follow the repository language rules.");
