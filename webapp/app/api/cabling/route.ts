import { NextResponse } from "next/server";
import { cablingReport } from "@/lib/whatcable";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const force = new URL(req.url).searchParams.get("refresh") === "1";
  try {
    return NextResponse.json(await cablingReport(force));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
