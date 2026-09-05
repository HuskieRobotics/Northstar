// Decode PoseObservation structs and correlate observation count / numTags
// against the global tag-pose array lengths. Answers: is an array length a tag
// count, or an observation count? Run with 2+ tags in one frame.
//
// Schema (fixed 112 B, tight packing, little-endian):
//   0   double timestamp
//   8   Pose3d cameraPose (56)
//   64  double latencySecs
//   72  double averageAmbiguity
//   80  double reprojectionError
//   88  int64  tagsSeenBitMap
//   96  int32  numTags
//   100 double averageTagDistance
//   108 int32  type   (0=SINGLE_TAG, 1=MULTI_TAG)
//
// Usage: node decode-multitag.ts [serverAddr] [seconds]

import { NT4_Client } from "./vendor/NT4.ts";

const addr = process.argv[2] ?? "127.0.0.1";
const seconds = Number(process.argv[3] ?? 20);
const OBS = 112;
const POSE3D = 56;

type Obs = { numTags: number; type: number; bitmap: bigint; ambiguity: number; reproj: number };

function decode(buf: Uint8Array): Obs[] {
  if (buf.length % OBS !== 0) throw new Error(`length ${buf.length} not a multiple of ${OBS}`);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out: Obs[] = [];
  for (let i = 0; i < buf.length / OBS; i++) {
    const o = i * OBS;
    out.push({
      ambiguity: dv.getFloat64(o + 72, true),
      reproj: dv.getFloat64(o + 80, true),
      bitmap: dv.getBigInt64(o + 88, true),
      numTags: dv.getInt32(o + 96, true),
      type: dv.getInt32(o + 108, true),
    });
  }
  return out;
}

const bits = (b: bigint) => {
  const ids: number[] = [];
  for (let i = 0; i < 64; i++) if ((b >> BigInt(i)) & 1n) ids.push(i);
  return ids;
};

let lastObs: Obs[] = [];
let poses = { AprilTags: 0, RejectedAprilTags: 0, RobotPosesAccepted: 0, RobotPosesRejected: 0 };
const seenCombos = new Map<string, number>();
let maxNumTags = 0;
let multiTagFrames = 0;
let singleTagFrames = 0;

const client = new NT4_Client(
  addr,
  [5810],
  "multitag_probe",
  () => {},
  () => {},
  (topic, _ts, value) => {
    const key = topic.name.split("/").pop()!;
    if (key === "PoseObservations" && value instanceof Uint8Array) {
      try {
        lastObs = decode(value);
      } catch (e) {
        console.log(`DECODE FAIL: ${(e as Error).message}`);
        return;
      }
      for (const o of lastObs) {
        maxNumTags = Math.max(maxNumTags, o.numTags);
        if (o.type === 1) multiTagFrames++;
        else singleTagFrames++;
      }
      if (lastObs.length > 0) {
        const totalTags = lastObs.reduce((a, o) => a + o.numTags, 0);
        const combo =
          `obs=${lastObs.length} totalNumTags=${totalTags} ` +
          `types=[${lastObs.map((o) => (o.type ? "MULTI" : "single")).join(",")}] ` +
          `tags=[${lastObs.map((o) => bits(o.bitmap).join("+")).join(" | ")}] ` +
          `→ acceptedPoses=${poses.RobotPosesAccepted} rejectedPoses=${poses.RobotPosesRejected} ` +
          `tagPoses=${poses.AprilTags} rejTagPoses=${poses.RejectedAprilTags}`;
        seenCombos.set(combo, (seenCombos.get(combo) ?? 0) + 1);
      }
    } else if (key in poses && value instanceof Uint8Array) {
      (poses as Record<string, number>)[key] = value.length / POSE3D;
    }
  },
  () => console.log("connected\n"),
  () => {},
);

client.connect();
client.subscribe(
  [
    "/AdvantageKit/Vision/BCH/PoseObservations",
    "/AdvantageKit/RealOutputs/Vision/AprilTags",
    "/AdvantageKit/RealOutputs/Vision/RejectedAprilTags",
    "/AdvantageKit/RealOutputs/Vision/RobotPosesAccepted",
    "/AdvantageKit/RealOutputs/Vision/RobotPosesRejected",
  ],
  false,
  true,
  0.02,
);

setTimeout(() => {
  console.log(`max numTags in one observation: ${maxNumTags}`);
  console.log(`observations typed MULTI_TAG: ${multiTagFrames}, SINGLE_TAG: ${singleTagFrames}\n`);
  console.log("=== distinct observed combinations (most frequent first) ===");
  for (const [combo, n] of [...seenCombos].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.log(`${String(n).padStart(4)}×  ${combo}`);
  }
  process.exit(0);
}, seconds * 1000);
