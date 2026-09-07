import net from "node:net";
import { MJPEG_PATH } from "./contract";

/**
 * Northstar's MJPEG workers only encode a frame while a client is attached:
 *
 *   if stream_server.get_client_count() > 0:
 *       image = image.copy(); overlay(...); stream_server.set_frame(image)
 *
 * So an attached client costs a full-frame copy, overlay drawing and a JPEG
 * encode PER FRAME, on a Mac mini already running several vision pipelines at
 * `nice -20`. A dashboard holding six streams open permanently would measurably
 * degrade vision.
 *
 * Hence: grab ONE frame and disconnect immediately, so get_client_count() drops
 * back to zero and the worker stops encoding.
 */

const SOI = Buffer.from([0xff, 0xd8]); // JPEG start of image
const EOI = Buffer.from([0xff, 0xd9]); // JPEG end of image

export async function grabSnapshot(port: number, timeoutMs = 4000): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let buf = Buffer.alloc(0);
    let done = false;

    const finish = (err: Error | null, data?: Buffer) => {
      if (done) return;
      done = true;
      socket.destroy(); // critical: releases the worker immediately
      clearTimeout(timer);
      err ? reject(err) : resolve(data!);
    };

    const timer = setTimeout(() => finish(new Error(`snapshot timeout on port ${port}`)), timeoutMs);

    socket.on("connect", () => {
      socket.write(
        `GET ${MJPEG_PATH} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`,
      );
    });

    socket.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const start = buf.indexOf(SOI);
      if (start === -1) {
        // Discard headers we have already scanned past to bound memory.
        if (buf.length > 1 << 20) buf = buf.subarray(buf.length - 4096);
        return;
      }
      const end = buf.indexOf(EOI, start + 2);
      if (end === -1) {
        if (buf.length > 16 << 20) finish(new Error("frame too large"));
        return;
      }
      finish(null, buf.subarray(start, end + 2));
    });

    socket.on("error", (e) => finish(e));
    socket.on("close", () => finish(new Error("stream closed before a frame arrived")));
  });
}

/** Is anything listening on this port? Used to render honest placeholders. */
export async function portOpen(port: number, timeoutMs = 600): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const done = (v: boolean) => {
      socket.destroy();
      resolve(v);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.on("connect", () => done(true));
    socket.on("error", () => done(false));
  });
}
