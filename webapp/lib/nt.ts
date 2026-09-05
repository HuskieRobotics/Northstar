import { NT4_Client, NT4_Topic } from "./nt4/NT4";
import { NT_SERVER } from "./settings";
import * as C from "./contract";

/**
 * One server-side NT4 client, shared by every request and every browser tab, so
 * exactly one extra client appears on the robot's network regardless of how many
 * people have the page open. Also means the page works from a laptop that can
 * reach the Mac mini but not the roboRIO.
 *
 * Subscribe-only — the app never publishes.
 */

export type Sample = {
  value: unknown;
  /** Server timestamp in microseconds, as reported with the value. */
  serverTs: number;
  /** Local receipt time — trustworthy even when server time is not. */
  localMs: number;
};

type State = {
  client: NT4_Client | null;
  connected: boolean;
  connectedSinceMs: number | null;
  /**
   * Server time is UNRELIABLE at two moments (design doc §7.1):
   *   1. null inside onConnect — the RTT socket has not round-tripped yet.
   *   2. STALE right after a reconnect — serverTimeOffset_us is not cleared on
   *      disconnect, so the previous session's offset is reused. Measured: a
   *      reconnect reported 1304.9s of robot uptime for a roboRIO that had just
   *      restarted. That window coincides exactly with a roboRIO reboot, when
   *      the carried-over offset is wildly in the future — anything stamped with
   *      it would look permanently fresh.
   * So: invalid on disconnect, and untrusted until a fresh RTT sample lands.
   */
  serverTimeValidAtMs: number | null;
  values: Map<string, Sample>;
  topics: Set<string>;
  subscribed: Set<string>;
  disconnects: number;
  /**
   * Last local time each boolean topic was observed true.
   *
   * Some robot-side booleans oscillate at frame rate — `ReceivingFrames` was
   * measured changing ~5×/second — so an instantaneous read lands on `false`
   * routinely while the camera is perfectly healthy. Latching here, inside the
   * value callback, catches every transition; polling from computeStatus would
   * miss most of them.
   */
  lastTrueMs: Map<string, number>;
};

const RTT_SETTLE_MS = 1000; // NT4.1 RTT period is 250ms; allow a few round trips

const g = globalThis as unknown as { __ns_nt?: State };

function state(): State {
  if (!g.__ns_nt) {
    g.__ns_nt = {
      client: null,
      connected: false,
      connectedSinceMs: null,
      serverTimeValidAtMs: null,
      values: new Map(),
      topics: new Set(),
      subscribed: new Set(),
      disconnects: 0,
      lastTrueMs: new Map(),
    };
  }
  return g.__ns_nt;
}

export function ensureStarted(): void {
  const s = state();
  if (s.client) return;

  const client = new NT4_Client(
    NT_SERVER,
    [5810],
    "northstar_webapp",
    (topic: NT4_Topic) => s.topics.add(topic.name),
    (topic: NT4_Topic) => {
      s.topics.delete(topic.name);
      s.values.delete(topic.name);
    },
    (topic: NT4_Topic, serverTs: number, value: unknown) => {
      const now = Date.now();
      s.values.set(topic.name, { value, serverTs, localMs: now });
      if (value === true) s.lastTrueMs.set(topic.name, now);
    },
    () => {
      s.connected = true;
      s.connectedSinceMs = Date.now();
      s.serverTimeValidAtMs = Date.now() + RTT_SETTLE_MS;
    },
    () => {
      s.connected = false;
      s.connectedSinceMs = null;
      s.serverTimeValidAtMs = null;
      s.disconnects += 1;
      // Values from the previous session are no longer current. Topics get
      // re-announced automatically on reconnect and we never re-subscribe —
      // verified across a 238s outage.
      s.values.clear();
      s.topics.clear();
      s.lastTrueMs.clear();
    },
  );

  s.client = client;
  client.connect();

  // The NT server's own client table. `@<n>` is unknown ahead of time, so this
  // one must be a prefix — but it is tiny (4 topics per connection).
  subscribePrefix(C.NT_CLIENTS_PREFIX);

  // Global vision outputs: three scalars.
  subscribeExact([C.VISION_IS_ENABLED, C.VISION_IS_UPDATING, C.VISION_CAMERAS_TO_CONSIDER]);
}

function subscribePrefix(prefix: string) {
  const s = state();
  if (s.subscribed.has(`p:${prefix}`) || !s.client) return;
  s.client.subscribe([prefix], true, false, 0.25);
  s.subscribed.add(`p:${prefix}`);
}

