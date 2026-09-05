// Dump EVERY announced topic name (not a filtered view), one per line, sorted.
// AdvantageKit creates topics lazily on first record, so an inventory taken from
// an idle system is incomplete. Snapshot idle vs. active and diff.
//
// Usage: node snapshot-topics.ts [serverAddr] [seconds] > topics.txt

import { NT4_Client } from "./vendor/NT4.ts";

const addr = process.argv[2] ?? "127.0.0.1";
const seconds = Number(process.argv[3] ?? 15);

const all = new Map<string, string>(); // name -> type

const client = new NT4_Client(
  addr,
  [5810],
  "topic_snapshot",
  (topic) => all.set(topic.name, topic.type),
  () => {},
  () => {},
  () => console.error("connected"),
  () => console.error("disconnected"),
);

client.connect();
client.subscribe([""], true, false, 0.1);

setTimeout(() => {
  for (const name of [...all.keys()].sort()) {
    console.log(`${name}\t${all.get(name)}`);
  }
  console.error(`${all.size} topics`);
  process.exit(0);
}, seconds * 1000);
