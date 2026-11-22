/** Preloaded before every test file (see bunfig.toml).
 *
 * Collectors and publishers take `fetch` as an argument so tests can stub them,
 * but nothing stopped a code path from reaching for the global one instead —
 * and that call would have gone to YouTube, Meta or Zernio for real, making the
 * suite slow, flaky and dependent on live credentials. Failing loudly turns
 * that into an obvious test bug rather than a silent outbound request.
 *
 * A test that genuinely needs the global (because the code under test uses it)
 * assigns its own stub to globalThis.fetch and restores this one afterwards. */
const realFetch = globalThis.fetch;

/** Loopback is the suite's own dev server (see home.smoke.test.ts), not an
 * outbound call, so it stays allowed; anything leaving this machine does not. */
function isLoopback(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]" || hostname === "::1";
  } catch {
    return false;
  }
}

globalThis.fetch = Object.assign(
  async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (isLoopback(url)) return realFetch(input as RequestInfo, init);
    throw new Error(`Unstubbed network request in tests: ${url}. Pass a fetch stub, or assign globalThis.fetch in the test.`);
  },
  // Bun's fetch carries `preconnect`; keep the real one so the value still
  // satisfies `typeof fetch`.
  { preconnect: realFetch.preconnect },
);
