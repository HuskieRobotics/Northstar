import { NextResponse } from "next/server";
import { discoverInstances } from "@/lib/discovery";
import { DISCOVERY_MODE, NT_SERVER, REPO_ROOT } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json({
      settings: { discoveryMode: DISCOVERY_MODE, ntServer: NT_SERVER, repoRoot: REPO_ROOT },
      instances: await discoverInstances(),
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