function subscribeExact(topics: string[]) {
  const s = state();
  if (!s.client) return;
  const fresh = topics.filter((t) => !s.subscribed.has(t));
  if (fresh.length === 0) return;
  // Exact-name subscription works for topics that do not exist yet — late
  // announcement is the normal boot path, since the Mac mini beats the roboRIO.
  s.client.subscribe(fresh, false, false, 0.25);
  for (const t of fresh) s.subscribed.add(t);
}

/**
 * Subscribe to exactly what the dashboard needs for these devices.
 *
 * Deliberately narrow. A prefix subscription on "" pulls ~280 messages/second,
 * overwhelmingly Pose3d arrays this app never reads. We take counters, booleans
 * and scalars, plus the small `observations` payload — and none of the pose
 * arrays. That keeps our cost on the robot network negligible.
 */
export function ensureDeviceSubscriptions(deviceIds: string[]): void {
  ensureStarted();
  const topics: string[] = [];

  for (const deviceId of deviceIds) {
    for (const k of C.NS_OUTPUT_KEYS) topics.push(C.nsOutput(deviceId, k));
    for (const k of C.NS_CONFIG_KEYS) topics.push(C.nsConfig(deviceId, k));

    const loc = C.cameraLocationFor(deviceId);
    if (!loc) continue;
    topics.push(
      C.visionInput(loc, C.VISION_CONNECTED),
      C.visionInput(loc, C.VISION_RECEIVING_FRAMES),
      C.visionInput(loc, C.VISION_THERMAL),
      C.visionInput(loc, C.VISION_CPU_POWER),
      C.visionInput(loc, C.VISION_GPU_POWER),
      C.visionInput(loc, C.VISION_APRILTAG_FPS),
      C.visionInput(loc, C.VISION_OBJDETECT_FPS),
      C.visionOutput(loc, C.VISION_UPDATE_POSE_COUNT),
      C.visionOutput(loc, C.VISION_REJECTED_POSE_COUNT),
      C.visionOutput(loc, C.VISION_CYCLES_NO_RESULTS),
    );
  }
  subscribeExact(topics);
}

export function ntStatus() {
  ensureStarted();
  const s = state();
  return {
    server: NT_SERVER,
    connected: s.connected,
    connectedSinceMs: s.connectedSinceMs,
    serverTimeTrusted: serverTimeTrusted(),
    topicCount: s.topics.size,
    disconnects: s.disconnects,
  };
}

export function serverTimeTrusted(): boolean {
  const s = state();
  return s.connected && s.serverTimeValidAtMs !== null && Date.now() >= s.serverTimeValidAtMs;
}

export function get(topic: string): Sample | undefined {
  ensureStarted();
  return state().values.get(topic);
}

export function getValue<T>(topic: string): T | undefined {
  const v = get(topic);
  return v === undefined ? undefined : (v.value as T);
}

export function getNumber(topic: string): number | undefined {
  const v = getValue<unknown>(topic);
  return typeof v === "number" ? v : undefined;
}

export function getBool(topic: string): boolean | undefined {
  const v = getValue<unknown>(topic);
  return typeof v === "boolean" ? v : undefined;
}

/**
 * Has this boolean been true at any point in the last `windowMs`?
 *
 * Use this rather than the current value for anything that toggles at frame
 * rate. A momentary `false` is not a fault.
 */
export function trueWithin(topic: string, windowMs: number): boolean | undefined {
  ensureStarted();
  const s = state();
  if (!s.topics.has(topic)) return undefined;
  const last = s.lastTrueMs.get(topic);
  if (last !== undefined && Date.now() - last <= windowMs) return true;
  return s.values.has(topic) ? false : undefined;
}

/** Age of a value in milliseconds, measured on OUR clock — never the robot's. */
export function ageMs(topic: string): number | null {
  const v = get(topic);
  return v ? Date.now() - v.localMs : null;
}

/**
 * Resolve a Northstar device to its NT-server client entry.
 *
 * Entries persist after a client disconnects and `@<n>` increments per
 * connection, so one device accumulates several entries — three stale ones were
 * observed alongside one live. Presence is NOT liveness: take the entry
 * reporting Connected=true if any exists.
 */
export function ntClientConnected(deviceId: string): boolean | null {
  ensureStarted();
  const s = state();
  let found = false;
  for (const t of s.topics) {
    if (!t.startsWith(C.NT_CLIENTS_PREFIX) || !t.endsWith("/Connected")) continue;
    const name = t.slice(C.NT_CLIENTS_PREFIX.length, -"/Connected".length);
    const m = name.match(/^(.*)@(\d+)$/);
    if (!m || m[1] !== deviceId) continue;
    found = true;
    if (s.values.get(t)?.value === true) return true;
  }
  return found ? false : null;
}
