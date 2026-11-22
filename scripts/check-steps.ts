/** The one list of checks the repo runs before code leaves the machine.
 *
 * check.ts runs this list serially for readable output or group-parallel for a
 * fast pre-push gate. */
export type CheckStep = { name: string; args: string[] };

/** Ordered: each group may only start once the previous one passed. */
export const CHECK_GROUPS: CheckStep[][] = [
  [{ name: "language", args: ["check:language"] }],
  [
    { name: "lint", args: ["lint"] },
    { name: "knip", args: ["knip"] },
    { name: "docker workspaces", args: ["check:docker"] },
    { name: "typecheck", args: ["typecheck"] },
  ],
  [
    { name: "test", args: ["test"] },
    { name: "rust", args: ["check:rust"] },
    { name: "build", args: ["build"] },
  ],
];
