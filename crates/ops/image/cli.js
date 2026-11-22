// `bun /app/ops/cli.js <command> …` is the operations route scripts/ops-prod.ts
// runs through `docker exec`; in the Rust image it is the `ops` binary, with
// the same arguments, standard streams, environment and exit status.
const child = Bun.spawn(["/app/bin/ops", ...process.argv.slice(2)], {
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
process.exit(await child.exited);
