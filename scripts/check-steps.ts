/** The one list of checks the repo runs before code leaves the machine.
 *
 * check.ts runs this list serially for readable output or group-parallel for a
 * fast pre-push gate.
 *
 * Layer boundaries are the `layers` step (dependency-cruiser); there is no
 * separate architecture test to schedule ahead of it. */
export type CheckStep = { name: string; args: string[] };

/** Ordered: each group may only start once the previous one passed. */
export const CHECK_GROUPS: CheckStep[][] = [
  [{ name: "language", args: ["check:language"] }],
  [
    { name: "lint", args: ["lint"] },
    { name: "knip", args: ["knip"] },
    { name: "layers", args: ["check:layers"] },
    { name: "docker workspaces", args: ["check:docker"] },
    { name: "typecheck", args: ["typecheck"] },
    { name: "svelte", args: ["check:svelte"] },
  ],
  [
    { name: "test", args: ["test"] },
    { name: "web", args: ["check:web"] },
    { name: "backend", args: ["--filter", "@solo-publisher/backend", "build"] },
  ],
];
