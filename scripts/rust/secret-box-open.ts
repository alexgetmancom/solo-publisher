import { encryptionKey, fingerprint, open } from "../../apps/backend/src/foundation/secret-box.js";

/**
 * Opens values the Rust `foundation` crate sealed, through the TypeScript
 * secret-box, for the Rust parity test.
 *
 *   echo '{"key":"<hex>","sealed":["<iv>.<tag>.<body>"],"values":["…"]}' | bun scripts/rust/secret-box-open.ts
 *   -> {"opened":["…"],"fingerprints":["…"]}
 */
const input = JSON.parse(await Bun.stdin.text()) as { key: string; sealed: string[]; values: string[] };
const key = encryptionKey(input.key) as Buffer;
console.log(JSON.stringify({ opened: input.sealed.map((sealed) => open(sealed, key)), fingerprints: input.values.map(fingerprint) }));
