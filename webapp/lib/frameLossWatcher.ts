import fs from "node:fs/promises";
import * as C from "./contract";
import { discoverInstances } from "./discovery";
import { readSince } from "./logs";
import { FRAMELOSS_TRIGGER_GAP_MS, FRAMELOSS_WATCH_MS, WHATCABLE_CACHE_MS } from "./settings";
import { sampleOnce } from "./cablingHistory";

/**
 * Watch instance logs for the *start* of a frame-loss episode and check the USB
 * bus immediately.
 *
 * The periodic sampler is useless for this. Frame loss can recover in just over
 * a second, so a 30-second tick will essentially never observe the degraded
 * state — by the time it runs, the link is back and the evidence is gone. The
 * only way to catch it is to look the moment Northstar says frames stopped.
 *
 * Two things make that possible:
 *   - the log is polled sub-second, so detection lands within ~400ms
 *   - the triggered check FORCES a fresh read, because the cached reading
 *     predates the event and would be exactly the wrong answer
 *
 * We also sample when frames resume, so a recovery is captured too. An episode
 * that never recovers is bounded by nothing, so the trigger gap stops a flapping
 * camera from causing a storm of USB reads.
 */

type Watched = {
  offset: number;
  inEpisode: boolean;
  lastTriggerMs: number;
};

type WState = {
  timer?: ReturnType<typeof setInterval>;
  started: boolean;
  files: Map<string, Watched>;
  triggers: number;
  lastTrigger?: { atMs: number; instanceKey: string; reason: string };
};

const g = globalThis as unknown as { __ns_flwatch?: WState };
const st = (): WState => (g.__ns_flwatch ??= { started: false, files: new Map(), triggers: 0 });

async function tick() {
  const s = st();
  let instances;
  try {
    instances = await discoverInstances();
  } catch {
    return;
  }

  for (const inst of instances) {
    const file = inst.outLog;
    if (!file) continue;

    let w = s.files.get(inst.key);
    if (!w) {
      // Start at the end of the file — we care about what happens from now on,
      // not about replaying history that the log scan already covers.
      let size = 0;
      try {
        size = (await fs.stat(file)).size;
      } catch {
        continue;
      }
      w = { offset: size, inEpisode: false, lastTriggerMs: 0 };
      s.files.set(inst.key, w);
      continue;
    }

    let lines: string[] = [];
    try {
      const res = await readSince(file, w.offset);
      w.offset = res.next;
      lines = res.lines;
    } catch {
      continue;
    }
    if (lines.length === 0) continue;

    const sawNoFrame = lines.some((l) => l.includes(C.LOG_NO_FRAME));
    const sawOther = lines.some((l) => l.trim() && !l.includes(C.LOG_NO_FRAME));

    const now = Date.now();
    const canTrigger = now - w.lastTriggerMs >= FRAMELOSS_TRIGGER_GAP_MS;

    if (sawNoFrame && !w.inEpisode) {
      w.inEpisode = true;
      if (canTrigger) {
        w.lastTriggerMs = now;
        s.triggers++;
        s.lastTrigger = { atMs: now, instanceKey: inst.key, reason: "frame loss started" };
        // force: the cached reading predates the event.
        void sampleOnce({ force: true, trigger: `frame loss started (${inst.key})` });
      }
    } else if (w.inEpisode && sawOther && !sawNoFrame) {
      w.inEpisode = false;
      if (canTrigger) {
        w.lastTriggerMs = now;
        s.triggers++;
        s.lastTrigger = { atMs: now, instanceKey: inst.key, reason: "frames resumed" };
        void sampleOnce({ force: true, trigger: `frames resumed (${inst.key})` });
      }
    }
  }
}

export function ensureWatcher(): void {
  const s = st();
  if (s.started || WHATCABLE_CACHE_MS <= 0 || FRAMELOSS_WATCH_MS <= 0) return;
  s.started = true;
  s.timer = setInterval(() => void tick(), FRAMELOSS_WATCH_MS);
  (s.timer as unknown as { unref?: () => void }).unref?.();
}

export function watcherStatus() {
  const s = st();
  return {
    running: s.started,
    pollMs: FRAMELOSS_WATCH_MS,
    triggerGapMs: FRAMELOSS_TRIGGER_GAP_MS,
    watching: [...s.files.keys()],
    triggers: s.triggers,
    lastTrigger: s.lastTrigger,
  };
}
