// Do NTClients entries persist after a client disconnects, and is the `@<n>`
// suffix stable? Bears on using SystemStats/NTClients as a status-4 fallback.
//
// Usage: node check-ntclients.ts [serverAddr] [seconds]

import { NT4_Client } from "./vendor/NT4.ts";

const addr = process.argv[2] ?? "127.0.0.1";
const seconds = Number(process.argv[3] ?? 8);

const all = new Set<string>();
const clientVals = new Map<string, unknown>();

const client = new NT4_Client(
  addr,
  [5810],
  "ntclient_probe",
  (topic) => all.add(topic.name),
  () => {},
  (topic, _ts, value) => {
    if (topic.name.includes("NTClients")) clientVals.set(topic.name, value);
  },
  () => console.log("connected"),
  () => console.log("disconnected"),
);

client.connect();
client.subscribe([""], true, false, 0.1);

setTimeout(() => {
  console.log(`\ntotal topics announced: ${all.size}`);

  const byClient = new Map<string, Record<string, unknown>>();
  for (const [name, val] of clientVals) {
    const m = name.match(/NTClients\/(.+?)\/(\w+)$/);
    if (!m) continue;
    const rec = byClient.get(m[1]) ?? {};
    rec[m[2]] = val instanceof Uint8Array ? `raw[${val.length}B]` : val;
    byClient.set(m[1], rec);
  }

  console.log(`\n=== NTClients entries (${byClient.size}) ===`);
  for (const [name, rec] of [...byClient].sort()) {
    console.log(`${name}\n    Connected=${rec.Connected}  port=${rec.RemotePort}  ip=${rec.IPAddress}`);
  }

  const live = [...byClient].filter(([, r]) => r.Connected === true).length;
  console.log(`\nConnected=true: ${live} of ${byClient.size}`);
  console.log(
    live < byClient.size
      ? "=> STALE ENTRIES PERSIST. Presence is not liveness; read the Connected value."
      : "=> no stale entries in this sample.",
  );

  console.log(`\n/northstar_* subtrees present:`);
  const subs = new Map<string, number>();
  for (const n of all) {
    const m = n.match(/^\/(northstar_[^/]+)\/([^/]+)\//);
    if (m) subs.set(`${m[1]}/${m[2]}`, (subs.get(`${m[1]}/${m[2]}`) ?? 0) + 1);
  }
  for (const [k, v] of [...subs].sort()) console.log(`    ${k}/* — ${v} topics`);

  process.exit(0);
}, seconds * 1000);
