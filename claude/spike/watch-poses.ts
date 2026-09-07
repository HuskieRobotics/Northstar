// Spike: watch the pose-related topics over time and report peak values, to see
// what appears when a camera actually detects an AprilTag.
//
// Usage: node watch-poses.ts [serverAddr] [seconds]

import { NT4_Client } from "./vendor/NT4.ts";

const addr = process.argv[2] ?? "127.0.0.1";
const seconds = Number(process.argv[3] ?? 20);

const POSE3D_BYTES = 56; // 3 doubles translation + 4 doubles quaternion

const watch = [
  "/AdvantageKit/RealOutputs/Vision/AprilTags",
  "/AdvantageKit/RealOutputs/Vision/RejectedAprilTags",
  "/AdvantageKit/RealOutputs/Vision/RobotPosesAccepted",
  "/AdvantageKit/RealOutputs/Vision/RobotPosesRejected",
  "/AdvantageKit/RealOutputs/Vision/IsUpdating",
  "/AdvantageKit/RealOutputs/Vision/IsEnabled",
  "/AdvantageKit/Vision/BCH/PoseObservations",
  "/AdvantageKit/Vision/BCH/AprilTags/Frames/length",
  "/AdvantageKit/Vision/BCH/AprilTags/Fps",
  "/northstar_BCH/output/observations",
];

type Stat = { updates: number; peak: number; last: unknown; peakAt?: string };
const stats = new Map<string, Stat>(watch.map((n) => [n, { updates: 0, peak: 0, last: null }]));

const magnitude = (v: unknown): number => {
  if (v instanceof Uint8Array) return v.length;
  if (Array.isArray(v)) return v.length;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") return v;
  return 0;
};

const client = new NT4_Client(
  addr,
  [5810],
  "northstar_webapp_spike",
  () => {},
  () => {},
  (topic, _ts, value) => {
    const s = stats.get(topic.name);
    if (!s) return;
    s.updates++;
    s.last = value;
    const m = magnitude(value);
    if (m > s.peak) {
      s.peak = m;
      s.peakAt = new Date().toLocaleTimeString();
      console.log(`  ↑ ${topic.name.replace("/AdvantageKit", "")} → ${m}`);
    }
  },
  () => console.log(`[connect] ${addr}`),
  () => console.log("[disconnect]"),
);

client.connect();
client.subscribe(watch, false, true, 0.02); // exact topics, sendAll, 50Hz

console.log(`Watching ${watch.length} topics for ${seconds}s — move a tag into view now.\n`);

setTimeout(() => {
  console.log("\n=== peaks over the window ===");
  for (const [name, s] of stats) {
    const short = name.replace("/AdvantageKit", "");
    const poses = name.includes("Poses") || name.includes("AprilTags")
      ? `  (${s.peak % POSE3D_BYTES === 0 ? s.peak / POSE3D_BYTES : "?"} × Pose3d)`
      : "";
    console.log(
      `${short}\n    updates=${s.updates}  peak=${s.peak}${poses}  ${s.peakAt ? "at " + s.peakAt : ""}`,
    );
  }
  process.exit(0);
}, seconds * 1000);
