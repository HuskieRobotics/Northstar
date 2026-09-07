import { findInstance } from "@/lib/discovery";
import { classify, readSince } from "@/lib/logs";
import fs from "node:fs/promises";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ instance: string; stream: string }> };

/** SSE follow: pushes newly appended lines. */
export async function GET(req: Request, { params }: Params) {
  const { instance, stream } = await params;
  const inst = await findInstance(instance);
  const file = stream === "err" ? inst?.errLog : inst?.outLog;

  const encoder = new TextEncoder();
  if (!file) {
    return new Response(`event: unavailable\ndata: {}\n\n`, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
    });
  }

  const from = Number(new URL(req.url).searchParams.get("from") ?? NaN);
  let offset = Number.isFinite(from) ? from : (await fs.stat(file).catch(() => ({ size: 0 }))).size;

  let timer: ReturnType<typeof setInterval> | undefined;
  const body = new ReadableStream({
    start(controller) {
      const tick = async () => {
        try {
          const { lines, next } = await readSince(file, offset);
          offset = next;
          if (lines.length) {
            const payload = JSON.stringify(lines.map((text) => ({ text, kind: classify(text) })));
            controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
          } else {
            controller.enqueue(encoder.encode(`: keepalive\n\n`));
          }
        } catch {
          /* file may vanish on redeploy; keep the stream alive */
        }
      };
      timer = setInterval(tick, 1000);
      req.signal.addEventListener("abort", () => {
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

  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
