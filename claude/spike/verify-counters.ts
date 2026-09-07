// Verify the 3061-lib counter changes (§7.5.1):
//   1. CyclesWithNoResults logged with ENABLE_EXTRA_LOGGING off
//   2. RejectedPoseCount present, incrementing, and eligibility-gated
//
// Watches every camera location, not just BCH, and reports deltas per window so
// the derived accept/reject ratio can be sanity-checked.
//
// Usage: node verify-counters.ts [serverAddr] [seconds]

import { NT4_Client } from "./vendor/NT4.ts";

const addr = process.argv[2] ?? "127.0.0.1";
const seconds = Number(process.argv[3] ?? 45);

type Counters = Record<string, number>;
const cur = new Map<string, Counters>(); // camera -> {key: value}
const base = new Map<string, Counters>();
const seenKeys = new Set<string>();
let isEnabled: unknown = "?";
let camerasToConsider: unknown = "?";
const t0 = Date.now();
const el = () => ((Date.now() - t0) / 1000).toFixed(0).padStart(3);

const client = new NT4_Client(
  addr,
  [5810],
  "counter_verify",
  (topic) => {
    const m = topic.name.match(/RealOutputs\/Vision\/([^/]+)\/(UpdatePoseCount|RejectedPoseCount|CyclesWithNoResults)$/);
    if (m) seenKeys.add(`${m[1]}/${m[2]}`);
  },
  () => {},
  (topic, _ts, value) => {
    if (topic.name.endsWith("/IsEnabled")) isEnabled = value;
    else if (topic.name.endsWith("/CamerasToConsider")) camerasToConsider = value;
    const m = topic.name.match(
      /RealOutputs\/Vision\/([^/]+)\/(UpdatePoseCount|RejectedPoseCount|CyclesWithNoResults)$/,
    );
    if (!m || typeof value !== "number") return;
    const [, cam, key] = m;
    if (!cur.has(cam)) cur.set(cam, {});
    cur.get(cam)![key] = value;
    if (!base.has(cam)) base.set(cam, {});
    if (base.get(cam)![key] === undefined) base.get(cam)![key] = value;
  },
  () => console.log(`connected to ${addr}\n`),
  () => console.log("disconnected"),
);

client.connect();
client.subscribe(
  ["/AdvantageKit/RealOutputs/Vision/"],
  true,
  false,
  0.1,
);

let last = "";
const timer = setInterval(() => {
  const rows: string[] = [];
  for (const [cam, c] of [...cur].sort()) {
    const b = base.get(cam)!;
    const dAcc = (c.UpdatePoseCount ?? 0) - (b.UpdatePoseCount ?? 0);
    const dRej = (c.RejectedPoseCount ?? 0) - (b.RejectedPoseCount ?? 0);
    const tot = dAcc + dRej;
    const pct = tot > 0 ? `${((dAcc / tot) * 100).toFixed(0)}% acc` : "—";
    rows.push(
      `${cam.padEnd(5)} acc=${String(c.UpdatePoseCount ?? "-").padStart(5)}(+${dAcc}) ` +
        `rej=${String(c.RejectedPoseCount ?? "-").padStart(5)}(+${dRej}) ` +
        `noResults=${String(c.CyclesWithNoResults ?? "-").padStart(4)} ${pct}`,
    );
  }
  const line = rows.join("\n");
  if (line && line !== last) {
    console.log(`[${el()}s] enabled=${isEnabled} consider=${camerasToConsider}\n${line}\n`);
    last = line;
  }
}, 1000);

setTimeout(() => {
  clearInterval(timer);
  console.log("=== which counters were announced ===");
  const want = ["UpdatePoseCount", "RejectedPoseCount", "CyclesWithNoResults"];
  const cams = [...new Set([...seenKeys].map((k) => k.split("/")[0]))].sort();
  for (const cam of cams) {
    const have = want.map((w) => (seenKeys.has(`${cam}/${w}`) ? `✅ ${w}` : `❌ ${w}`));
    console.log(`${cam.padEnd(6)} ${have.join("   ")}`);
  }
  if (cams.length === 0) console.log("(none seen — is the robot code running?)");
  process.exit(0);
}, seconds * 1000);
