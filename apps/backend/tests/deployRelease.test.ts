import { describe, expect, it } from "bun:test";
import { type Command, type CommandResult, type DeployInputs, deployRelease } from "../../../scripts/deploy-release.js";

const inputs: DeployInputs = {
  host: "host.example",
  user: "deploy",
  agentToken: "t".repeat(16),
  image: `ghcr.io/alexgetmancom/solo-publisher@sha256:${"a".repeat(64)}`,
  mediaProcessorImage: `ghcr.io/alexgetmancom/alexgetman-media-processor@sha256:${"b".repeat(64)}`,
  release: "abc1234",
  deployAgentChanged: false,
  caddyConfigChanged: false,
  maruDeployEnabled: false,
  promoteMaru: false,
  publicReadyUrl: "https://studio.example/readyz",
  controlPath: "/tmp/deploy-ssh-%C",
};

function recorder(fail?: (script: string) => boolean, failureOutput = "") {
  const commands: Command[] = [];
  const run = async (command: Command): Promise<CommandResult> => {
    commands.push(command);
    const script = command.argv.join(" ");
    const failed = fail?.(script) ?? false;
    return { code: failed ? 1 : 0, stdout: new TextEncoder().encode(failed ? failureOutput : "") };
  };
  return {
    commands,
    run,
    scripts: () => commands.map((command) => command.argv.join(" ")),
  };
}

