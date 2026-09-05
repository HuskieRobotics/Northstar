import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import * as C from "./contract";
import * as NT from "./nt";
import { discoverInstances, Instance } from "./discovery";
import { ROBOT_LOOP_HZ, STARTUP_GRACE_SECONDS, resolveRepoPath } from "./settings";
import { readLogTail } from "./logs";

export type SignalState = "ok" | "warn" | "fail" | "starting" | "unknown" | "n/a";

export type Signal = {
  label: string;
  state: SignalState;
  detail?: string;
};

export type InstanceStatus = {
  key: string;
  deviceId: string | null;
  cameraLocation: string | null;
  /** power/metrics instances are not cameras and get no camera card. */
  isCamera: boolean;
  sources: string[];
  signals: Signal[];
  overall: SignalState;
  vitals: {
    fpsApriltag?: number;
    fpsObjdetect?: number;
    cameraId?: string;
    resolution?: string;
    exposure?: number;
    gain?: number;
    throttleFps?: number;
    recording?: boolean;
    thermal?: string;
    acceptedRate?: number | null;
    rejectedRate?: number | null;
    acceptPct?: number | null;
    staleCycles?: number;
    staleSeconds?: number;
    tagCount?: number | null;
  };
  streams: { apriltag?: number; objdetect?: number };
  logs: { out?: string; err?: string; available: boolean; newErrors: number };
  notes: string[];
};

// ---------------------------------------------------------------------------
// Counter rate tracking
//
// UpdatePoseCount / RejectedPoseCount are cumulative and monotonic, so we show a
// delta over a window rather than the raw value. A counter is immune to sampling
// loss, unlike the per-cycle pose arrays — which is why we asked for counters.
// ---------------------------------------------------------------------------

type CounterSample = { value: number; atMs: number };
const g = globalThis as unknown as { __ns_counters?: Map<string, CounterSample[]> };
const history = () => (g.__ns_counters ??= new Map());

const WINDOW_MS = 15_000;

/**
 * How far back a frame-rate boolean may have last been true and still count as
 * healthy. Comfortably longer than the ~200ms it oscillates on, short enough
 * that a genuinely stalled camera shows up quickly.
 */
const RECEIVING_WINDOW_MS = 3_000;

function rate(topic: string): number | null {
  const v = NT.getNumber(topic);
  if (v === undefined) return null;
  const h = history();
  const arr = h.get(topic) ?? [];
  const now = Date.now();
  arr.push({ value: v, atMs: now });
  while (arr.length > 2 && now - arr[0].atMs > WINDOW_MS) arr.shift();
  h.set(topic, arr);
  if (arr.length < 2) return null;
  const first = arr[0];
  const dt = (now - first.atMs) / 1000;
  if (dt < 1) return null;
  return Math.max(0, (v - first.value) / dt);
}

// ---------------------------------------------------------------------------

const bootedAtMs = Date.now() - os.uptime() * 1000;
const withinGrace = () => os.uptime() < STARTUP_GRACE_SECONDS;

/**
 * A signal that has EVER been established this boot and then dropped is a real
 * failure and shows as failed immediately, regardless of uptime. Only
 * never-established signals get the benefit of the grace window.
 */
const established = (() => {
  const g2 = globalThis as unknown as { __ns_established?: Set<string> };
  const set = (g2.__ns_established ??= new Set<string>());
  return {
    mark: (k: string) => set.add(k),
    has: (k: string) => set.has(k),
  };
})();

function gate(key: string, ok: boolean, okDetail?: string, failDetail?: string): Signal["state"] {
  if (ok) {
    established.mark(key);
    return "ok";
  }
  if (!established.has(key) && withinGrace()) return "starting";
  return "fail";
}

const WORST: SignalState[] = ["fail", "warn", "starting", "unknown", "ok", "n/a"];
function worstOf(signals: Signal[]): SignalState {
  for (const s of WORST) if (signals.some((x) => x.state === s)) return s;
  return "unknown";
}

