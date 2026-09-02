import { basename } from "node:path";

/** The host runs one container per Studio. Naming the deployment is how a
 * command says which one it means; there is no ambient default beyond `alex`. */
const DEPLOYMENTS = {
  alex: "alexgetman-backend",
  maru: "maru-backend",
} as const;
type Deployment = keyof typeof DEPLOYMENTS;
const DEPLOYMENT_NAMES = Object.keys(DEPLOYMENTS).join(", ");
const USAGE = `usage: bun run ops:prod [--as ${DEPLOYMENT_NAMES}] <command> [arguments]
       bun run ops:prod [--as ${DEPLOYMENT_NAMES}] logs [--since 6h] [--grep TEXT] [--lines N]`;

const argv = process.argv.slice(2);
if (argv.length === 0) {
  console.error(USAGE);
  process.exit(1);
}

let deployment: Deployment = "alex";
if (argv[0] === "--as") {
  const requested = argv[1] ?? "";
  if (!isDeployment(requested)) {
    console.error(`--as takes a deployment name: ${DEPLOYMENT_NAMES}`);
    process.exit(1);
  }
  deployment = requested;
  argv.splice(0, 2);
}
if (argv.length === 0 || argv.includes("--as")) {
  console.error(USAGE);
  process.exit(1);
}

const sshTarget = process.env.OPS_SSH_TARGET?.trim();
if (!sshTarget) {
  console.error("OPS_SSH_TARGET is required; set it in .env.local before using ops:prod");
  process.exit(1);
}

const container = DEPLOYMENTS[deployment];

/** Reading an answer about the wrong Studio is the failure this guards, and it
 * is invisible without a banner. stderr keeps stdout parseable as JSON. */
console.error(`ops:prod → ${deployment} (${container})`);

/** A path argument names a file on this Mac, and the command runs in a
 * container that cannot see it. Ship it in, run against the copy, remove it. */
const FILE_FLAGS = new Set(["--file", "--x-file"]);

/** What `logs` accepts. Deliberately three: a window, a fixed-string filter and
 * a tail. Anything more is a shell, and the shell is one ssh away. */
const LOG_FLAGS = new Set(["--since", "--grep", "--lines"]);

const exitCode = argv[0] === "logs" ? await readProductionLog() : await runProductionCommand();
process.exit(exitCode);

/**
 * The container's own stdout, which no operation can reach.
 *
 * Every other command here is `docker exec` into the Studio, and the operations
 * registry is the catalogue of what the Studio can do to itself. Reading its log
 * is not one of those things: the log is a file Docker keeps on the host, and
 * the container has no way to see it. So this lives beside the ssh rather than
 * behind an operation, and `guide` does not list it.
 *
 * It is worth the exception because the timing lines are the only record of how
 * long a tap, a publish or a render actually took, and every question about them
 * is asked after the fact. Note what that costs: `docker compose up` on a new
 * image builds a new container, and the replaced one's log goes with it, so this
 * reads back to the last deployment and no further -- not the couple of weeks
 * the retention in `studio.compose.yaml` sizes for.
 */
async function readProductionLog(): Promise<number> {
  const options = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index] ?? "";
    const value = argv[index + 1];
    if (!LOG_FLAGS.has(flag) || value === undefined) {
      console.error(`logs takes ${[...LOG_FLAGS].join(", ")}, each with a value`);
      return 1;
    }
    options.set(flag, value);
  }
  const filter = options.get("--grep");
  // One pipeline on the host, so the whole log never crosses the wire to be
  // filtered here: a fortnight of a busy Studio is hundreds of megabytes.
  const pipeline = [
    remoteCommand(["docker", "logs", "--since", options.get("--since") ?? "1h", container]),
    "2>&1",
    ...(filter === undefined ? [] : ["|", remoteCommand(["grep", "-F", "--", filter])]),
    "|",
    remoteCommand(["tail", "-n", options.get("--lines") ?? "200"]),
  ].join(" ");
  return await run(["ssh", sshTarget, pipeline]);
}

async function runProductionCommand(): Promise<number> {
  const shipped: string[] = [];
  try {
    for (const [index, value] of argv.entries()) {
      // Both spellings the CLI parser accepts: `--file=PATH` used to travel
      // through untouched and the container looked for a Mac path.
      const inlined = value.indexOf("=") > 2 && FILE_FLAGS.has(value.slice(0, value.indexOf("=")));
      if (!inlined && !FILE_FLAGS.has(value)) continue;
      const local = inlined ? value.slice(value.indexOf("=") + 1) : argv[index + 1];
      if (!local || !(await Bun.file(local).exists())) continue;
      const remotePath = `/tmp/${basename(local)}`;
      const copyCommand = remoteCommand(["docker", "exec", "-i", "-u", "bun", container, "sh", "-c", `cat > ${shellQuote(remotePath)}`]);
      const copyCode = await run(["ssh", sshTarget, copyCommand], local);
      if (copyCode !== 0) {
        console.error(`failed to copy ${local} into ${container}`);
        return copyCode;
      }
      shipped.push(remotePath);
      if (inlined) argv[index] = `${value.slice(0, value.indexOf("="))}=${remotePath}`;
      else argv[index + 1] = remotePath;
    }

    return await run([
      "ssh",
      sshTarget,
      remoteCommand([
        "docker",
        "exec",
        "-i",
        "-u",
        "bun",
        // The container is reached through this launcher and cannot see it, so
        // every command it prints for the operator to run next is written in
        // the coordinates of a shell that is one ssh away. Hand it the spelling
        // that actually got here, and the deployments it could have gone to.
        ...["-e", `OPS_INVOCATION=bun run ops:prod --as ${deployment}`],
        ...["-e", `OPS_INSTANCE=${deployment}`],
        ...["-e", `OPS_INSTANCES=${Object.keys(DEPLOYMENTS).join(",")}`],
        container,
        "bun",
        "/app/ops/cli.js",
        ...argv,
      ]),
    ]);
  } finally {
    for (const remotePath of shipped) {
      await run(["ssh", sshTarget, remoteCommand(["docker", "exec", "-u", "bun", container, "rm", "-f", remotePath])]);
    }
  }
}

async function run(command: string[], stdinFile?: string): Promise<number> {
  const child = Bun.spawn(command, {
    stdin: stdinFile ? Bun.file(stdinFile) : "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return await child.exited;
}

function isDeployment(value: string): value is Deployment {
  return value in DEPLOYMENTS;
}

function remoteCommand(parts: readonly string[]): string {
  return parts.map(shellQuote).join(" ");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}
