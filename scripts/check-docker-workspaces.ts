import { Glob } from "bun";

/** Asserts the image build sees every workspace manifest.
 *
 * bun install --frozen-lockfile fails when a workspace listed in bun.lock has no
 * package.json in the build context, and the Dockerfile copies those manifests
 * one COPY line at a time. Adding a workspace therefore breaks the image while
 * CI stays green — CI installs from a full checkout, so nothing there notices.
 * The failure surfaces only in Deploy, after main is already merged, which is
 * how a missing workspace manifest would break it.
 */
const root = new URL("../", import.meta.url).pathname;
const dockerfiles = [{ name: "Dockerfile", path: `${root}Dockerfile` }];
const rootManifest = (await Bun.file(`${root}package.json`).json()) as { workspaces: string[] };

const manifests: string[] = [];
for (const pattern of rootManifest.workspaces)
  for await (const match of new Glob(`${pattern}/package.json`).scan({ cwd: root })) manifests.push(match);

const missing: string[] = [];
let installingStageCount = 0;
for (const dockerfile of dockerfiles) {
  const source = await Bun.file(dockerfile.path).text();
  /** Each `FROM` opens a stage; only the ones that install care about manifests. */
  const stages = source
    .split(/^FROM /m)
    .slice(1)
    .map((stage) => {
      // The line reads `<image> AS <name>`, and every installing stage is named.
      const declaration = (stage.split("\n", 1)[0] ?? "").split(/\s+/);
      return { name: declaration[2] ?? declaration[0] ?? "?", body: stage };
    })
    .filter((stage) => stage.body.includes("bun install"));

  installingStageCount += stages.length;
  for (const stage of stages)
    for (const manifest of manifests)
      if (!stage.body.includes(`COPY --chown=bun:bun ${manifest} `)) missing.push(`${dockerfile.name}/${stage.name}: ${manifest}`);
}

if (missing.length > 0) {
  console.error(`Dockerfiles do not copy every workspace manifest before installing:\n${missing.map((entry) => `- ${entry}`).join("\n")}`);
  process.exit(1);
}
console.log(`Dockerfile workspace gate passed: ${manifests.length} manifests copied in ${installingStageCount} installing stages.`);