describe("production deployment", () => {
  it("ships the Studio configuration on every deployment", async () => {
    // Copying only when a diff named these files lost the change for good when
    // a run failed after the commit that made it, and the site went on serving
    // a configuration the repository had moved past.
    const { run, scripts } = recorder();
    await deployRelease(inputs, run, () => {});

    // One compose file describes every Studio; the committed non-secret env
    // makes the repository, rather than one-time host setup, authoritative.
    const archive = scripts().find((script) => script.startsWith("tar -cf -"));
    expect(archive).toContain("deploy/studio.compose.yaml");
    expect(archive).toContain("deploy/alex.env");
    expect(archive).toContain("deploy/maru.env");
    expect(
      scripts().some((script) => script.includes("cp '/home/deploy/alexgetman-runtime/release-files/abc1234/deploy/studio.compose.yaml'")),
    ).toBe(true);
    expect(scripts().some((script) => script.includes("deploy/alex.env' > /home/deploy/alexgetman-runtime/deploy-image.env.next"))).toBe(
      true,
    );
  });

  it("leaves Maru alone unless the release asked to be promoted", async () => {
    const { run, scripts } = recorder();
    await deployRelease({ ...inputs, maruDeployEnabled: true }, run, () => {});

    expect(scripts().some((script) => script.includes("/v1/promote/maru"))).toBe(false);
    // Maru is running whatever an earlier promotion left there; reconciling its
    // env against this run's image would claim an activation that never happened.
    expect(scripts().some((script) => script.includes('Bun.file("/var/lib/alexgetman-deploy/maru.json")'))).toBe(false);
  });

  it("promotes the image alex proved healthy, and only after it did", async () => {
    // A `Deploy-Maru:` trailer reaches the second audience through the same
    // agent endpoint the notification button calls, never through a second
    // deployment of its own.
    const { run, scripts } = recorder();
    await deployRelease({ ...inputs, maruDeployEnabled: true, promoteMaru: true }, run, () => {});

    const promote = scripts().findIndex((script) => script.includes("/v1/promote/maru"));
    const ready = scripts().findIndex((script) => script.includes(inputs.publicReadyUrl));
    expect(promote).toBeGreaterThan(ready);
    expect(scripts()[promote]).toContain('{"release":"abc1234"}');
    expect(scripts().some((script) => script.includes('Bun.file("/var/lib/alexgetman-deploy/maru.json")'))).toBe(true);
  });

  it("refuses to promote into a runtime this run never configured", async () => {
    const { run, scripts } = recorder();
    await expect(deployRelease({ ...inputs, promoteMaru: true }, run, () => {})).rejects.toThrow("MARU_DEPLOY_ENABLED");
    expect(scripts()).toEqual([]);
  });

  it("installs Maru's own committed environment when Maru is enabled", async () => {
    const { run, scripts } = recorder();
    await deployRelease({ ...inputs, maruDeployEnabled: true }, run, () => {});

    expect(scripts().some((script) => script.includes("deploy/maru.env' > /home/deploy/maru/deploy-image.env.next"))).toBe(true);
    expect(scripts().some((script) => script.includes("-f /home/deploy/maru/compose.yaml.next config --quiet"))).toBe(true);
  });

  it("activates only after the configuration is in place, and verifies only after that", async () => {
    // The order is the whole safety property: a container recreated before its
    // configuration arrives runs the previous one, and a reconciliation that
    // runs before activation describes the release that came before.
    const { run, scripts } = recorder();
    await deployRelease(inputs, run, () => {});

    const at = (needle: string) => scripts().findIndex((script) => script.includes(needle));
    expect(at("compose.yaml.next")).toBeLessThan(at("/v1/deploy"));
    expect(at("/v1/deploy")).toBeLessThan(at("readyz"));
    expect(at("readyz")).toBeLessThan(at(`test "$image" = '${inputs.image}'`));
    expect(at(`test "$image" = '${inputs.image}'`)).toBeLessThan(
      at(`rm -rf '/home/deploy/alexgetman-runtime/release-files/${inputs.release}'`),
    );
  });

  it("clears earlier release files before it extracts its own", async () => {
    // The per-release directory is removed at the end of a green run, which a
    // failed run never reaches. Pruning the tree on the way in is what keeps
    // the host from collecting a directory per failed deployment for good.
    const { run, scripts } = recorder();
    await deployRelease(inputs, run, () => {});

    const at = (needle: string) => scripts().findIndex((script) => script.includes(needle));
    expect(at("rm -rf /home/deploy/alexgetman-runtime/release-files;")).toBeGreaterThanOrEqual(0);
    expect(at("rm -rf /home/deploy/alexgetman-runtime/release-files;")).toBeLessThan(at("tar -cf -"));
  });

  it("leaves the proxy and the agent alone unless they changed", async () => {
    const untouched = recorder();
    await deployRelease(inputs, untouched.run, () => {});
    expect(untouched.scripts().some((script) => script.includes("caddy reload"))).toBe(false);
    expect(untouched.scripts().some((script) => script.includes("systemctl restart"))).toBe(false);

    const changed = recorder();
    await deployRelease({ ...inputs, caddyConfigChanged: true, deployAgentChanged: true }, changed.run, () => {});
    expect(changed.scripts().some((script) => script.includes("caddy validate"))).toBe(true);
    expect(changed.scripts().some((script) => script.includes("caddy reload"))).toBe(true);
    expect(changed.scripts().some((script) => script.includes("systemctl restart alexgetman-deploy-agent"))).toBe(true);
  });

  it("stops when a Studio does not come back", async () => {
    // Readiness failing has to end the deployment, not be reported and passed:
    // the reconciliation after it would otherwise record a release nobody
    // proved was serving.
    const { run, scripts } = recorder((script) => script.includes("readyz"));
    await expect(deployRelease(inputs, run, () => {})).rejects.toThrow("did not become ready");
    expect(scripts().some((script) => script.includes(`test "$image" = '${inputs.image}'`))).toBe(false);
  });

  it("stops when the host refuses a step instead of carrying on", async () => {
    const { run } = recorder((script) => script.includes("/v1/deploy"), "container preflight failed");
    await expect(deployRelease(inputs, run, () => {})).rejects.toThrow("container preflight failed");
  });

  it("names what it cannot proceed without", async () => {
    const { run } = recorder();
    await expect(deployRelease({ ...inputs, image: "" }, run, () => {})).rejects.toThrow("IMAGE is required");
    await expect(deployRelease({ ...inputs, host: "" }, run, () => {})).rejects.toThrow("DEPLOY_HOST is required");
  });
});
