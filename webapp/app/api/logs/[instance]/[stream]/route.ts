import { NextResponse } from "next/server";
import { findInstance } from "@/lib/discovery";
import { classify, currentBootIndex, readLogTail } from "@/lib/logs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ instance: string; stream: string }> };

export async function GET(req: Request, { params }: Params) {
  const { instance, stream } = await params;
  const lines = Math.min(2000, Number(new URL(req.url).searchParams.get("lines") ?? 200));

  const inst = await findInstance(instance);
  if (!inst) return NextResponse.json({ error: "unknown instance" }, { status: 404 });

  const file = stream === "err" ? inst.errLog : inst.outLog;
  if (!file) {
    // Not an error: a hand-run instance writes to the terminal, not to logs/.
    return NextResponse.json({
      available: false,
      reason: "No log file for this instance — it is not running under launchd.",
      lines: [],
    });
  }

  try {
    const tail = await readLogTail(file, lines);
    return NextResponse.json({
      available: true,
      file,
      size: tail.size,
      nextOffset: tail.size,
      truncatedFirstLine: tail.truncatedFirstLine,
      bootIndex: currentBootIndex(tail.lines),
      lines: tail.lines.map((text) => ({ text, kind: classify(text) })),
    });
  } catch (e) {
    return NextResponse.json({ available: false, reason: (e as Error).message, lines: [] });
  }
}
