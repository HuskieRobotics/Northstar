import path from "node:path";

/**
 * Environment settings (design doc §8.1) so one build runs on the Mac mini and
 * on a laptop with no code changes.
 */

const env = process.env;

/** roboRIO NT server. Set to 127.0.0.1 to point at a WPILib simulation. */
export const NT_SERVER = env.NORTHSTAR_NT_SERVER ?? "10.30.61.2";

/** Discovery mode: launchd | process | auto. */
export const DISCOVERY_MODE = (env.NORTHSTAR_DISCOVERY ?? "auto") as
  | "launchd"
  | "process"
  | "auto";

/** Repo root, used to resolve relative calibration_folder / video_folder. */
export const REPO_ROOT = env.NORTHSTAR_REPO_ROOT ?? path.resolve(process.cwd(), "..");

/**
 * Development aid only — scan cameras/robots/<profile>/config*.json for the
 * expected set. NEVER enable on a robot: that folder is a superset holding
 * configs for cameras that do not exist on every robot, so it would report
 * permanently-missing instances. launchd is the authority there.
 */
export const EXPECTED_SCAN_PROFILE = env.NORTHSTAR_EXPECTED_PROFILE ?? "";

/**
 * Startup grace window. The Mac mini boots before the roboRIO, so shortly after
 * power-on everything is legitimately unestablished. Default is a guess; tune
 * against measured cold boots.
 */
export const STARTUP_GRACE_SECONDS = Number(env.NORTHSTAR_STARTUP_GRACE ?? 90);

/** Thumbnail refresh cadence, milliseconds. Tune against measured CPU impact. */
export const SNAPSHOT_INTERVAL_MS = Number(env.NORTHSTAR_SNAPSHOT_INTERVAL ?? 2500);

/** Robot loop rate, for converting CyclesWithNoResults into seconds. */
export const ROBOT_LOOP_HZ = Number(env.NORTHSTAR_LOOP_HZ ?? 50);

/** Free-space warning threshold for the videos volume, in GB. */
export const DISK_WARN_GB = Number(env.NORTHSTAR_DISK_WARN_GB ?? 20);

export const resolveRepoPath = (p: string) =>
  path.isAbsolute(p) ? p : path.resolve(REPO_ROOT, p);
