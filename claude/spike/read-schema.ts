// NT publishes struct schemas as raw text under /.schema/struct:<Name>.
// Read the PoseObservation schema to see whether per-observation acceptance
// data is available client-side without robot-code changes.
//
// Usage: node read-schema.ts [serverAddr] [seconds]

import { NT4_Client } from "./vendor/NT4.ts";

const addr = process.argv[2] ?? "127.0.0.1";
const seconds = Number(process.argv[3] ?? 8);

const schemas = new Map<string, string>();
const dec = new TextDecoder();

const client = new NT4_Client(
  addr,
  [5810],
  "schema_probe",
  () => {},
  () => {},
  (topic, _ts, value) => {
    if (topic.name.includes(".schema") && value instanceof Uint8Array) {
      schemas.set(topic.name, dec.decode(value));
    }
  },
  () => console.log("connected\n"),
  () => {},
);

client.connect();
client.subscribe(["/AdvantageKit/.schema/"], true, false, 0.1);

setTimeout(() => {
  for (const name of ["PoseObservation", "Pose3d"]) {
    const key = `/AdvantageKit/.schema/struct:${name}`;
    console.log(`=== ${name} ===`);
    console.log(schemas.get(key) ?? "(not received)");
    console.log();
  }
  process.exit(0);
}, seconds * 1000);
