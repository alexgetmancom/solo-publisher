import fs from "node:fs";
import path from "node:path";

/** One command as every operator-facing surface describes it. Declared here
 * because the guide is what publishes the catalog; the registry fills it in. */
export type OperationCatalogEntry = { name: string; usage: string; mutates: boolean; agent: boolean; summary: string; note?: string };

type LocalState = "available" | "missing" | "unusable";

type LocalOperationsProbe = {
  path: string;
  state: LocalState;
  reason: string;
};

type OperationsGuide = {
  version: 1;
  local: LocalOperationsProbe;
  route: "local" | "production";
  next: {
    reason: string;
    command: string;
  };
  catalog: {
    /** Which build the `commands` below came from. */
    source: "this working tree";
    authoritative: boolean;
    reason: string;
    /** How to read the catalog the recommended route will actually accept. */
    command: string;
  };
  production: {
    configured: boolean;
  };
  commands: readonly OperationCatalogEntry[];
};

function probeLocalOperations(databasePath: string): LocalOperationsProbe {
  const resolvedPath = path.resolve(databasePath);
  try {
    const stat = fs.statSync(resolvedPath);
    if (!stat.isFile()) return { path: resolvedPath, state: "unusable", reason: "database path is not a regular file" };
    fs.accessSync(resolvedPath, fs.constants.R_OK | fs.constants.W_OK);
    fs.accessSync(path.dirname(resolvedPath), fs.constants.R_OK | fs.constants.W_OK);
    return { path: resolvedPath, state: "available", reason: "database file and its directory are readable and writable" };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { path: resolvedPath, state: "missing", reason: "database file was not found" };
    return { path: resolvedPath, state: "unusable", reason: error instanceof Error ? error.message : String(error) };
  }
}

/** The catalog is handed in rather than read: the guide describes the registry,
 * and a registry that has to import its own description back is a loop. */
export function buildOperationsGuide(databasePath: string, commands: readonly OperationCatalogEntry[]): OperationsGuide {
  const local = probeLocalOperations(databasePath);
  const route = local.state === "available" ? "local" : "production";
  const command = route === "local" ? "bun run --filter @solo-publisher/backend ops <command>" : "bun run ops:prod <command>";
  // The catalog is compiled into this process. On the local route that is the
  // binary being run, so it is the truth. On the production route it is not:
  // the container runs whatever revision was last deployed, and between a
  // commit and a deploy the two disagree — a command listed here earns
  // "unknown command" there, which reads as a broken deployment rather than a
  // stale one. Say which build is being described and where the other lives.
  const catalog = {
    source: "this working tree",
    authoritative: route === "local",
    reason:
      route === "local"
        ? "The local route runs this build, so these are the commands it accepts."
        : "The production container runs its last deployed revision, which may not accept every command listed here.",
    command: command.replace("<command>", "guide --json"),
  } as const;
  return {
    version: 1,
    local,
    route,
    next: {
      reason:
        route === "local"
          ? "The local database is available; run the requested read-only command locally first."
          : "The local database is unavailable; do not repair local /data and continue with the production route.",
      command,
    },
    production: {
      configured: productionLauncherConfigured(),
    },
    catalog,
    commands,
  };
}

function productionLauncherConfigured(): boolean {
  if (Object.hasOwn(process.env, "OPS_SSH_TARGET")) return Boolean(process.env.OPS_SSH_TARGET?.trim());

  const packageEnvPath = path.resolve(process.cwd(), ".env.local");
  const rootEnvPath = path.resolve(process.cwd(), "../../.env.local");
  return [packageEnvPath, rootEnvPath].some(hasConfiguredSshTarget);
}

function hasConfiguredSshTarget(filePath: string): boolean {
  try {
    const contents = fs.readFileSync(filePath, "utf8");
    for (const line of contents.split(/\r?\n/)) {
      const match = line.match(/^\s*OPS_SSH_TARGET\s*=\s*(.*?)\s*(?:#.*)?$/);
      if (!match) continue;
      const value = match[1]
        ?.trim()
        .replace(/^("|')(.*)\1$/, "$2")
        .trim();
      return Boolean(value);
    }
  } catch {
    return false;
  }
  return false;
}

export function formatOperationsGuide(guide: OperationsGuide): string {
  const routeLabel = guide.route === "local" ? "LOCAL" : "PRODUCTION";
  const commandLines = guide.commands.flatMap((command) => {
    const safety = command.mutates ? "MUTATION" : "read-only";
    const note = command.note ? ` (${command.note})` : "";
    return [`  [${safety}] ${command.usage}`, `             ${command.summary}${note}`];
  });
  return [
    "operations guide",
    "",
    `Local database: ${guide.local.state.toUpperCase()}`,
    `Path: ${guide.local.path}`,
    `Reason: ${guide.local.reason}`,
    `Recommended route: ${routeLabel}`,
    "",
    guide.next.reason,
    `Next command: ${guide.next.command}`,
    `Production launcher: ${guide.production.configured ? "configured" : "not configured"}`,
    "",
    guide.catalog.authoritative
      ? "Catalog: this build."
      : `Catalog below is THIS WORKING TREE, not the deployed one. ${guide.catalog.reason}`,
    guide.catalog.authoritative ? "" : `Read the deployed catalog with: ${guide.catalog.command}`,
    "",
    "Commands:",
    ...commandLines,
  ].join("\n");
}
