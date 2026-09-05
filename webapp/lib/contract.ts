/**
 * EVERY coupling to Northstar and 3061-lib internals lives in this file.
 *
 * These are log strings, NetworkTables key names, and array layouts — none of
 * which are an API. Upstream 6328 changes are hand-merged into this fork, and a
 * reviewer looking at a vision diff has no reason to connect a reworded `print`
 * to this dashboard. See claude/webAppDesign.md §11.1.
 *
 * If something here stops matching, `npm run check-coupling` should fail.
 */

// ---------------------------------------------------------------------------
// Northstar log lines  (source: __init__.py, config/ConfigSource.py)
// ---------------------------------------------------------------------------

/** Printed once per second by each enabled pipeline. */
export const LOG_FPS_APRILTAG = /Running AprilTag pipeline at (\d+) fps/;
export const LOG_FPS_OBJDETECT = /Running object detection pipeline at (\d+) fps/;

/** Camera is not delivering frames. */
export const LOG_NO_FRAME = "No frame received, waiting for capture";

/**
 * Calibration missing / loaded for the camera NT currently reports.
 * Two different messages: __init__.py reports it every 5s while stuck,
 * ConfigSource.py reports it once when the camera id changes.
 */
export const LOG_NO_CALIBRATION = /No calibration (?:found|file) for camera (.*)$/;
export const LOG_CALIBRATION_LOADED = /Loaded calibration for camera (\S+) from (\S+)/;

/** Banner on every (re)start of the Python process. */
export const LOG_STARTING = "Starting Northstar...";

/** Recording transitions. */
export const LOG_RECORDING_START = "Starting recording";
export const LOG_RECORDING_STOP = "Stopping recording";

/** Waiting for the robot code to publish a camera id. */
export const LOG_WAITING_CAMERA_ID = "Waiting for camera ID to load calibration";

/** Every log line is prefixed with this format, from the same clock we run on. */
export const LOG_TIMESTAMP = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/;

// ---------------------------------------------------------------------------
// launchd  (source: cameras/robots/*/org.team3061.northstar.*.plist)
// ---------------------------------------------------------------------------

export const LAUNCHD_LABEL_PREFIX = "org.team3061.northstar.";

// ---------------------------------------------------------------------------
// Northstar NT topics  (source: output/OutputPublisher.py, config/ConfigSource.py)
// ---------------------------------------------------------------------------

export const nsOutput = (deviceId: string, key: string) => `/${deviceId}/output/${key}`;
export const nsConfig = (deviceId: string, key: string) => `/${deviceId}/config/${key}`;

export const NS_OUTPUT_KEYS = [
  "fps_apriltags",
  "fps_objdetect",
  "observations",
  "objdetect_observations",
  "power_metrics",
] as const;

export const NS_CONFIG_KEYS = [
  "camera_id",
  "camera_resolution_width",
  "camera_resolution_height",
  "camera_exposure",
  "camera_gain",
  "is_recording",
  "throttle_fps",
  "event_name",
  "match_type",
  "match_number",
] as const;

/** power_metrics is [cpu_mW, gpu_mW, ane_mW, pressureLevel]. */
export const POWER_PRESSURE_LEVELS = ["Nominal", "Fair", "Serious", "Critical"];
export const decodePressureLevel = (v: number): string =>
  v >= 0 && v < POWER_PRESSURE_LEVELS.length ? POWER_PRESSURE_LEVELS[v] : "Unknown";

/**
 * Decode /{device_id}/output/observations.
 *
 * Layout is VARIABLE and must be walked, never inferred from array length:
 *   [0]              pose-solution count: 0, 1 or 2
 *   next 8*count     per solution: error, x, y, z, qw, qx, qy, qz
 *   next 1           tag count N
 *   next N           tag ids
 *   remainder        only when tagangle_enable: per tag, id + 8 corner angles + distance
 *
 * Returns null when the payload does not match the expected shape — we show
 * "unrecognized format" rather than a confident wrong number.
 */
