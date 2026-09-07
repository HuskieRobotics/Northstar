import fs from "node:fs/promises";
import path from "node:path";
import * as C from "./contract";
import * as NT from "./nt";
import { discoverInstances } from "./discovery";
import { REPO_ROOT, WHATCABLE_CACHE_MS, WHATCABLE_HISTORY_MS } from "./settings";
import { getReport, linkDegraded } from "./whatcable";

/**
 * Link-state history, so degradation can be correlated against frame loss.
 *
 * A live reading says the link is degraded *now*. It cannot say whether
 * degradation *preceded* Northstar losing frames — which is the question that
 * would confirm or kill the USB-2-fallback theory. That needs the state sampled
 * over time and retained.
 *
 * Records are written only when a camera's link state CHANGES, plus a periodic
 * heartbeat, so the file stays small and every line is meaningful.
 */

export type LinkSample = {
  atMs: number;
  cameraId: string;
  instanceKey?: string;
  speed?: string;
  usbVersion?: string;
  active: string[];
  degraded: boolean;
  /** "change" when the state differed from the previous sample. */
  kind: "change" | "heartbeat" | "appeared" | "disappeared" | "triggered";
  /** Why an event-triggered sample was taken, e.g. "frame loss started". */
  trigger?: string;
};

const HISTORY_FILE = () => path.join(REPO_ROOT, "logs", "cabling-history.jsonl");
const HEARTBEAT_MS = 10 * 60 * 1000;
const MAX_BYTES = 2 * 1024 * 1024;

type Mem = {
  timer?: ReturnType<typeof setInterval>;
  last: Map<string, LinkSample>;
  recent: LinkSample[];
  started: boolean;
  lastError?: string;
  /**
   * cameraId -> instanceKey, remembered once NT has told us.
   *
   * The mapping only exists because the robot publishes `camera_id` over NT, and
   * NT goes away routinely — the robot power-cycles, and Northstar itself exits
   * when it loses the connection. Without a remembered mapping, samples taken
   * during exactly those outages would be unattributable, which is when they
   * matter most.
   */
  knownKeys: Map<string, string>;
};
const g = globalThis as unknown as { __ns_cabhist?: Mem };
const mem = (): Mem =>
  (g.__ns_cabhist ??= { last: new Map(), recent: [], started: false, knownKeys: new Map() });

const signature = (s: Pick<LinkSample, "speed" | "degraded" | "active">) =>
  `${s.speed ?? ""}|${s.degraded}|${s.active.join(",")}`;

/**
 * Append one line. Crash tolerance rather than durability: the Mac mini loses
 * power without warning, so a truncated final line is expected and the reader
 * simply skips it. Nothing here has to be valid at next boot.
 */
async function append(rec: LinkSample) {
  try {
    const file = HISTORY_FILE();
    await fs.mkdir(path.dirname(file), { recursive: true });
    // Bound growth. Truncating loses old history, which is acceptable — this is
    // a diagnostic aid, not a record of account.
    try {
      const st = await fs.stat(file);
      if (st.size > MAX_BYTES) {
        const text = await fs.readFile(file, "utf8");
        await fs.writeFile(file, text.slice(Math.floor(text.length / 2)).replace(/^[^\n]*\n/, ""));
      }
    } catch {
      /* no file yet */
    }
    await fs.appendFile(file, JSON.stringify(rec) + "\n");
  } catch (e) {
    mem().lastError = (e as Error).message;
  }
}

/**
 * One sampling pass.
 *
 * Normally records only what changed. An event-triggered pass forces a fresh
 * read (the cache would return a reading from before the event) and records the
 * result unconditionally — "we looked during the episode and the link was fine"
 * is just as much evidence as finding it degraded.
 */
