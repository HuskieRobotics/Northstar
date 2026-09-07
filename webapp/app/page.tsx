import Dashboard from "@/components/Dashboard";
import { SNAPSHOT_INTERVAL_MS } from "@/lib/settings";

export const dynamic = "force-dynamic";

export default function Page() {
  return <Dashboard snapshotIntervalMs={SNAPSHOT_INTERVAL_MS} />;
}
