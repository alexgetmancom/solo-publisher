import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// target and _trash-rust hold Rust build output and scratch files (git-excluded, disposable).
const ignoredDirectories = new Set([".git", "node_modules", "dist", "coverage", "target", "_trash-rust"]);
const forbiddenExtensions = new Set([".py", ".pyi", ".js", ".jsx", ".mjs", ".cjs"]);
// The one file that cannot be TypeScript: it runs on a bare host through
// `curl … | sh`, before Docker has pulled anything and long before a Bun exists
// to interpret it. Everything it sets up afterwards is TypeScript.
const allowedShellSources = new Set(["install.sh"]);
// The image's two Bun-run shims, kept because callers outside the image name
// these paths: `bun /app/ops/cli.js` (scripts/ops-prod.ts) and
// `bun /app/entrypoint/config-check.js` (deploy/deploy-agent.ts). Each only
// runs a Rust binary.
const allowedJavaScriptSources = new Set(["crates/ops/image/cli.js", "crates/entrypoint/image/config-check.js"]);
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
    if (allowedShellSources.has(relative) || allowedJavaScriptSources.has(relative)) continue;
    if (forbiddenExtensions.has(extension)) violations.push(relative);
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
