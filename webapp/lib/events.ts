import * as C from "./contract";
import { discoverInstances } from "./discovery";
import { readLogTail } from "./logs";
import { CORRELATION_WINDOW_MS } from "./settings";
import { readHistory, LinkSample } from "./cablingHistory";

/**
 * Frame-loss episodes, extracted from Northstar's own logs, so link-state
 * changes can be lined up against them.
 *
 * The question this exists to answer: does a USB 2 fallback *precede* a
 * frame-loss episode, or merely coincide with one? A live link reading cannot
 * tell you; a timeline can.
 */

export type LogEvent = {
  atMs: number;
  instanceKey: string;
  kind: "frame-loss" | "restart" | "no-calibration";
  /** For an episode, when the last matching line was seen. */
  untilMs?: number;
  count?: number;
  text: string;
};

const parseTs = (line: string): number | null => {
  const m = line.match(C.LOG_TIMESTAMP);
  if (!m) return null;
  const t = Date.parse(m[1].replace(" ", "T"));
  return Number.isNaN(t) ? null : t;
};

/**
 * Consecutive `No frame received` lines are one episode, not dozens of events —
 * Northstar prints it once a second while it waits.
 */
export async function eventsForInstance(
  key: string,
  outLog: string | undefined,
  sinceMs: number,
  maxLines = 4000,
): Promise<LogEvent[]> {
  if (!outLog) return [];
  const tail = await readLogTail(outLog, maxLines).catch(() => null);
  if (!tail) return [];

  const events: LogEvent[] = [];
  let episode: LogEvent | null = null;

  for (const line of tail.lines) {
    const at = parseTs(line);

    if (line.includes(C.LOG_NO_FRAME)) {
      if (at === null) continue;
      if (episode && at - (episode.untilMs ?? episode.atMs) <= 5000) {
        episode.untilMs = at;
        episode.count = (episode.count ?? 1) + 1;
      } else {
        episode = {
          atMs: at,
          untilMs: at,
          count: 1,
          instanceKey: key,
          kind: "frame-loss",
          text: C.LOG_NO_FRAME,
        };
        events.push(episode);
      }
      continue;
    }

    // Any other line ends the current run of frame-loss messages.
    if (episode && at !== null && at - (episode.untilMs ?? episode.atMs) > 5000) episode = null;

    if (line.includes(C.LOG_STARTING) && at !== null) {
      events.push({ atMs: at, instanceKey: key, kind: "restart", text: C.LOG_STARTING });
      episode = null;
    } else if (C.LOG_NO_CALIBRATION.test(line) && at !== null) {
      const last = events[events.length - 1];
      // Also printed every few seconds; collapse a run into one entry.
      if (!(last?.kind === "no-calibration" && at - (last.untilMs ?? last.atMs) <= 15000)) {
        events.push({
          atMs: at,
          untilMs: at,
          instanceKey: key,
          kind: "no-calibration",
          text: "No calibration found",
        });
      } else {
        last.untilMs = at;
      }
    }
  }

  return events.filter((e) => (e.untilMs ?? e.atMs) >= sinceMs);
}

export type Correlation = {
  event: LogEvent;
  /** Link state immediately before the episode began, if known. */
  linkBefore?: LinkSample;
  /** Any link change inside the window preceding the episode. */
  precedingChange?: LinkSample;
  /**
   * A check fired BY this episode, taken while frames were still stopped. This
   * is the strongest evidence available — the periodic sampler cannot catch a
   * fallback that recovers in a second.
   */
  duringEpisode?: LinkSample;
  /** Was the link already degraded when frames stopped? */
  degradedBefore: boolean | null;
  /** Was it degraded while frames were actually stopped? */
  degradedDuring: boolean | null;
};

/**
 * Line up each frame-loss episode with what the USB link was doing just before
 * it started.
 */
export async function correlate(sinceMs: number) {
  const instances = await discoverInstances();
  const history = await readHistory(sinceMs - CORRELATION_WINDOW_MS);

  const allEvents: LogEvent[] = [];
  await Promise.all(
    instances.map(async (i) => {
      const evs = await eventsForInstance(i.key, i.outLog, sinceMs);
      allEvents.push(...evs);
    }),
  );
  allEvents.sort((a, b) => a.atMs - b.atMs);

  const correlations: Correlation[] = allEvents
    .filter((e) => e.kind === "frame-loss")
    .map((event) => {
      const forCamera = history
        .filter((h) => h.instanceKey === event.instanceKey)
        .sort((a, b) => a.atMs - b.atMs);
      const before = forCamera.filter((h) => h.atMs <= event.atMs);
      const linkBefore = before[before.length - 1];
      const precedingChange = before
        .filter(
          (h) =>
            h.kind !== "heartbeat" && event.atMs - h.atMs <= CORRELATION_WINDOW_MS,
        )
        .pop();
      // A triggered sample landing between the episode start and a little after
      // its end was taken because of this episode.
      const duringEpisode = forCamera.find(
        (h) =>
          h.kind === "triggered" &&
          h.atMs >= event.atMs - 1000 &&
          h.atMs <= (event.untilMs ?? event.atMs) + 5000,
      );
      return {
        event,
        linkBefore,
        precedingChange,
        duringEpisode,
        degradedBefore: linkBefore ? linkBefore.degraded : null,
        degradedDuring: duringEpisode ? duringEpisode.degraded : null,
      };
    });

  const withHistory = correlations.filter((c) => c.degradedBefore !== null);
  const degraded = withHistory.filter((c) => c.degradedBefore === true).length;
  const checked = correlations.filter((c) => c.degradedDuring !== null);
  const degradedDuring = checked.filter((c) => c.degradedDuring === true).length;

  return {
    sinceMs,
    windowMs: CORRELATION_WINDOW_MS,
    events: allEvents,
    history,
    correlations,
    summary: {
      frameLossEpisodes: correlations.length,
      episodesWithLinkHistory: withHistory.length,
      episodesPrecededByDegradedLink: degraded,
      /**
       * Deliberately not phrased as a conclusion. A handful of episodes proves
       * nothing either way; this is a count to look at, not a verdict.
       */
      episodesCheckedDuring: checked.length,
      episodesDegradedDuring: degradedDuring,
      verdict:
        checked.length > 0
          ? degradedDuring === 0
            ? `The bus was checked during ${checked.length} episode${checked.length === 1 ? "" : "s"} and the link was healthy every time. That is evidence against the USB-2-fallback theory, not proof.`
            : `The link was degraded during ${degradedDuring} of ${checked.length} episodes checked while frames were stopped.`
          : withHistory.length === 0
            ? "No link history covers these episodes yet — leave the app running and check back."
            : degraded === 0
              ? `None of the ${withHistory.length} covered episodes had a degraded link beforehand, and none were checked mid-episode yet.`
              : `${degraded} of ${withHistory.length} covered episodes had a degraded link beforehand.`,
    },
  };
}
