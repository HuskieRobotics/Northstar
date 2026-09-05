import { exec } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import * as C from "./contract";
import { DISCOVERY_MODE, EXPECTED_SCAN_PROFILE, REPO_ROOT, resolveRepoPath } from "./settings";

const sh = promisify(exec);
const run = async (cmd: string): Promise<string> => {
  try {
    const { stdout } = await sh(cmd, { timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
    return stdout;
  } catch {
    return "";
  }
};

export type NorthstarConfig = {
  device_id: string;
  server_ip: string;
  apriltags_stream_port: number;
  objdetect_stream_port: number;
  capture_impl: string;
  apriltags_enable: boolean;
  objdetect_enable: boolean;
  powermetrics_enable?: boolean;
  video_folder: string;
  calibration_folder?: string;
};

export type Instance = {
  /** Config file basename — `configBL`. Identical whether launched by launchd or
   *  by hand, which is why it is the key rather than the launchd label. */
  key: string;
  configPath: string;
  config: NorthstarConfig | null;
  configError?: string;
  /** Where we learned about it. */
  sources: ("launchd" | "process" | "expected")[];
  launchdLabel?: string;
  launchdPid?: number;
  lastExitStatus?: number;
  /** The Python process itself, not the shell wrapper. */
  pythonPid?: number;
  pythonStartedMs?: number;
  outLog?: string;
  errLog?: string;
  logsAvailable: boolean;
};

// ---------------------------------------------------------------------------
// launchd
// ---------------------------------------------------------------------------

async function launchdLabels(): Promise<string[]> {
  const out = await run("launchctl list");
  return out
    .split("\n")
    .map((l) => l.trim().split(/\s+/).pop() ?? "")
    .filter((l) => l.startsWith(C.LAUNCHD_LABEL_PREFIX));
}

async function launchdDetail(label: string) {
  // `launchctl print` carries the real StandardOutPath/StandardErrorPath, which
  // are absolute paths under the deployment account and differ from a developer
  // checkout — so never assume a repo-relative logs/ directory.
  const uid = process.getuid?.() ?? 501;
  const out = await run(`launchctl print gui/${uid}/${label} 2>/dev/null`);
  const pick = (re: RegExp) => out.match(re)?.[1]?.trim();

  const detail: {
    pid?: number;
    lastExitStatus?: number;
    program?: string;
    outLog?: string;
    errLog?: string;
  } = {
    pid: Number(pick(/^\s*pid = (\d+)/m)) || undefined,
    lastExitStatus: Number(pick(/last exit code = (\d+)/m)) || undefined,
    outLog: pick(/stdout path = (.+)$/m),
    errLog: pick(/stderr path = (.+)$/m),
  };

  const argv = out.match(/arguments = \{([^}]*)\}/s)?.[1];
  detail.program = argv?.split("\n").map((s) => s.trim()).filter(Boolean)[0];

  if (!detail.pid && !detail.program) {
    // Fall back to the older, terser output.
    const list = await run(`launchctl list ${label}`);
    detail.pid = Number(list.match(/"PID"\s*=\s*(\d+)/)?.[1]) || undefined;
    detail.lastExitStatus = Number(list.match(/"LastExitStatus"\s*=\s*(\d+)/)?.[1]) ?? undefined;
    detail.program = list.match(/"Program"\s*=\s*"([^"]+)"/)?.[1];
    detail.outLog = list.match(/"StandardOutPath"\s*=\s*"([^"]+)"/)?.[1];
    detail.errLog = list.match(/"StandardErrorPath"\s*=\s*"([^"]+)"/)?.[1];
  }
  return detail;
}

/**
 * Strip shell punctuation from a captured argument.
 *
 * The launcher scripts terminate statements with a semicolon:
 *
 *     python3 __init__.py --config cameras/robots/competition/configBCH.json;
 *
 * so a naive \S+ capture keeps the `;`. That yields a path that cannot be read
 * and a phantom instance keyed "configBCH.json;" alongside the real one.
 */
