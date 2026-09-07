import { NextResponse } from "next/server";
import { correlate } from "@/lib/events";
import { ensureSampler } from "@/lib/cablingHistory";
import { watcherStatus } from "@/lib/frameLossWatcher";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  ensureSampler();
  const hours = Math.min(72, Number(new URL(req.url).searchParams.get("hours") ?? 6));
  try {
    const data = await correlate(Date.now() - hours * 3600_000);
    return NextResponse.json({ ...data, watcher: watcherStatus() });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
