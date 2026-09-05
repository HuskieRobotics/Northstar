import { NextResponse } from "next/server";
import { findInstance } from "@/lib/discovery";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import path from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ instance: string; stream: string }> };

export async function GET(_req: Request, { params }: Params) {
  const { instance, stream } = await params;
  const inst = await findInstance(instance);
  const file = stream === "err" ? inst?.errLog : inst?.outLog;
  if (!file) return NextResponse.json({ error: "no log file" }, { status: 404 });

  const nodeStream = createReadStream(file);
  return new Response(Readable.toWeb(nodeStream) as ReadableStream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="${path.basename(file)}"`,
    },
  });
}