async function fileExists(p: string) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function computeStatus(): Promise<{
  instances: InstanceStatus[];
  nt: ReturnType<typeof NT.ntStatus>;
  host: {
    uptimeSeconds: number;
    bootedAtMs: number;
    withinStartupGrace: boolean;
    graceSeconds: number;
    loadavg: number[];
    hostname: string;
  };
  vision: { enabled?: boolean; updating?: boolean; camerasToConsider?: string };
  generatedAtMs: number;
}> {
  const instances = await discoverInstances();
  NT.ensureDeviceSubscriptions(
    instances.map((i) => i.config?.device_id).filter((d): d is string => !!d),
  );

  // Per-instance work is independent and each reads two log tails, so fan out
  // rather than serializing across six instances.
  const statuses = await Promise.all(instances.map(statusFor));

  return {
    instances: statuses,
    nt: NT.ntStatus(),
    host: {
      uptimeSeconds: Math.round(os.uptime()),
      bootedAtMs,
      withinStartupGrace: withinGrace(),
      graceSeconds: STARTUP_GRACE_SECONDS,
      loadavg: os.loadavg(),
      hostname: os.hostname(),
    },
    vision: {
      enabled: NT.getBool(C.VISION_IS_ENABLED),
      updating: NT.getBool(C.VISION_IS_UPDATING),
      camerasToConsider: NT.getValue<string>(C.VISION_CAMERAS_TO_CONSIDER),
    },
    generatedAtMs: Date.now(),
  };
}

