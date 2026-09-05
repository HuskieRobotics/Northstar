import { NextResponse } from "next/server";
import { findInstance } from "@/lib/discovery";
import { MJPEG_BOUNDARY, MJPEG_PATH } from "@/lib/contract";
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
 */
export async function GET(req: Request, { params }: Params) {
  const { instance, kind } = await params;
  const inst = await findInstance(instance);
  if (!inst?.config) return NextResponse.json({ error: "unknown instance" }, { status: 404 });

  const port =
    kind === "objdetect" ? inst.config.objdetect_stream_port : inst.config.apriltags_stream_port;

  const socket = net.createConnection({ host: "127.0.0.1", port });
  let headersDone = false;

  const body = new ReadableStream({
    start(controller) {
      let buf = Buffer.alloc(0);

      socket.on("connect", () => {
        socket.write(`GET ${MJPEG_PATH} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`);
      });

      socket.on("data", (chunk: Buffer) => {
        if (!headersDone) {
          buf = Buffer.concat([buf, chunk]);
          // Strip the upstream HTTP headers; the multipart boundary is fixed by
          // StreamServer.py and declared in the contract, because our own
          // response headers are sent before we could read theirs.
          const idx = buf.indexOf("\r\n\r\n");
          if (idx === -1) return;
          headersDone = true;
          const rest = buf.subarray(idx + 4);
          if (rest.length) controller.enqueue(new Uint8Array(rest));
          buf = Buffer.alloc(0);
          return;
        }
        controller.enqueue(new Uint8Array(chunk));
      });

      const end = () => {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      socket.on("error", end);
      socket.on("close", end);

      req.signal.addEventListener("abort", () => {
        socket.destroy(); // releases the Northstar worker immediately
        end();
      });
    },
    cancel() {
      socket.destroy();
    },
  });

  return new Response(body, {
    headers: {
      "Content-Type": `multipart/x-mixed-replace; boundary=${MJPEG_BOUNDARY}`,
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
    },
  });
}
