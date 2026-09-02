import fs from "node:fs";
import path from "node:path";

/** The sections the catalog is read in. A section is what an operator is
 * holding when they ask -- a stuck delivery, a chart that disagrees, a channel
 * that will not connect -- not where the code lives. */
export const OPERATION_SECTIONS = ["health", "delivery", "analytics", "media", "channels", "studio", "host"] as const;
export type OperationSection = (typeof OPERATION_SECTIONS)[number];

export const SECTION_SUMMARIES: Record<OperationSection, string> = {
  health: "Is this deployment working, and what is wrong with it.",
  delivery: "One publication: what it is, where it went, and how to move it.",
  analytics: "Audience numbers, imported platform exports and what the charts are drawn from.",
  media: "The media processor, one publication's assets, and the stored files behind them.",
  channels: "Which accounts this Studio publishes through and the state of their credentials.",
  studio: "What this Studio is, how it is configured, and what it is streaming.",
  host: "Operations on the deployment's own files. CLI only: they name paths on the host.",
};

/** One command as every operator-facing surface describes it. Declared here
 * because the guide is what publishes the catalog; the registry fills it in. */
export type OperationCatalogEntry = {
  name: string;
  usage: string;
  mutates: boolean;
  agent: boolean;
  section: OperationSection;
  summary: string;
  note?: string;
  /** The question an operator arrives with, when this command is where the
   * answer starts. The symptom index is built from these. */
  startHere?: string;
};

type LocalState = "available" | "missing" | "unusable";

type LocalOperationsProbe = {
  path: string;
  state: LocalState;
  reason: string;
};

/** How the caller reached this build, and what else it could have reached.
 *
 * The guide runs inside the deployment and cannot see the launcher that got it
 * there, so the launcher says so on the way in. Without it every `next.command`
 * is written in the coordinates of the machine the guide is running on -- which
 * is the one place the reader is not. */
type Invocation = {
  /** How to spell a command for the route the caller actually used. */
  prefix: string;
  /** Which deployment answered, when the launcher names them. */
  instance?: string;
  /** Every deployment the launcher can reach, this one included. Absent for a
   * single-deployment install, where there is nothing to choose between. */
  instances?: readonly string[];
};

export type GuideView = { section?: OperationSection | undefined; all?: boolean | undefined };

type SectionDigest = {
  name: OperationSection;
  summary: string;
  count: number;
  /** Names only. The whole catalog stays visible for the price of a listing,
   * and one `guide --section` buys the detail for the part that is wanted. */
  commands: readonly string[];
};

type OperationsGuide = {
  version: 2;
  local: LocalOperationsProbe;
  route: "local" | "production";
  invocation: Invocation;
  next: {
    reason: string;
    command: string;
  };
  catalog: {
    /** Which build the commands below came from. */
    source: "this working tree";
    authoritative: boolean;
    reason: string;
    /** How to read the catalog the recommended route will actually accept. */
    command: string;
  };
  production: {
    configured: boolean;
  };
  /** Symptom to command. The first thing to read: an operator arrives with a
   * question, not with a section name. */
  startHere: readonly { symptom: string; command: string }[];
  sections: readonly SectionDigest[];
  /** How to read the rest of any section. */
  expand: string;
  /** Full entries, for the section asked about. Absent from the default view:
   * the whole catalog is 22KB of summaries, and a caller reading it to answer
   * one question pays for all of it. */
  commands?: readonly OperationCatalogEntry[];
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

/** What the launcher said about itself, or the plain local spelling when
 * nothing did. An install that runs `docker compose exec app` reaches here with
 * no launcher and gets the route it actually used. */
function readInvocation(route: "local" | "production", environment: NodeJS.ProcessEnv): Invocation {
  const prefix =
    environment.OPS_INVOCATION?.trim() || (route === "local" ? "bun run --filter @solo-publisher/backend ops" : "bun run ops:prod");
  const instance = environment.OPS_INSTANCE?.trim();
  const instances = (environment.OPS_INSTANCES ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  return {
    prefix,
    ...(instance ? { instance } : {}),
    // One deployment is not a choice, and listing it invites a flag that does
    // not exist. Published only where the launcher knows of more than one.
    ...(instances.length > 1 ? { instances } : {}),
  };
}

function digestSections(commands: readonly OperationCatalogEntry[]): SectionDigest[] {
  return OPERATION_SECTIONS.map((name) => {
    const members = commands.filter((command) => command.section === name);
    return { name, summary: SECTION_SUMMARIES[name], count: members.length, commands: members.map((command) => command.name) };
  }).filter((section) => section.count > 0);
}

/** The catalog is handed in rather than read: the guide describes the registry,
 * and a registry that has to import its own description back is a loop. */
export function buildOperationsGuide(
  databasePath: string,
  commands: readonly OperationCatalogEntry[],
  view: GuideView = {},
  environment: NodeJS.ProcessEnv = process.env,
): OperationsGuide {
  const local = probeLocalOperations(databasePath);
  const route = local.state === "available" ? "local" : "production";
  const invocation = readInvocation(route, environment);
  const command = `${invocation.prefix} <command>`;
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
    command: `${invocation.prefix} guide --json`,
  } as const;
  const selected = view.all ? commands : view.section ? commands.filter((entry) => entry.section === view.section) : undefined;
  return {
    version: 2,
    local,
    route,
    invocation,
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
    // Section order, not catalog order: this is the first thing a caller reads,
    // and catalog order led it with whichever symptom happened to be declared
    // first -- a stream question, ahead of "is this deployment alive".
    startHere: OPERATION_SECTIONS.flatMap((section) =>
      commands.flatMap((entry) =>
        entry.section === section && entry.startHere ? [{ symptom: entry.startHere, command: entry.name }] : [],
      ),
    ),
    sections: digestSections(commands),
    expand: `${invocation.prefix} guide --section <${OPERATION_SECTIONS.join("|")}>, or --all for every entry`,
    ...(selected ? { commands: selected } : {}),
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
  const detail = (guide.commands ?? []).flatMap((command) => {
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
    ...(guide.invocation.instance ? [`Deployment: ${guide.invocation.instance}`] : []),
    ...(guide.invocation.instances ? [`Other deployments: ${guide.invocation.instances.join(", ")}`] : []),
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
    "Start here:",
    ...guide.startHere.map((entry) => `  ${entry.symptom} → ${entry.command}`),
    "",
    "Sections:",
    ...guide.sections.flatMap((section) => [
      `  ${section.name} (${section.count}) — ${section.summary}`,
      `    ${section.commands.join(", ")}`,
    ]),
    "",
    `Expand: ${guide.expand}`,
    ...(detail.length ? ["", "Commands:", ...detail] : []),
  ].join("\n");
}
