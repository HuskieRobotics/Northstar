// Spike: acceptance items 2, 4, 5, 7 from webAppDesign.md §14.2.
//
//   2. Late topic announcement  — topics appear after the client is already running
//   4. Reconnection             — server quits and comes back; no client restart
//   5. Server not yet present   — client starts before the server exists (the boot race)
//   7. Stability                — no unbounded growth over the window
//
// Subscribes ONCE at startup and never re-subscribes, so any data after a
// reconnect proves the client re-established subscriptions on its own.
//
// Usage: node test-resilience.ts [serverAddr] [seconds]

import { NT4_Client } from "./vendor/NT4.ts";

const addr = process.argv[2] ?? "127.0.0.1";
const seconds = Number(process.argv[3] ?? 300);

const started = Date.now();
const t = () => ((Date.now() - started) / 1000).toFixed(1).padStart(6);
const log = (msg: string) => console.log(`[${t()}s] ${msg}`);

let connected = false;
let connects = 0;
let disconnects = 0;
let msgsThisSecond = 0;
let totalMsgs = 0;
const topicsSeen = new Set<string>();
let announcedThisSecond = 0;
let firstDataAfterConnect: number | null = null;

const client = new NT4_Client(
  addr,
  [5810],
  "northstar_webapp_spike",
  (topic) => {
    if (!topicsSeen.has(topic.name)) announcedThisSecond++;
    topicsSeen.add(topic.name);
  },
  () => {},
  (_topic, _ts, _value) => {
    msgsThisSecond++;
    totalMsgs++;
    if (firstDataAfterConnect === null) {
      firstDataAfterConnect = Date.now();
    }
  },
  () => {
    connected = true;
    connects++;
    firstDataAfterConnect = null;
    log(`*** CONNECTED (#${connects}) — server time ${client.getServerTime_us()}`);
  },
  () => {
    connected = false;
    disconnects++;
    log(`*** DISCONNECTED (#${disconnects}) — topics known: ${topicsSeen.size}`);
    topicsSeen.clear();
  },
);

log(`Node ${process.version} — target ${addr}:5810, running ${seconds}s`);
client.connect();

// Subscribed exactly once, here. Never again.
client.subscribe([""], true, false, 0.1);
log("subscribed (prefix \"\") — will NOT re-subscribe for the rest of the run");

let tick = 0;
const timer = setInterval(() => {
  tick++;
  const heap = (process.memoryUsage().heapUsed / 1048576).toFixed(1);
  const rss = (process.memoryUsage().rss / 1048576).toFixed(1);
  const state = connected ? "UP  " : "DOWN";
  const latency = firstDataAfterConnect
    ? ` firstData=+${((firstDataAfterConnect - started) / 1000).toFixed(1)}s`
    : "";
  if (tick % 5 === 0 || announcedThisSecond > 0 || (!connected && tick % 5 === 0)) {
    log(
      `${state} msgs/s=${String(msgsThisSecond).padStart(5)} topics=${String(topicsSeen.size).padStart(4)}` +
        ` newTopics=${announcedThisSecond} heap=${heap}MB rss=${rss}MB${latency}`,
    );
  }
  msgsThisSecond = 0;
  announcedThisSecond = 0;
}, 1000);

setTimeout(() => {
  clearInterval(timer);
  console.log("\n=== summary ===");
  console.log(`connects:    ${connects}`);
  console.log(`disconnects: ${disconnects}`);
  console.log(`total msgs:  ${totalMsgs}`);
  console.log(`topics now:  ${topicsSeen.size}`);
  console.log(`heap:        ${(process.memoryUsage().heapUsed / 1048576).toFixed(1)} MB`);
  console.log(`rss:         ${(process.memoryUsage().rss / 1048576).toFixed(1)} MB`);
  console.log(
    `\nPASS criteria: connects >= 2, data resumed after each reconnect, no crash, ` +
      `topics re-announced without re-subscribing.`,
  );
  process.exit(0);
}, seconds * 1000);
