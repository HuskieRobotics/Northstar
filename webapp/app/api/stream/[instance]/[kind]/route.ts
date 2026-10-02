import { NextResponse } from "next/server";
import { findInstance } from "@/lib/discovery";
import { MJPEG_BOUNDARY, MJPEG_PATH } from "@/lib/contract";
import { MjpegFrameParser, mjpegPart } from "@/lib/mjpeg";
import net from "node:net";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ instance: string; kind: string }> };

/**
 * Full-rate MJPEG, proxied from 127.0.0.1 so only port 5800 needs to be
 * reachable from the client.
 *
 * This holds a client attached to the Northstar worker for as long as the
 * browser keeps the connection, which costs a frame copy + overlay + JPEG encode
 * per frame. The UI opens at most one of these at a time and shows an indicator
 * while it is live. Aborting the request tears the upstream socket down
 * promptly, which is what releases the worker.
 *
 * Latest frame wins. The upstream hop is loopback and effectively unlimited,
 * while the browser may be on a slow robot radio. Passing bytes straight
 * through would queue every frame in this process and the view would fall
 * further behind the longer it stayed open. Instead upstream is read eagerly,
 * only the newest complete frame is kept, and it is handed over only when the
 * response is ready for more (highWaterMark 0 + pull, which Next.js drives from
 * the socket's drain events). Frames the browser cannot keep up with are
 * dropped here rather than delayed.
 */
export async function GET(req: Request, { params }: Params) {
  const { instance, kind } = await params;
  const inst = await findInstance(instance);
  if (!inst?.config) return NextResponse.json({ error: "unknown instance" }, { status: 404 });

  const port =
    kind === "objdetect" ? inst.config.objdetect_stream_port : inst.config.apriltags_stream_port;

  const socket = net.createConnection({ host: "127.0.0.1", port });
  const parser = new MjpegFrameParser();
  let latest: Buffer | null = null;
  let closed = false;
  let wake: (() => void) | null = null;

  const body = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        socket.on("connect", () => {
          socket.write(`GET ${MJPEG_PATH} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`);
        });

        const end = () => {
          if (closed) return;
          closed = true;
          socket.destroy(); // releases the Northstar worker immediately
          try {
            controller.close();
          } catch {
            /* already closed or cancelled */
          }
          wake?.();
        };

        socket.on("data", (chunk: Buffer) => {
          try {
            for (const frame of parser.push(chunk)) latest = frame;
          } catch {
            end();
            return;
          }
          if (latest) wake?.();
        });
        socket.on("error", end);
        socket.on("close", end);
        req.signal.addEventListener("abort", end);
      },

      pull(controller) {
        const deliver = () => {
          if (closed || !latest) return false;
          controller.enqueue(mjpegPart(latest));
          latest = null;
          return true;
        };
        if (deliver() || closed) return;
        return new Promise<void>((resolve) => {
          wake = () => {
            if (deliver() || closed) {
              wake = null;
              resolve();
            }
          };
        });
      },

      cancel() {
        closed = true;
        socket.destroy();
      },
    },
    { highWaterMark: 0 },
  );

  return new Response(body, {
    headers: {
      "Content-Type": `multipart/x-mixed-replace; boundary=${MJPEG_BOUNDARY}`,
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
    },
  });
}
