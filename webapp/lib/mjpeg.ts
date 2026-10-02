import net from "node:net";
import { MJPEG_BOUNDARY, MJPEG_PATH } from "./contract";

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

const HEADER_END = Buffer.from("\r\n\r\n");
const MAX_FRAME_BYTES = 16 << 20;

/**
 * Splits the raw bytes of a StreamServer.py response into JPEG frames.
 *
 * Each part is `--FRAME\r\nContent-Type: ...\r\nContent-Length: N\r\n\r\n`
 * followed by N bytes of JPEG. A header block with no Content-Length carries
 * no frame and is skipped, which is how the HTTP response headers at the start
 * of the stream are discarded.
 */
export class MjpegFrameParser {
  private buf: Buffer = Buffer.alloc(0);

  /** Feed upstream bytes; returns the frames completed by this chunk, oldest first. */
  push(chunk: Buffer): Buffer[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const frames: Buffer[] = [];
    for (;;) {
      const headerEnd = this.buf.indexOf(HEADER_END);
      if (headerEnd === -1) {
        if (this.buf.length > 1 << 16) throw new Error("MJPEG part header too large");
        return frames;
      }
      const header = this.buf.subarray(0, headerEnd).toString("latin1");
      const match = /content-length:\s*(\d+)/i.exec(header);
      if (!match) {
        this.buf = this.buf.subarray(headerEnd + HEADER_END.length);
        continue;
      }
      const length = Number(match[1]);
      if (length > MAX_FRAME_BYTES) throw new Error("frame too large");
      const start = headerEnd + HEADER_END.length;
      if (this.buf.length < start + length) return frames;
      // Copy so the frame does not pin the (possibly much larger) buffer.
      frames.push(Buffer.from(this.buf.subarray(start, start + length)));
      this.buf = this.buf.subarray(start + length);
    }
  }
}

/** Wrap one JPEG as a multipart/x-mixed-replace part using MJPEG_BOUNDARY. */
export function mjpegPart(jpeg: Buffer): Uint8Array {
  const head = Buffer.from(
    `--${MJPEG_BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`,
    "latin1",
  );
  return new Uint8Array(Buffer.concat([head, jpeg, Buffer.from("\r\n")]));
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
