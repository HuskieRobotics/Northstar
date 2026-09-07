// Is per-camera accepted/rejected derivable? Correlate the per-camera
// UpdatePoseCount and PoseObservations against the global accepted/rejected
// arrays over a window.
//
// Usage: node watch-accept.ts [serverAddr] [seconds]

import { NT4_Client } from "./vendor/NT4.ts";

const addr = process.argv[2] ?? "127.0.0.1";
const seconds = Number(process.argv[3] ?? 20);
const POSE3D = 56;
const POSEOBS = 112;

const topics = [
  "/AdvantageKit/RealOutputs/Vision/BCH/UpdatePoseCount",
  "/AdvantageKit/Vision/BCH/PoseObservations",
  "/AdvantageKit/RealOutputs/Vision/AprilTags",
  "/AdvantageKit/RealOutputs/Vision/RejectedAprilTags",
  "/AdvantageKit/RealOutputs/Vision/RobotPosesAccepted",
  "/AdvantageKit/RealOutputs/Vision/RobotPosesRejected",
  "/AdvantageKit/RealOutputs/Vision/IsUpdating",
];

const cur: Record<string, number> = {};
const peak: Record<string, number> = {};
const updates: Record<string, number> = {};

const val = (v: unknown, div: number) =>
  v instanceof Uint8Array ? v.length / div : typeof v === "number" ? v : v === true ? 1 : 0;

const client = new NT4_Client(
  addr,
  [5810],
  "accept_probe",
  () => {},
  () => {},
  (topic, _ts, value) => {
    const k = topic.name.split("/").pop()!;
    const div = topic.name.includes("PoseObservations") ? POSEOBS : POSE3D;
    const n = val(value, div);
    cur[k] = n;
    peak[k] = Math.max(peak[k] ?? 0, n);
    updates[k] = (updates[k] ?? 0) + 1;
  },
  () => console.log("connected\n"),
  () => console.log("disconnected"),
);

client.connect();
client.subscribe(topics, false, true, 0.02);

let last = "";
const timer = setInterval(() => {
  const line =
    `BCH: obs=${cur.PoseObservations ?? "-"} updateCount=${cur.UpdatePoseCount ?? "-"}  ||  ` +
    `global: tags=${cur.AprilTags ?? "-"} rejTags=${cur.RejectedAprilTags ?? "-"} ` +
    `accepted=${cur.RobotPosesAccepted ?? "-"} rejected=${cur.RobotPosesRejected ?? "-"} ` +
    `updating=${cur.IsUpdating ?? "-"}`;
  if (line !== last) {
    console.log(line);
    last = line;
  }
}, 500);

setTimeout(() => {
  clearInterval(timer);
  console.log("\n=== peaks / update counts ===");
  for (const k of Object.keys(peak).sort()) {
    console.log(`${k.padEnd(22)} peak=${String(peak[k]).padStart(5)}  updates=${updates[k]}`);
  }
  process.exit(0);
}, seconds * 1000);