export async function sampleOnce(opts: { force?: boolean; trigger?: string } = {}): Promise<void> {
  const m = mem();
  const { report } = await getReport(opts.force ?? false);
  if (!report) return;

  const instances = await discoverInstances();
  for (const i of instances) {
    const deviceId = i.config?.device_id;
    if (!deviceId) continue;
    const cameraId = NT.getValue<string>(C.nsConfig(deviceId, "camera_id"));
    if (cameraId) m.knownKeys.set(cameraId, i.key);
  }

  const now = Date.now();
  const seen = new Set<string>();

  for (const port of report.ports ?? []) {
    for (const dev of port.devices ?? []) {
      const cameraId = dev.serialNumber;
      if (!cameraId) continue;
      // Fall back to the remembered mapping when NT cannot tell us right now.
      const instanceKey = m.knownKeys.get(cameraId);
      const looksLikeCamera =
        !!instanceKey || /basler|arducam|camera|daA\d|ov\d{4}/i.test(`${dev.vendorName} ${dev.name}`);
      if (!looksLikeCamera) continue;
      seen.add(cameraId);

      const sample: LinkSample = {
        atMs: now,
        cameraId,
        instanceKey,
        speed: dev.speed,
        usbVersion: dev.usbVersion,
        active: port.transports?.active ?? [],
        degraded: linkDegraded(dev, port),
        kind: "change",
      };

      const prev = m.last.get(cameraId);
      if (opts.trigger) {
        sample.kind = "triggered";
        sample.trigger = opts.trigger;
      } else if (!prev) {
        sample.kind = "appeared";
      } else if (signature(prev) !== signature(sample)) {
        sample.kind = "change";
      } else if (now - prev.atMs > HEARTBEAT_MS) {
        sample.kind = "heartbeat";
      } else {
        continue; // unchanged and not due a heartbeat
      }

      m.last.set(cameraId, sample);
      m.recent.push(sample);
      if (m.recent.length > 500) m.recent.shift();
      await append(sample);
    }
  }

  // A camera that vanished from the bus entirely is the most interesting event
  // of all, so record it explicitly rather than inferring it from silence.
  for (const [cameraId, prev] of m.last) {
    if (seen.has(cameraId) || prev.kind === "disappeared") continue;
    const rec: LinkSample = { ...prev, atMs: now, kind: "disappeared" };
    m.last.set(cameraId, rec);
    m.recent.push(rec);
    await append(rec);
  }
}

/** Start the background sampler once. Disabled when the cache is set to 0. */
export function ensureSampler(): void {
  const m = mem();
  if (m.started || WHATCABLE_CACHE_MS <= 0 || WHATCABLE_HISTORY_MS <= 0) return;
  m.started = true;
  void sampleOnce();
  m.timer = setInterval(() => void sampleOnce(), WHATCABLE_HISTORY_MS);
  // The periodic tick cannot catch a fallback that recovers in a second, so a
  // log watcher triggers an immediate check the moment frames stop.
  void import("./frameLossWatcher").then((w) => w.ensureWatcher()).catch(() => {});
  // Never hold the process open for a diagnostic timer.
  (m.timer as unknown as { unref?: () => void }).unref?.();
}

/** Read history from disk, skipping any line a power cut left half-written. */
export async function readHistory(sinceMs: number): Promise<LinkSample[]> {
  ensureSampler();
  const m = mem();
  let out: LinkSample[] = [];
  let text = "";
  try {
    text = await fs.readFile(HISTORY_FILE(), "utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line) as LinkSample;
        // Every record that carries a mapping teaches us one, including records
        // written by an earlier run of this app.
        if (rec.instanceKey && rec.cameraId) m.knownKeys.set(rec.cameraId, rec.instanceKey);
        if (rec.atMs >= sinceMs) out.push(rec);
      } catch {
        // Truncated or corrupt line — expected after a hard power cut. Skip it.
      }
    }
  } catch {
    out = m.recent.filter((s) => s.atMs >= sinceMs);
  }

  // Backfill records written while NT was unavailable, so a sample taken during
  // an outage still attributes to the right camera.
  for (const rec of out) {
    if (!rec.instanceKey && rec.cameraId) {
      const key = m.knownKeys.get(rec.cameraId);
      if (key) rec.instanceKey = key;
    }
  }
  return out;
}

export const historyFilePath = () => HISTORY_FILE();
