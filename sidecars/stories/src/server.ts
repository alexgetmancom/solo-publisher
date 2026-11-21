import { timingSafeEqual } from "node:crypto";
import { type Answer, parseStoryRequest, refused } from "./contract.js";
import { type StoryClient, type StoryCredentials, sendStory } from "./send.js";

export type SidecarOptions = {
  token: string;
  credentials: StoryCredentials | null;
  createClient: (credentials: StoryCredentials) => StoryClient;
  log: (level: "info" | "warn" | "error", message: string, details?: Record<string, unknown>) => void;
};

const MAX_BODY_BYTES = 64 * 1024;

function authorized(request: Request, token: string): boolean {
  const given = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${token}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** The whole HTTP surface: `POST /v1/stories` and `GET /healthz`. Every
 * refusal before `sendStory` says `sent: false`. */
export async function handle(request: Request, options: SidecarOptions): Promise<Answer | "healthy"> {
  const { pathname } = new URL(request.url);
  if (pathname === "/healthz" && request.method === "GET") return "healthy";
  if (pathname !== "/v1/stories") return refused(404, "stories_sidecar_not_found", false);
  if (request.method !== "POST") return refused(405, "stories_sidecar_method_not_allowed", false);
  if (!authorized(request, options.token)) return refused(401, "stories_sidecar_unauthorized", false);
  const text = await request.text();
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) return refused(413, "invalid_story_request: body too large", false);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return refused(400, "invalid_story_request: body is not JSON", false);
  }
  const parsed = parseStoryRequest(body);
  if (!parsed.ok) return refused(400, `invalid_story_request: ${parsed.reason}`, false);
  const answer = await sendStory(parsed.request, options.credentials, options.createClient);
  const outcome = "id" in answer.body ? { id: answer.body.id } : answer.body.error;
  options.log("id" in answer.body ? "info" : "warn", "telegram story request finished", {
    peer: parsed.request.peer,
    status: answer.status,
    ...outcome,
  });
  return answer;
}

export function serve(options: SidecarOptions, hostname: string, port: number): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    hostname,
    port,
    // Bun drops a connection idle for 10 s by default; a Story may take up to
    // 185 s (connect, identity, send, teardown) before its answer is written.
    idleTimeout: 255,
    maxRequestBodySize: MAX_BODY_BYTES,
    fetch: async (request) => {
      try {
        const answer = await handle(request, options);
        return answer === "healthy" ? new Response("ok") : Response.json(answer.body, { status: answer.status });
      } catch (error) {
        // Nothing here throws once sendStory has started (it answers for
        // itself), but an answer that is not an explicit "not sent" is read
        // as ambiguous anyway.
        options.log("error", "stories sidecar request failed", { error: error instanceof Error ? error.message : String(error) });
        return Response.json({ error: { message: "stories_sidecar_internal_error", sent: true } }, { status: 500 });
      }
    },
  });
}
