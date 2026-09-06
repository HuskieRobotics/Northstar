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

/**
 * WhatCable, for USB link diagnostics on the cameras page.
 *
 * Cached rather than polled hard: the CLI performs USB probing, and probing a
 * bus that is actively streaming camera frames is not obviously free. Set the
 * cache to 0 to disable the integration entirely.
 */
export const WHATCABLE_BIN = env.NORTHSTAR_WHATCABLE_BIN ?? "whatcable";
export const WHATCABLE_CACHE_MS = Number(env.NORTHSTAR_WHATCABLE_CACHE_MS ?? 30_000);
/**
 * Deep USB probing is OFF by default. Measured on a Basler daA1280-54um: with
 * and without `--no-usb-probe`, the device speed, usbVersion and port transports
 * come back identical — everything this app reads. Probing buys us nothing and
 * this runs on a machine whose cameras are already dropping frames, so the
 * cautious default is free. Set NORTHSTAR_WHATCABLE_PROBE=1 to re-enable.
 */
export const WHATCABLE_NO_PROBE = env.NORTHSTAR_WHATCABLE_PROBE !== "1";

/** How often to poll instance logs for the start/end of a frame-loss episode. */
export const FRAMELOSS_WATCH_MS = Number(env.NORTHSTAR_FRAMELOSS_WATCH_MS ?? 400);

/** Floor between event-triggered USB checks for one instance. */
export const FRAMELOSS_TRIGGER_GAP_MS = Number(env.NORTHSTAR_FRAMELOSS_TRIGGER_GAP_MS ?? 3000);

/** How often the link-state sampler runs. 0 disables history collection. */
export const WHATCABLE_HISTORY_MS = Number(env.NORTHSTAR_WHATCABLE_HISTORY_MS ?? 30_000);

/**
 * How far back before a frame-loss episode a link change still counts as
 * "preceding" it. Long enough to catch a fallback that happened a little
 * earlier, short enough that unrelated changes are not swept in.
 */
export const CORRELATION_WINDOW_MS = Number(env.NORTHSTAR_CORRELATION_WINDOW_MS ?? 120_000);

export const resolveRepoPath = (p: string) =>
  path.isAbsolute(p) ? p : path.resolve(REPO_ROOT, p);
