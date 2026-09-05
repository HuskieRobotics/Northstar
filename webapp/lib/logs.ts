import fs from "node:fs/promises";
import * as C from "./contract";
import os from "node:os";

/**
 * Log files are appended to indefinitely — launchd does not rotate them and the
 * shell restart loop does not truncate them, so they grow across a whole event.
 * ALWAYS seek from the end; never read a whole file.
 *
 * A hard power cut can also leave the final line truncated mid-write, which must
 * not throw.
 */

const CHUNK = 64 * 1024;

export type LogTail = {
  lines: string[];
  size: number;
  /** Byte offset the returned text starts at, for incremental follow. */
  offset: number;
  truncatedFirstLine: boolean;
};

export async function readLogTail(file: string, maxLines: number): Promise<LogTail> {
  const handle = await fs.open(file, "r");
  try {
    const { size } = await handle.stat();
    let start = Math.max(0, size - CHUNK);
    let text = "";
    let lines: string[] = [];

    // Grow the window backwards until we have enough lines or hit the start.
    for (;;) {
      const len = size - start;
      const buf = Buffer.alloc(len);
      await handle.read(buf, 0, len, start);
      text = buf.toString("utf8");
      lines = text.split("\n");
      if (lines.length > maxLines + 1 || start === 0) break;
      start = Math.max(0, start - CHUNK);
      if (size - start > 4 * 1024 * 1024) break; // hard ceiling
    }

    // The first line is probably a fragment unless we read from byte 0.
    const truncatedFirstLine = start > 0;
    if (truncatedFirstLine && lines.length > 1) lines = lines.slice(1);

    // A power cut can leave a partial final line; drop a trailing empty entry.
    if (lines.length && lines[lines.length - 1] === "") lines.pop();

    return {
      lines: lines.slice(-maxLines),
      size,
      offset: start,
      truncatedFirstLine,
    };
  } finally {
    await handle.close();
  }
}

/** Read bytes appended since `from`. Handles the file shrinking (rotation). */
export async function readSince(file: string, from: number): Promise<{ lines: string[]; next: number }> {
  const handle = await fs.open(file, "r");
  try {
    const { size } = await handle.stat();
    if (size < from) return { lines: [], next: size }; // truncated or replaced
    if (size === from) return { lines: [], next: from };
    const len = Math.min(size - from, 512 * 1024);
    const buf = Buffer.alloc(len);
    await handle.read(buf, 0, len, from);
    const text = buf.toString("utf8");
    const lines = text.split("\n");
    // Keep the last partial line for next time by rewinding to the last newline.
    const lastNl = text.lastIndexOf("\n");
    if (lastNl === -1) return { lines: [], next: from };
    lines.pop();
    return { lines, next: from + Buffer.byteLength(text.slice(0, lastNl + 1)) };
  } finally {
    await handle.close();
  }
}

export type LineKind = "fps" | "no-frame" | "no-calibration" | "calibration" | "start" | "recording" | "error" | "plain";

/** Classify a line for highlighting. All patterns live in contract.ts. */
export function classify(line: string): LineKind {
  if (C.LOG_FPS_APRILTAG.test(line) || C.LOG_FPS_OBJDETECT.test(line)) return "fps";
  if (line.includes(C.LOG_NO_FRAME)) return "no-frame";
  if (C.LOG_NO_CALIBRATION.test(line)) return "no-calibration";
  if (C.LOG_CALIBRATION_LOADED.test(line)) return "calibration";
  if (line.includes(C.LOG_STARTING)) return "start";
  if (line.includes(C.LOG_RECORDING_START) || line.includes(C.LOG_RECORDING_STOP)) return "recording";
  if (/^\s*(Traceback|\s+File ")|Error|Exception/.test(line)) return "error";
  return "plain";
}

/**
 * Index of the first line belonging to the current boot.
 *
 * Log files persist across power cycles with no boot marker, so a student
 * tailing a log cannot otherwise tell this power-on's errors from last week's.
 * Line timestamps come from the same clock we run on, so comparing them to our
 * boot time is safe — unlike comparing them to roboRIO timestamps.
 */
export function currentBootIndex(lines: string[]): number | null {
  const bootMs = Date.now() - os.uptime() * 1000;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(C.LOG_TIMESTAMP);
    if (!m) continue;
    const t = Date.parse(m[1].replace(" ", "T"));
    if (!Number.isNaN(t) && t >= bootMs) return i;
  }
  return null;
}

/**
 * Lines newer than `seconds` ago, by their printed timestamp.
 *
 * Log tails hold minutes of history, so asking "does the tail contain
 * 'No frame received'" keeps reporting a fault long after the camera recovered.
 * Bound the question in time instead. Both clocks are this machine's, so the
 * comparison is safe — unlike comparing against roboRIO timestamps.
 */
export function linesWithin(lines: string[], seconds: number): string[] {
  const cutoff = Date.now() - seconds * 1000;
  const out: string[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(C.LOG_TIMESTAMP);
    if (m) {
      const t = Date.parse(m[1].replace(" ", "T"));
      if (!Number.isNaN(t) && t < cutoff) break;
    }
    out.unshift(lines[i]);
  }
  return out;
}
