import fs from "node:fs";
import path from "node:path";

type PackageJson = {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

const root = process.cwd();
const workspacePackageJsons = [
  path.join(root, "package.json"),
  path.join(root, "apps/backend/package.json"),
  path.join(root, "tools/knip/package.json"),
];

function readPackageJson(filePath: string): PackageJson {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as PackageJson;
  } catch {
    return {};
  }
}

const production = new Set<string>();
const development = new Set<string>();

for (const filePath of workspacePackageJsons) {
  const manifest = readPackageJson(filePath);
  for (const section of [manifest.dependencies, manifest.optionalDependencies, manifest.peerDependencies]) {
    for (const name of Object.keys(section ?? {})) production.add(name);
  }
  for (const name of Object.keys(manifest.devDependencies ?? {})) development.add(name);
}

for (const name of development) {
  if (production.has(name)) continue;
  removePackageDir(path.join(root, "node_modules", name));
}

function removePackageDir(packagePath: string): void {
  if (packagePath.includes(`${path.sep}@`)) {
    fs.rmSync(packagePath, { recursive: true, force: true });
    pruneEmptyScope(path.dirname(packagePath));
    return;
  }
  fs.rmSync(packagePath, { recursive: true, force: true });
}

function pruneEmptyScope(scopePath: string): void {
  try {
    if (fs.readdirSync(scopePath).length === 0) fs.rmdirSync(scopePath);
  } catch {}
}
