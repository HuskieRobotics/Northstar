#!/usr/bin/env node
/**
 * Verify that the Northstar internals this dashboard depends on still exist.
 *
 * Upstream 6328 changes are hand-merged into this fork, and a reviewer looking
 * at a vision diff has no reason to connect a reworded `print` to a TypeScript
 * dashboard. Run this after every upstream merge:  npm run check-coupling
 *
 * Exits non-zero when something the app parses has disappeared.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = process.env.NORTHSTAR_REPO_ROOT ?? path.resolve(here, "..", "..");

/** [file, needle, why] — needles are literal substrings of the Python source. */
const CHECKS = [
  ["__init__.py", "Running AprilTag pipeline at", "FPS parsing and log highlighting"],
  ["__init__.py", "Running object detection pipeline at", "FPS parsing and log highlighting"],
  ["__init__.py", "No frame received, waiting for capture", "camera-delivering-frames signal"],
  ["__init__.py", "Starting Northstar...", "restart detection and the boot divider"],
  ["__init__.py", "Starting recording", "recording state in logs"],
  ["__init__.py", "has_calibration", "publishing is gated on calibration being present"],
  ["__init__.py", "No calibration found for camera", "calibration status from logs"],
  ["config/ConfigSource.py", "No calibration file for camera", "calibration status from logs"],
  ["config/ConfigSource.py", "Loaded calibration for camera", "calibration status from logs"],
  ["config/ConfigSource.py", "Waiting for camera ID to load calibration", "waiting-for-robot state"],
  ["config/config.py", "def sanitize_camera_id", "calibration filename lookup"],
  ["config/config.py", "calibration_folder", "calibration folder resolution"],
  ["output/StreamServer.py", "/stream.mjpg", "snapshot and stream proxy"],
  ["output/StreamServer.py", "boundary=FRAME", "multipart boundary for the stream proxy"],
  ["output/StreamServer.py", "def get_client_count", "snapshot-and-disconnect rationale"],
  ["apriltag_worker.py", "get_client_count() > 0", "frames encoded only while a client is attached"],
  ["objdetect_worker.py", "get_client_count() > 0", "frames encoded only while a client is attached"],
  ["output/OutputPublisher.py", '"fps_apriltags"', "FPS vitals"],
  ["output/OutputPublisher.py", '"fps_objdetect"', "FPS vitals"],
  ["output/OutputPublisher.py", '"observations"', "tag-count decoding"],
  ["output/OutputPublisher.py", '"power_metrics"', "power/thermal panel"],
  ["output/VideoWriter.py", 'filename_base + filename_match + ".mkv"', "recording filename parsing"],
];

/** Config keys the app reads out of cameras/robots/<profile>/config*.json. */
const CONFIG_KEYS = [
  "device_id",
  "apriltags_stream_port",
  "objdetect_stream_port",
  "apriltags_enable",
  "objdetect_enable",
  "video_folder",
];

let failures = 0;
const fail = (msg) => {
  console.error(`  ✕ ${msg}`);
  failures++;
};

console.log(`Checking Northstar coupling against ${REPO}\n`);

for (const [file, needle, why] of CHECKS) {
  const p = path.join(REPO, file);
  let body;
  try {
    body = await fs.readFile(p, "utf8");
  } catch {
    fail(`${file} not readable — needed for ${why}`);
    continue;
  }
  if (!body.includes(needle)) {
    fail(`${file}: missing ${JSON.stringify(needle)} — breaks ${why}`);
  }
}

// At least one real config file should still carry the keys we parse.
const robots = path.join(REPO, "cameras", "robots");
let sample = null;
try {
  for (const profile of await fs.readdir(robots)) {
    const dir = path.join(robots, profile);
    if (!(await fs.stat(dir)).isDirectory()) continue;
    const f = (await fs.readdir(dir)).find((x) => x.startsWith("config") && x.endsWith(".json"));
    if (f) {
      sample = path.join(dir, f);
      break;
    }
  }
} catch {
  /* handled below */
}

if (!sample) {
  fail("no cameras/robots/*/config*.json found — instance discovery parses these");
} else {
  const cfg = JSON.parse(await fs.readFile(sample, "utf8"));
  for (const k of CONFIG_KEYS) {
    if (!(k in cfg)) fail(`${path.relative(REPO, sample)}: missing config key "${k}"`);
  }
}

// Every launcher must timestamp its stderr, or currentBootIndex() and
// linesWithin() silently treat old error lines as current.
for (const profile of await fs.readdir(robots)) {
  const dir = path.join(robots, profile);
  if (!(await fs.stat(dir)).isDirectory()) continue;
  for (const f of (await fs.readdir(dir)).filter((x) => /^config.*\.sh$/.test(x))) {
    const body = await fs.readFile(path.join(dir, f), "utf8");
    if (!body.includes("exec 2> >(")) {
      fail(`${profile}/${f}: stderr is not timestamped — breaks boot/age filtering of error logs`);
    } else if (!body.includes("%Y-%m-%d %H:%M:%S")) {
      fail(`${profile}/${f}: timestamp format changed — breaks LOG_TIMESTAMP`);
    }
  }
}

console.log();
if (failures > 0) {
  console.error(`${failures} coupling check(s) FAILED.`);
  console.error("The dashboard reads Northstar internals that are not an API — see");
  console.error("claude/webAppDesign.md §11.1, and update webapp/lib/contract.ts to match.");
  process.exit(1);
}
console.log("All coupling checks passed.");
