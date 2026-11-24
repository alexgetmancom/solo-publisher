// `bun /app/entrypoint/config-check.js` is how the TypeScript deploy agent
// (still on a host until it switches to the binary, deploy/README.md) checks a
// new image's configuration before it replaces the running container; in this
// image it is
// `studio-entrypoint --check-config`, with the same environment, standard
// streams and exit status.
const child = Bun.spawn(["/app/bin/studio-entrypoint", "--check-config"], {
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
process.exit(await child.exited);
