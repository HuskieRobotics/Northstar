import { computeStatus } from "@/lib/status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * SSE rather than WebSockets: the flow is one-directional in v1, SSE reconnects
 * on its own, and it is far simpler to reason about.
 */
export async function GET(req: Request) {
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const send = async () => {
        if (closed) return;
        try {
          const payload = JSON.stringify(await computeStatus());
          controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
        } catch (e) {
          try {
            controller.enqueue(
              encoder.encode(`event: error\ndata: ${JSON.stringify({ message: (e as Error).message })}\n\n`),
            );
          } catch {
            /* client gone */
          }
        }
      };

      void send();
      timer = setInterval(send, 1500);

      req.signal.addEventListener("abort", () => {
        closed = true;
        if (timer) clearInterval(timer);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },
    cancel() {
      if (timer) clearInterval(timer);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
