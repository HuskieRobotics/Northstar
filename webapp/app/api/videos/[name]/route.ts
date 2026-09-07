import { NextResponse } from "next/server";
import { listVideos } from "@/lib/system";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import path from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ name: string }> };

export async function GET(_req: Request, { params }: Params) {
  const { name } = await params;

  // Resolve against the known listing rather than joining user input onto a
  // path, so a crafted name cannot escape the video folder.
  const match = (await listVideos()).find((v) => v.name === path.basename(name));
  if (!match) return NextResponse.json({ error: "unknown recording" }, { status: 404 });

  const nodeStream = createReadStream(match.file);
  return new Response(Readable.toWeb(nodeStream) as ReadableStream, {
    headers: {
      "Content-Type": "video/x-matroska",
      "Content-Length": String(match.sizeBytes),
      "Content-Disposition": `attachment; filename="${match.name}"`,
    },
  });
}