const cleanArg = (p: string) => p.replace(/^['"`]+/, "").replace(/['"`;,)&|]+$/, "");

/** Extract `--config <path>` from a shell wrapper script. */
async function configFromScript(scriptPath: string): Promise<string | undefined> {
  try {
    const body = await fs.readFile(scriptPath, "utf8");
    const raw = body.match(/--config\s+(\S+)/)?.[1];
    return raw ? cleanArg(raw) : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Process scan
//
// This is the same scan FR-3 needs anyway: the shell wrapper restarts Python in
// a `while true` loop, so the launchd PID is the shell, not Python. Reusing it
// for discovery is what makes hand-run instances work with no extra machinery.
// ---------------------------------------------------------------------------

export type PyProc = {
  pid: number;
  ppid: number;
  configPath: string;
  startedMs?: number;
  elapsedSec?: number;
};

/**
 * macOS `ps` has NO `etimes` keyword — that is Linux only. Passing it makes ps
 * drop the column and print an error, so the whole parse silently returns
 * nothing. Use `etime`, formatted [[dd-]hh:]mm:ss.
 */
export function parseEtime(s: string): number | undefined {
  const m = s.match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return undefined;
  const [, d, h, mi, sec] = m;
  return Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(mi) * 60 + Number(sec);
}

async function pythonProcesses(): Promise<PyProc[]> {
  const out = await run("ps -Ao pid=,ppid=,etime=,command=");
  const procs: PyProc[] = [];
  for (const line of out.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+([\d:-]+)\s+(.*)$/);
    if (!m) continue;
    const [, pid, ppid, etime, cmd] = m;
    if (!/__init__\.py/.test(cmd)) continue;
    const rawCfg = cmd.match(/--config\s+(\S+)/)?.[1];
    const cfg = rawCfg ? cleanArg(rawCfg) : undefined;
    if (!cfg) continue;
    const elapsedSec = parseEtime(etime);
    procs.push({
      pid: Number(pid),
      ppid: Number(ppid),
      configPath: cfg,
      elapsedSec,
      startedMs: elapsedSec === undefined ? undefined : Date.now() - elapsedSec * 1000,
    });
  }
  return procs;
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

const keyOf = (configPath: string) => path.basename(configPath, ".json");

async function readConfig(p: string): Promise<{ config: NorthstarConfig | null; error?: string }> {
  try {
    const abs = resolveRepoPath(p);
    return { config: JSON.parse(await fs.readFile(abs, "utf8")) as NorthstarConfig };
  } catch (e) {
    return { config: null, error: (e as Error).message };
  }
}

async function guessLog(key: string, suffix: "Out" | "Error"): Promise<string | null> {
  const guess = path.join(REPO_ROOT, "logs", `${key}${suffix}.log`);
  return (await exists(guess)) ? guess : null;
}

async function exists(p?: string): Promise<boolean> {
  if (!p) return false;
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function discoverInstances(): Promise<Instance[]> {
  const byConfig = new Map<string, Instance>();

  const upsert = (configPath: string, source: Instance["sources"][number]) => {
    const norm = resolveRepoPath(configPath);
    let inst = byConfig.get(norm);
    if (!inst) {
      inst = {
        key: keyOf(norm),
        configPath: norm,
        config: null,
        sources: [],
        logsAvailable: false,
      };
      byConfig.set(norm, inst);
    }
    if (!inst.sources.includes(source)) inst.sources.push(source);
    return inst;
  };

  // One `ps` sweep for the whole discovery pass — it costs ~40ms, which is the
  // single largest component of this function, so never call it twice.
  const wantProcs = DISCOVERY_MODE === "process" || DISCOVERY_MODE === "auto";
  const wantLaunchd = DISCOVERY_MODE === "launchd" || DISCOVERY_MODE === "auto";

  const [procs, labels] = await Promise.all([
    wantProcs || wantLaunchd ? pythonProcesses() : Promise.resolve([]),
    wantLaunchd ? launchdLabels() : Promise.resolve([]),
  ]);

  // --- launchd ---
  // Fan out: with six instances these would otherwise serialize, and each call
  // carries a 5s timeout, so a wedged launchd would stall the whole dashboard.
  const details = await Promise.all(
    labels.map(async (label) => {
      const d = await launchdDetail(label);
      const cfg = d.program ? await configFromScript(d.program) : undefined;
      return { label, d, cfg };
    }),
  );
  for (const { label, d, cfg } of details) {
    if (!cfg) continue;
    const inst = upsert(cfg, "launchd");
    inst.launchdLabel = label;
    inst.launchdPid = d.pid;
    inst.lastExitStatus = d.lastExitStatus;
    inst.outLog = d.outLog;
    inst.errLog = d.errLog;
  }

  // --- process scan ---
  if (wantProcs) {
    for (const p of procs) {
      const inst = upsert(p.configPath, "process");
      inst.pythonPid = p.pid;
      inst.pythonStartedMs = p.startedMs;
    }
  }

  // --- optional expected-instance scan (development aid only) ---
  // NEVER on a robot: cameras/robots/<profile>/ is a superset holding configs
  // for cameras that do not exist on every robot, and deployment copies only the
  // plists actually needed. Treating it as the expected set would report
  // permanently-missing instances that were never supposed to run.
  if (EXPECTED_SCAN_PROFILE) {
    const dir = path.join(REPO_ROOT, "cameras", "robots", EXPECTED_SCAN_PROFILE);
    try {
      for (const f of await fs.readdir(dir)) {
        if (f.startsWith("config") && f.endsWith(".json")) upsert(path.join(dir, f), "expected");
      }
    } catch {
      /* profile folder missing — ignore */
    }
  }

  // --- resolve configs, correlate the Python child, locate logs ---
  // Per-instance work is independent, so fan out rather than serializing across
  // six instances.
  const out = await Promise.all(
    [...byConfig.values()].map(async (inst) => {
      const { config, error } = await readConfig(inst.configPath);
      inst.config = config;
      inst.configError = error;

      if (inst.pythonPid === undefined) {
        const match = procs.find((p) => resolveRepoPath(p.configPath) === inst.configPath);
        if (match) {
          inst.pythonPid = match.pid;
          inst.pythonStartedMs = match.startedMs;
        }
      }

      // A hand-run instance writes to the terminal, not to logs/. Fall back to
      // the conventional path so `tee` setups work, but never require it.
      const [outGuess, errGuess] = await Promise.all([
        inst.outLog ? null : guessLog(inst.key, "Out"),
        inst.errLog ? null : guessLog(inst.key, "Error"),
      ]);
      inst.outLog ??= outGuess ?? undefined;
      inst.errLog ??= errGuess ?? undefined;

      const [hasOut, hasErr] = await Promise.all([exists(inst.outLog), exists(inst.errLog)]);
      inst.logsAvailable = hasOut || hasErr;

      return inst;
    }),
  );

  return out.sort((a, b) => a.key.localeCompare(b.key));
}

export async function findInstance(key: string): Promise<Instance | undefined> {
  return (await discoverInstances()).find((i) => i.key === key);
}
