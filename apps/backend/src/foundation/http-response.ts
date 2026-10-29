/** Response constructors shared by every HTTP route module. They encode the
 * wire conventions of this service — charset on every content-type and the
 * streaming response lifecycle — so a new route
 * inherits them instead of restating them. */

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

export function text(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

export function html(body: string): Response {
  return new Response(body, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

export function sse(start: (send: (event: string, data: unknown) => void) => ReturnType<typeof setInterval>): Response {
  let timer: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // A disconnect that never delivers cancel() would otherwise leave the
      // interval running forever, re-querying the pipeline for nobody. Enqueue
      // on a dead controller throws, so that throw is what stops the timer.
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(
            new TextEncoder().encode(`event: ${event}\ndata: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`),
          );
        } catch {
          if (timer) clearInterval(timer);
        }
      };
      timer = start(send);
    },
    cancel() {
      if (timer) clearInterval(timer);
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}
