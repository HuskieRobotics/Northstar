import os from "node:os";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import * as C from "./contract";
import * as NT from "./nt";
import { DISK_WARN_GB, REPO_ROOT, resolveRepoPath } from "./settings";
import { discoverInstances } from "./discovery";

const sh = promisify(exec);
const run = async (cmd: string) => {
  try {
    return (await sh(cmd, { timeout: 6000, maxBuffer: 8 * 1024 * 1024 })).stdout;
  } catch {
    return "";
  }
};

export async function systemHealth() {
  const [diskOut, psOut] = await Promise.all([
    run(`df -k ${JSON.stringify(REPO_ROOT)}`),
    run("ps -Ao pid=,%cpu=,rss=,command="),
  ]);

  // Disk
  const dfLine = diskOut.split("\n")[1] ?? "";
  const dfCols = dfLine.trim().split(/\s+/);
  const availKb = Number(dfCols[3]);
  const totalKb = Number(dfCols[1]);
  const freeGb = Number.isFinite(availKb) ? availKb / 1024 / 1024 : null;

  // Per-instance process cost
  const procs: { pid: number; cpu: number; rssMb: number; key: string }[] = [];
  for (const line of psOut.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+([\d.]+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    if (!/__init__\.py/.test(m[4])) continue;
    const cfg = m[4].match(/--config\s+(\S+)/)?.[1];
    procs.push({
      pid: Number(m[1]),
      cpu: Number(m[2]),
      rssMb: Number(m[3]) / 1024,
      key: cfg ? path.basename(cfg, ".json") : "?",
    });
  }

  // Power/thermal. Do NOT run `powermetrics` ourselves — it needs sudo and the
  // configPower instance already collects it once per second.
  const instances = await discoverInstances();
  const powerDevice = instances.find((i) => i.config?.powermetrics_enable)?.config?.device_id;
  let power: { cpuMw?: number; gpuMw?: number; aneMw?: number; pressure?: string } | null = null;
  if (powerDevice) {
    const arr = NT.getValue<number[]>(C.nsOutput(powerDevice, "power_metrics"));
    if (Array.isArray(arr) && arr.length >= 4) {
      power = {
        cpuMw: arr[0],
        gpuMw: arr[1],
        aneMw: arr[2],
        pressure: C.decodePressureLevel(arr[3]),
      };
    }
  }
  return {
    hostname: os.hostname(),
    platform: `${os.type()} ${os.release()}`,
    uptimeSeconds: Math.round(os.uptime()),
    loadavg: os.loadavg(),
    cpus: os.cpus().length,
    memTotalGb: os.totalmem() / 1024 ** 3,
    memFreeGb: os.freemem() / 1024 ** 3,
    disk: {
      freeGb,
      totalGb: Number.isFinite(totalKb) ? totalKb / 1024 / 1024 : null,
      warn: freeGb !== null && freeGb < DISK_WARN_GB,
      warnThresholdGb: DISK_WARN_GB,
    },
    processes: procs,
    power,
  };
}

export async function listCalibrations() {
  const instances = await discoverInstances();
  const folders = new Set<string>();
  for (const i of instances) {
    folders.add(resolveRepoPath(i.config?.calibration_folder ?? "cameras/calibrations/"));
  }
  const files: { file: string; cameraId: string; mtimeMs: number; sizeBytes: number }[] = [];
  for (const folder of folders) {
    let entries: string[] = [];
    try {
      entries = await fs.readdir(folder);
    } catch {
      continue;
    }
    for (const f of entries) {
      const m = f.match(/^calibration(.+)\.yml$/);
      if (!m) continue;
      try {
        const st = await fs.stat(path.join(folder, f));
        files.push({ file: path.join(folder, f), cameraId: m[1], mtimeMs: st.mtimeMs, sizeBytes: st.size });
      } catch {
        /* ignore */
      }
    }
  }

  const perInstance = instances.map((i) => {
    const deviceId = i.config?.device_id;
    const cameraId = deviceId ? NT.getValue<string>(C.nsConfig(deviceId, "camera_id")) : undefined;
    const folder = resolveRepoPath(i.config?.calibration_folder ?? "cameras/calibrations/");
    const expectedFile = cameraId ? path.join(folder, C.calibrationFilename(cameraId)) : null;
    return {
      key: i.key,
      deviceId,
      cameraId,
      expectedFile,
      // The power-metrics instance runs no camera, so it has no calibration to
      // report and should not appear on the cameras page at all.
      isCamera: !!i.config && (i.config.apriltags_enable || i.config.objdetect_enable),
      present: expectedFile ? files.some((f) => f.file === expectedFile) : null,
    };
  });

  return { files: files.sort((a, b) => a.cameraId.localeCompare(b.cameraId)), perInstance };
}

export async function listVideos() {
  const instances = await discoverInstances();
  const folders = new Set<string>();
  for (const i of instances) if (i.config?.video_folder) folders.add(resolveRepoPath(i.config.video_folder));
  if (folders.size === 0) folders.add(resolveRepoPath("./videos/"));

  const out: {
    file: string;
    name: string;
    device: string;
    when: string;
    raw: boolean;
    rest?: string;
    sizeBytes: number;
    mtimeMs: number;
    suspect: boolean;
  }[] = [];

  for (const folder of folders) {
    let entries: string[] = [];
    try {
      entries = await fs.readdir(folder);
    } catch {
      continue;
    }
    for (const f of entries) {
      if (!f.endsWith(".mkv")) continue;
      const m = f.match(C.VIDEO_FILENAME);
      let st;
      try {
        st = await fs.stat(path.join(folder, f));
      } catch {
        continue;
      }
      const g = m?.groups;
      out.push({
        file: path.join(folder, f),
        name: f,
        device: g?.device ?? "?",
        when: g ? `${g.date} ${g.time}` : "",
        raw: !!g?.raw,
        rest: g?.rest,
        sizeBytes: st.size,
        mtimeMs: st.mtimeMs,
        // A hard power cut kills ffmpeg mid-write, so the container is never
        // finalized. Zero-byte files are certainly bad; flag them explicitly so
        // nobody wonders why the file will not open.
        suspect: st.size === 0,
      });
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}