export function decodeObservations(
  a: number[] | null | undefined,
): { solutions: number; tagCount: number; tagIds: number[] } | null {
  if (!a || a.length < 1) return null;
  const solutions = a[0];
  if (solutions !== 0 && solutions !== 1 && solutions !== 2) return null;
  const tagCountIdx = 1 + solutions * 8;
  if (a.length < tagCountIdx + 1) return null;
  const tagCount = a[tagCountIdx];
  if (!Number.isInteger(tagCount) || tagCount < 0) return null;
  if (a.length < tagCountIdx + 1 + tagCount) return null;
  return {
    solutions,
    tagCount,
    tagIds: a.slice(tagCountIdx + 1, tagCountIdx + 1 + tagCount),
  };
}

// ---------------------------------------------------------------------------
// 3061-lib robot-side topics  (source: 3061-lib Vision.java)
// ---------------------------------------------------------------------------

const AK = "/AdvantageKit";

/** IO inputs — present in competition builds (ENABLE_EXTRA_LOGGING off). */
export const visionInput = (loc: string, key: string) => `${AK}/Vision/${loc}/${key}`;
/** Logged outputs. */
export const visionOutput = (loc: string, key: string) => `${AK}/RealOutputs/Vision/${loc}/${key}`;

export const VISION_CONNECTED = "Connected";
export const VISION_RECEIVING_FRAMES = "ReceivingFrames";
export const VISION_THERMAL = "ThermalPressure";
export const VISION_CPU_POWER = "CpuPower";
export const VISION_GPU_POWER = "GpuPower";
export const VISION_APRILTAG_FPS = "AprilTags/Fps";
export const VISION_OBJDETECT_FPS = "ObjDetect/Fps";

/**
 * Per-camera counters. Cumulative and monotonic — always display a delta over a
 * window, never the raw value.
 *
 * IMPORTANT: these are ABSENT, not zero, until that camera's first
 * acceptance/rejection. A camera that never came up has neither. Never infer
 * health from their presence; use CyclesWithNoResults, which exists from the
 * first cycle for every camera the robot code knows about.
 */
export const VISION_UPDATE_POSE_COUNT = "UpdatePoseCount";
export const VISION_REJECTED_POSE_COUNT = "RejectedPoseCount";
export const VISION_CYCLES_NO_RESULTS = "CyclesWithNoResults";

/** Global (not per-camera) vision outputs. */
export const VISION_IS_ENABLED = `${AK}/RealOutputs/Vision/IsEnabled`;
export const VISION_IS_UPDATING = `${AK}/RealOutputs/Vision/IsUpdating`;
export const VISION_CAMERAS_TO_CONSIDER = `${AK}/RealOutputs/Vision/CamerasToConsider`;

/**
 * NT server's own client table. Entries PERSIST after a client disconnects, and
 * `@<n>` increments per connection, so one device accumulates several entries.
 * Read the Connected value; never treat presence as liveness.
 */
export const NT_CLIENTS_PREFIX = `${AK}/SystemStats/NTClients/`;

/** device_id is `northstar_<camera location>`; 3061-lib uses the bare location. */
export const NORTHSTAR_DEVICE_PREFIX = "northstar_";
export const cameraLocationFor = (deviceId: string): string | null =>
  deviceId.startsWith(NORTHSTAR_DEVICE_PREFIX)
    ? deviceId.slice(NORTHSTAR_DEVICE_PREFIX.length)
    : null;

// ---------------------------------------------------------------------------
// Filesystem conventions
// ---------------------------------------------------------------------------

/** Mirrors sanitize_camera_id() in config/config.py. */
export const sanitizeCameraId = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, "");
export const calibrationFilename = (cameraId: string) =>
  `calibration${sanitizeCameraId(cameraId)}.yml`;

/** <device_id>_<YYYYMMDD>_<HHMMSS>[_event][_matchprefix+number][_raw].mkv */
export const MATCH_PREFIXES = ["", "p", "q", "e"];
export const VIDEO_FILENAME =
  /^(?<device>.+?)_(?<date>\d{8})_(?<time>\d{6})(?<raw>_raw)?(?:_(?<rest>.*))?\.mkv$/;

/** MJPEG endpoint and multipart boundary served by output/StreamServer.py. */
export const MJPEG_PATH = "/stream.mjpg";
export const MJPEG_BOUNDARY = "FRAME";
