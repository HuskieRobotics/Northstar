import { NextResponse } from "next/server";
import { findInstance } from "@/lib/discovery";
import { grabSnapshot } from "@/lib/mjpeg";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ instance: string; kind: string }> };

/**
 * One JPEG frame: connect, read a frame, disconnect immediately so the worker
 * stops encoding. See lib/mjpeg.ts for why that matters.
 */
export async function GET(_req: Request, { params }: Params) {
  const { instance, kind } = await params;
  const inst = await findInstance(instance);
  if (!inst?.config) return NextResponse.json({ error: "unknown instance" }, { status: 404 });

  const port =
    kind === "objdetect" ? inst.config.objdetect_stream_port : inst.config.apriltags_stream_port;
  const enabled =
    kind === "objdetect" ? inst.config.objdetect_enable : inst.config.apriltags_enable;
  if (!enabled) return NextResponse.json({ error: "pipeline disabled" }, { status: 404 });

  try {
    const jpeg = await grabSnapshot(port);
    return new Response(new Uint8Array(jpeg), {
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "no-store",
        "Content-Length": String(jpeg.length),
      },
    });
  } catch (e) {
    // Render an honest placeholder rather than a spinner that never resolves.
    return NextResponse.json({ error: (e as Error).message }, { status: 503 });
  }
}
