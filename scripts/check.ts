import { CHECK_GROUPS, type CheckStep } from "./check-steps.js";

const root = new URL("../", import.meta.url).pathname;
const parallel = Bun.argv.includes("--parallel");

async function run(step: CheckStep): Promise<void> {
  const child = Bun.spawn(["bun", "run", ...step.args], { cwd: root, stdout: "inherit", stderr: "inherit" });
  if ((await child.exited) !== 0) throw new Error(`${step.name} failed`);
}

for (const group of CHECK_GROUPS) {
  if (parallel) await Promise.all(group.map(run));
  else for (const step of group) await run(step);
}