async function statusFor(inst: Instance): Promise<InstanceStatus> {
  const cfg = inst.config;
  const deviceId = cfg?.device_id ?? null;
  const loc = deviceId ? C.cameraLocationFor(deviceId) : null;
  const notes: string[] = [];

  // powermetrics-only instances are not cameras: no streams, no status chain.
  const isCamera = !!cfg && (cfg.apriltags_enable || cfg.objdetect_enable);

  const signals: Signal[] = [];
  const vitals: InstanceStatus["vitals"] = {};

  // --- log tail, used by several signals -----------------------------------
  const tail = inst.outLog && (await fileExists(inst.outLog))
    ? await readLogTail(inst.outLog, 120).catch(() => null)
    : null;
  const recent = tail?.lines.join("\n") ?? "";

  // --- 4. NT connected (computed first: signal 1 depends on it) ------------
  //
  // Northstar EXITS when it loses an established NT connection, so "process
  // dead while NT is down" is expected, not a failure. The chain is not a
  // sequence of independent stages.
  const ntUp = NT.ntStatus().connected;
  let ntConnected: boolean | null = null;
  if (loc) {
    const v = NT.getBool(C.visionInput(loc, C.VISION_CONNECTED));
    if (v !== undefined) ntConnected = v;
  }
  if (ntConnected === null && deviceId) ntConnected = NT.ntClientConnected(deviceId);

  // --- 1. Process ----------------------------------------------------------
  const running = inst.pythonPid !== undefined;
  let processState: SignalState;
  let processDetail: string | undefined;
  if (running) {
    established.mark(`${inst.key}:process`);
    processState = "ok";
    const ageS = inst.pythonStartedMs ? Math.round((Date.now() - inst.pythonStartedMs) / 1000) : undefined;
    processDetail = `pid ${inst.pythonPid}${ageS !== undefined ? `, up ${fmtDuration(ageS)}` : ""}`;
  } else if (!ntUp) {
    // Expected: Northstar exits when the NT server goes away, and the shell
    // wrapper restarts it once the robot code is back.
    processState = withinGrace() || !established.has(`${inst.key}:process`) ? "starting" : "warn";
    processDetail = "not running — NT server is down, which is expected";
    notes.push("Northstar exits when NT goes away; the launchd wrapper restarts it.");
  } else if (inst.sources.includes("expected") && !inst.sources.includes("launchd")) {
    processState = "n/a";
    processDetail = "configured but not deployed";
  } else {
    processState = withinGrace() ? "starting" : "fail";
    processDetail = "not running";
  }
  signals.push({ label: "Process", state: processState, detail: processDetail });

  // --- 2. Camera delivering frames ----------------------------------------
  let cameraState: SignalState = "unknown";
  let cameraDetail: string | undefined;
  if (!running) {
    cameraState = processState === "ok" ? "unknown" : processState === "fail" ? "fail" : "starting";
  } else if (recent.includes(C.LOG_NO_FRAME)) {
    cameraState = "fail";
    cameraDetail = "no frames from camera";
  } else if (recent.includes(C.LOG_WAITING_CAMERA_ID)) {
    cameraState = "starting";
    cameraDetail = "waiting for camera id from robot code";
  } else if (
    loc &&
    NT.trueWithin(C.visionInput(loc, C.VISION_RECEIVING_FRAMES), RECEIVING_WINDOW_MS) === true
  ) {
    cameraState = "ok";
    cameraDetail = "robot receiving frames";
    established.mark(`${inst.key}:camera`);
  } else if (deviceId && NT.getNumber(C.nsOutput(deviceId, "fps_apriltags")) !== undefined) {
    cameraState = "ok";
    cameraDetail = "publishing fps";
    established.mark(`${inst.key}:camera`);
  } else {
    cameraState = established.has(`${inst.key}:camera`) ? "fail" : withinGrace() ? "starting" : "unknown";
  }
  signals.push({ label: "Camera", state: cameraState, detail: cameraDetail });

  // --- 3. Calibration ------------------------------------------------------
  const cameraId = deviceId ? NT.getValue<string>(C.nsConfig(deviceId, "camera_id")) : undefined;
  vitals.cameraId = cameraId;
  let calState: SignalState = "unknown";
  let calDetail: string | undefined;
  if (!isCamera) {
    calState = "n/a";
  } else if (!cameraId) {
    calState = withinGrace() ? "starting" : "unknown";
    calDetail = "no camera id yet";
  } else {
    const folder = resolveRepoPath(cfg?.calibration_folder ?? "cameras/calibrations/");
    const file = path.join(folder, C.calibrationFilename(cameraId));
    if (await fileExists(file)) {
      calState = "ok";
      calDetail = path.basename(file);
      established.mark(`${inst.key}:cal`);
    } else {
      calState = "fail";
      calDetail = `missing ${path.basename(file)}`;
    }
  }
  signals.push({ label: "Calibration", state: calState, detail: calDetail });

  // --- 4. NT connected (push the signal now) -------------------------------
  signals.push({
    label: "NT",
    state: !ntUp
      ? withinGrace()
        ? "starting"
        : "warn"
      : ntConnected === true
        ? (established.mark(`${inst.key}:nt`), "ok")
        : ntConnected === false
          ? established.has(`${inst.key}:nt`)
            ? "fail"
            : withinGrace()
              ? "starting"
              : "fail"
          : "unknown",
    detail: !ntUp ? "app not connected to roboRIO" : ntConnected === null ? "no client entry" : undefined,
  });

  // --- 5. Sending frames to the robot --------------------------------------
  if (loc) {
    // ReceivingFrames toggles at roughly frame rate — measured changing ~5×/s —
    // so reading the instantaneous value lands on `false` routinely while the
    // camera is perfectly healthy. Ask whether it has been true recently.
    const rf = NT.trueWithin(C.visionInput(loc, C.VISION_RECEIVING_FRAMES), RECEIVING_WINDOW_MS);
    let state: SignalState;
    let detail: string | undefined;
    if (rf === true) {
      established.mark(`${inst.key}:send`);
      state = "ok";
    } else if (rf === false) {
      state = established.has(`${inst.key}:send`) || !withinGrace() ? "fail" : "starting";
      detail = "no frames reaching the robot";
    } else if (!ntUp) {
      state = "starting";
      detail = "NT unavailable";
    } else {
      state = "unknown";
      detail = "not tracked by robot code";
    }
    signals.push({ label: "Sending", state, detail });
  } else {
    signals.push({ label: "Sending", state: "n/a", detail: "not tracked by robot code" });
  }

  // --- 6/7. Accepted & rejected pose rates ---------------------------------
  //
  // These counters are ABSENT, not zero, until a camera's first acceptance or
  // rejection. A camera that never came up has neither — which is exactly the
  // failure that matters most — so absence is never an error here, and
  // CyclesWithNoResults is what covers the gap.
  if (loc) {
    const accTopic = C.visionOutput(loc, C.VISION_UPDATE_POSE_COUNT);
    const rejTopic = C.visionOutput(loc, C.VISION_REJECTED_POSE_COUNT);
    const acc = rate(accTopic);
    const rej = rate(rejTopic);
    vitals.acceptedRate = acc;
    vitals.rejectedRate = rej;

    const total = (acc ?? 0) + (rej ?? 0);
    vitals.acceptPct = total > 0 ? ((acc ?? 0) / total) * 100 : null;

    const cycles = NT.getNumber(C.visionOutput(loc, C.VISION_CYCLES_NO_RESULTS));
    vitals.staleCycles = cycles;
    vitals.staleSeconds = cycles !== undefined ? cycles / ROBOT_LOOP_HZ : undefined;

    const hasCounters = NT.getNumber(accTopic) !== undefined || NT.getNumber(rejTopic) !== undefined;
    let poseState: SignalState;
    let poseDetail: string;
    if (!hasCounters) {
      // Not an error: nothing has been accepted or rejected yet.
      poseState = cycles !== undefined && cycles > ROBOT_LOOP_HZ * 5 ? "warn" : "starting";
      poseDetail =
        cycles !== undefined
          ? `no results for ${fmtDuration(Math.round(cycles / ROBOT_LOOP_HZ))}`
          : "none yet";
    } else if (vitals.acceptPct === null) {
      poseState = "unknown";
      poseDetail = "measuring…";
    } else {
      poseState = vitals.acceptPct >= 50 ? "ok" : vitals.acceptPct > 0 ? "warn" : "fail";
      poseDetail = `${vitals.acceptPct.toFixed(0)}% accepted`;
    }
    signals.push({ label: "Poses", state: poseState, detail: poseDetail });
  } else {
    signals.push({ label: "Poses", state: "n/a", detail: "not tracked by robot code" });
  }

  // --- vitals --------------------------------------------------------------
  if (deviceId) {
    vitals.fpsApriltag =
      NT.getNumber(C.nsOutput(deviceId, "fps_apriltags")) ??
      (loc ? NT.getNumber(C.visionInput(loc, C.VISION_APRILTAG_FPS)) : undefined);
    vitals.fpsObjdetect =
      NT.getNumber(C.nsOutput(deviceId, "fps_objdetect")) ??
      (loc ? NT.getNumber(C.visionInput(loc, C.VISION_OBJDETECT_FPS)) : undefined);
    const w = NT.getNumber(C.nsConfig(deviceId, "camera_resolution_width"));
    const h = NT.getNumber(C.nsConfig(deviceId, "camera_resolution_height"));
    if (w && h) vitals.resolution = `${w}×${h}`;
    vitals.exposure = NT.getNumber(C.nsConfig(deviceId, "camera_exposure"));
    vitals.gain = NT.getNumber(C.nsConfig(deviceId, "camera_gain"));
    vitals.throttleFps = NT.getNumber(C.nsConfig(deviceId, "throttle_fps"));
    vitals.recording = NT.getBool(C.nsConfig(deviceId, "is_recording"));

    const obs = NT.getValue<number[]>(C.nsOutput(deviceId, "observations"));
    if (obs === undefined) {
      vitals.tagCount = undefined; // no data yet
    } else {
      const decoded = C.decodeObservations(obs);
      // null means "unrecognized format" — show that rather than a confident
      // wrong number, since a layout change here fails silently.
      vitals.tagCount = decoded ? decoded.tagCount : null;
    }
  }
  if (loc) vitals.thermal = NT.getValue<string>(C.visionInput(loc, C.VISION_THERMAL)) || undefined;

  // --- logs ----------------------------------------------------------------
  const errTail =
    inst.errLog && (await fileExists(inst.errLog))
      ? await readLogTail(inst.errLog, 40).catch(() => null)
      : null;
  const newErrors = errTail?.lines.filter((l) => l.trim().length > 0).length ?? 0;

  if (!inst.logsAvailable) {
    notes.push("No log file — instance is running from a terminal rather than launchd.");
  }
  if (recent.includes(C.LOG_STARTING)) {
    const restarts = (recent.match(new RegExp(C.LOG_STARTING.replace(/\./g, "\\."), "g")) ?? []).length;
    // One restart per NT outage is expected; only flag repeated churn, and only
    // while NT is actually up.
    if (restarts > 2 && ntUp) notes.push(`Restarted ${restarts}× in the recent log — possible crash loop.`);
  }

  const visible = signals.filter((s) => s.state !== "n/a");
  return {
    key: inst.key,
    deviceId,
    cameraLocation: loc,
    isCamera,
    sources: inst.sources,
    signals,
    overall: worstOf(visible),
    vitals,
    streams: {
      apriltag: cfg?.apriltags_enable ? cfg.apriltags_stream_port : undefined,
      objdetect: cfg?.objdetect_enable ? cfg.objdetect_stream_port : undefined,
    },
    logs: {
      out: inst.outLog,
      err: inst.errLog,
      available: inst.logsAvailable,
      newErrors,
    },
    notes,
  };
}

export function fmtDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const s = Math.floor(seconds % 60);
  const m = Math.floor((seconds / 60) % 60);
  const h = Math.floor(seconds / 3600);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}
