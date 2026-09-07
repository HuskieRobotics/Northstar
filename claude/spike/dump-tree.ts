// Spike: confirm AdvantageScope's NT4.ts runs unmodified under bare Node, and
// dump the live NT topic tree to verify the key names assumed in
// claude/webAppDesign.md (§7.3, §7.4).
//
// Usage: node dump-tree.ts [serverAddr] [seconds]

import { NT4_Client, NT4_Topic } from "./vendor/NT4.ts";

const addr = process.argv[2] ?? "127.0.0.1";
const seconds = Number(process.argv[3] ?? 12);

const topics = new Map<string, NT4_Topic>();
const dataSeen = new Map<string, { count: number; last: unknown; ts: number }>();
let connected = false;

const client = new NT4_Client(
  addr,
  [5810],
  "northstar_webapp_spike",
  (topic) => topics.set(topic.name, topic),
  (topic) => topics.delete(topic.name),
  (topic, timestamp_us, value) => {
    const prev = dataSeen.get(topic.name);
    dataSeen.set(topic.name, {
      count: (prev?.count ?? 0) + 1,
      last: value,
      ts: timestamp_us,
    });
  },
  () => {
    connected = true;
    console.log(`[connect] handshake complete with ${addr}`);
  },
  () => {
    connected = false;
    console.log("[disconnect] server connection lost");
  },
);

console.log(`Node ${process.version} — connecting to ${addr}:5810 ...`);
client.connect();
client.subscribe([""], true, false, 0.1); // prefix mode, everything

const describe = (v: unknown): string => {
  if (v instanceof Uint8Array) return `raw[${v.length}B]`;
  if (Array.isArray(v)) return `array[${v.length}]`;
  if (typeof v === "string") return JSON.stringify(v.length > 40 ? v.slice(0, 40) + "..." : v);
  return String(v);
};

setTimeout(() => {
  console.log(`\n=== connected: ${connected} | topics announced: ${topics.size} ===`);
  const serverTime = client.getServerTime_us();
  console.log(`serverTime_us: ${serverTime}  (null means RTT sync never completed)`);

  const interesting = [...topics.keys()]
    .filter((n) => /Vision|northstar/i.test(n))
    .sort();

  console.log(`\n--- Vision / northstar topics (${interesting.length}) ---`);
  for (const name of interesting) {
    const t = topics.get(name)!;
    const d = dataSeen.get(name);
    console.log(
      `${name}\n    type=${t.type}  updates=${d?.count ?? 0}  last=${d ? describe(d.last) : "(none)"}`,
    );
  }

  console.log(`\n--- top-level roots ---`);
  const roots = new Set([...topics.keys()].map((n) => n.split("/").slice(0, 2).join("/")));
  console.log([...roots].sort().join("\n"));

  process.exit(0);
}, seconds * 1000);
