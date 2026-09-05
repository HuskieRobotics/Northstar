"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Signal, TopBar, fmtDuration, num, SignalState } from "./shared";

type Sig = { label: string; state: SignalState; detail?: string };
type Instance = {
  key: string;
  deviceId: string | null;
  cameraLocation: string | null;
  isCamera: boolean;
  sources: string[];
  signals: Sig[];
  overall: SignalState;
  vitals: Record<string, number | string | boolean | null | undefined>;
  streams: { apriltag?: number; objdetect?: number };
  logs: { available: boolean; newErrors: number };
  notes: string[];
};
type Status = {
  instances: Instance[];
  nt: { connected: boolean; server: string; serverTimeTrusted: boolean; topicCount: number };
  host: {
    uptimeSeconds: number;
    withinStartupGrace: boolean;
    graceSeconds: number;
    loadavg: number[];
    hostname: string;
  };
  vision: { enabled?: boolean; updating?: boolean; camerasToConsider?: string };
  generatedAtMs: number;
};

const EDGE: Record<SignalState, string> = {
  ok: "var(--ok)",
  warn: "var(--warn)",
  fail: "var(--fail)",
  starting: "var(--starting)",
  unknown: "var(--unknown)",
  idle: "var(--muted)",
  "n/a": "var(--na)",
};

const SLOW_SECONDS = 8;

export default function Dashboard({ snapshotIntervalMs }: { snapshotIntervalMs: number }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [live, setLive] = useState<{ key: string; kind: string } | null>(null);
  const [connected, setConnected] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<number | null>(null);
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    const slowTimer = setTimeout(() => setSlow(true), SLOW_SECONDS * 1000);
    const es = new EventSource("/api/status/stream");
    es.onmessage = (e) => {
      try {
        setStatus(JSON.parse(e.data));
        setConnected(true);
        setLastUpdate(Date.now());
      } catch {
        /* ignore malformed frame */
      }
    };
    es.onerror = () => setConnected(false);
    es.onopen = () => setConnected(true);
    return () => {
      clearTimeout(slowTimer);
      es.close();
    };
  }, []);

  if (!status) {
    // Never sit at "Connecting…" indefinitely with no explanation — say what is
    // being waited on and what to check.
    return (
      <>
        <TopBar />
        <div className="wrap">
          <p className="sub">Connecting to the status stream…</p>
          {slow && (
            <p className="note">
              ▲ No data after {SLOW_SECONDS}s. The server is reachable (this page loaded), so the
              status endpoint is failing or still compiling. Check the terminal running the server;
              in <code>next dev</code> the first request to each route compiles it, which can take a
              few seconds.
            </p>
          )}
        </div>
      </>
    );
  }

  const cams = status.instances.filter((i) => i.isCamera);
  const others = status.instances.filter((i) => !i.isCamera);
  const healthy = cams.filter((i) => i.overall === "ok").length;

  // Time since power-on is often the single most useful number here: "up 0:18,
  // waiting for roboRIO" is a complete and reassuring answer, where the same
  // state without it reads as catastrophic failure.
  const booting = status.host.withinStartupGrace;

  return (
    <>
      <TopBar>
        <div className="stat">
          <span className="k">Cameras</span>
          <span className="v" style={{ color: healthy === cams.length ? "var(--ok)" : "var(--warn)" }}>
            {healthy}/{cams.length}
          </span>
        </div>
        <div className="stat">
          <span className="k">Uptime</span>
          <span className="v">{fmtDuration(status.host.uptimeSeconds)}</span>
        </div>
        <div className="stat">
          <span className="k">NT</span>
          <span className="v" style={{ color: status.nt.connected ? "var(--ok)" : "var(--warn)" }}>
            {status.nt.connected ? "connected" : "waiting"}
          </span>
        </div>
        <div className="stat">
          <span className="k">Load</span>
          <span className="v">{status.host.loadavg[0]?.toFixed(2)}</span>
        </div>
        {!connected && <span className="badge err">page disconnected</span>}
      </TopBar>

      <div className="wrap">
        {booting && !status.nt.connected && (
          <p className="note">
            ◐ Up {fmtDuration(status.host.uptimeSeconds)} — waiting for the roboRIO. The Mac mini boots
            first, so this is normal for the first {status.host.graceSeconds}s after power-on.
          </p>
        )}
        {!booting && !status.nt.connected && (
          <p className="note">
            ▲ Not connected to NetworkTables at {status.nt.server}. Robot-side signals are unavailable;
            local status below is still accurate.
          </p>
        )}
        {status.nt.connected && !status.nt.serverTimeTrusted && (
          <p className="note">◐ Re-syncing robot clock — NT timestamps are not trusted yet.</p>
        )}

        <div className="grid">
          {cams.map((i) => (
            <Card
              key={i.key}
              inst={i}
              intervalMs={snapshotIntervalMs}
              paused={live !== null}
              onOpen={(kind) => setLive({ key: i.key, kind })}
            />
          ))}
        </div>

        {others.length > 0 && (
          <>
            <h3>Other instances</h3>
            <div className="grid">
              {others.map((i) => (
                <Card key={i.key} inst={i} intervalMs={0} paused onOpen={() => {}} />
              ))}
            </div>
          </>
        )}

        {status.instances.length === 0 && (
          <p className="empty">
            No Northstar instances found. Neither launchd nor a process scan turned anything up.
          </p>
        )}

        <p className="sub" style={{ marginTop: 24 }}>
          {status.nt.topicCount} NT topics · updated{" "}
          {lastUpdate ? `${Math.round((Date.now() - lastUpdate) / 1000)}s ago` : "—"}
          {status.vision.enabled !== undefined && ` · vision ${status.vision.enabled ? "enabled" : "disabled"}`}
          {status.vision.camerasToConsider && ` · considering ${status.vision.camerasToConsider}`}
        </p>
      </div>

      {live && <LiveStream inst={live} onClose={() => setLive(null)} />}
    </>
  );
}

function Card({
  inst,
  intervalMs,
  paused,
  onOpen,
}: {
  inst: Instance;
  intervalMs: number;
  paused: boolean;
  onOpen: (kind: string) => void;
}) {
  const visible = inst.signals.filter((s) => s.state !== "n/a");
  const firstBad = visible.findIndex((s) => s.state === "fail" || s.state === "warn");
  const detail = firstBad >= 0 ? visible[firstBad] : visible.find((s) => s.state === "starting");

  const v = inst.vitals;
  const acceptPct = v.acceptPct as number | null | undefined;

  return (
    <div className="card" style={{ ["--edge" as string]: EDGE[inst.overall] }}>
      <h2>
        <Link href={`/instance/${inst.key}`}>{inst.key.replace(/^config/, "")}</Link>
        <span className="device">{inst.deviceId ?? "no device_id"}</span>
        {v.recording === true && <span className="badge rec">REC</span>}
        {inst.logs.newErrors > 0 && (
          <span className="badge err" title="lines in the error log">
            {inst.logs.newErrors} err
          </span>
        )}
      </h2>

      <div className="chain">
        {inst.signals.map((s, idx) => (
          <Signal
            key={s.label}
            {...s}
            emphasize={firstBad >= 0 && visible[firstBad]?.label === s.label}
          />
        ))}
      </div>

      <div className="detail">{detail?.detail ?? detail?.label ?? ""}</div>

      {/* Camera vitals only. The power-metrics instance has no camera, so a grid
          of empty dashes would be noise rather than information. */}
      {inst.isCamera && (
      <div className="vitals">
        <div>
          <span className="k">FPS</span>
          <span className="v">
            {num((v.fpsApriltag ?? v.fpsObjdetect) as number | undefined)}
          </span>
        </div>
        <div>
          <span className="k">Accepted</span>
          <span className="v">{num(v.acceptedRate as number | null, 1, "/s")}</span>
        </div>
        <div>
          <span className="k">Rejected</span>
          <span className="v">{num(v.rejectedRate as number | null, 1, "/s")}</span>
        </div>
        <div>
          <span className="k">Accept</span>
          <span
            className="v"
            style={{
              color:
                acceptPct === null || acceptPct === undefined
                  ? undefined
                  : acceptPct >= 50
                    ? "var(--ok)"
                    : "var(--warn)",
            }}
          >
            {num(acceptPct, 0, "%")}
          </span>
        </div>
        <div>
          <span className="k">Stale</span>
          <span className="v">{num(v.staleSeconds as number | undefined, 1, "s")}</span>
        </div>
        <div>
          <span className="k">Camera</span>
          <span className="v" title={String(v.cameraId ?? "")}>
            {(v.cameraId as string) ?? "—"}
          </span>
        </div>
      </div>
      )}

      {inst.notes.map((n) => (
        <div key={n} className="note">
          {n}
        </div>
      ))}

      {(inst.isCamera || inst.streams.apriltag !== undefined) && (
      <div className="thumbs">
        {inst.streams.apriltag !== undefined && (
          <Thumb
            instKey={inst.key}
            kind="apriltag"
            label="AprilTag"
            intervalMs={intervalMs}
            paused={paused}
            onOpen={onOpen}
          />
        )}
        {inst.streams.objdetect !== undefined && (
          <Thumb
            instKey={inst.key}
            kind="objdetect"
            label="Objects"
            intervalMs={intervalMs}
            paused={paused}
            onOpen={onOpen}
          />
        )}
        {inst.isCamera &&
          inst.streams.apriltag === undefined &&
          inst.streams.objdetect === undefined && (
            <div className="thumb">
              <div className="placeholder">no streams enabled</div>
            </div>
          )}
      </div>
      )}
    </div>
  );
}

/**
 * A thumbnail is one JPEG fetched on an interval — connect, read one frame,
 * disconnect. Northstar only encodes while a client is attached, so this keeps
 * the cost near zero instead of holding a stream open per camera.
 *
 * Polling stops when the tab is hidden or a full-rate stream is open.
 */
function Thumb({
  instKey,
  kind,
  label,
  intervalMs,
  paused,
  onOpen,
}: {
  instKey: string;
  kind: string;
  label: string;
  intervalMs: number;
  paused: boolean;
  onOpen: (kind: string) => void;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const objectUrl = useRef<string | null>(null);

  useEffect(() => {
    if (intervalMs <= 0 || paused) return;
    let alive = true;

    const tick = async () => {
      if (!alive || document.hidden) return;
      try {
        const res = await fetch(`/api/snapshot/${instKey}/${kind}`, { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const blob = await res.blob();
        if (!alive) return;
        if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
        objectUrl.current = URL.createObjectURL(blob);
        setSrc(objectUrl.current);
        setFailed(false);
      } catch {
        if (alive) setFailed(true);
      }
    };

    void tick();
    const t = setInterval(tick, intervalMs);
    return () => {
      alive = false;
      clearInterval(t);
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    };
  }, [instKey, kind, intervalMs, paused]);

  return (
    <button className="thumb" onClick={() => onOpen(kind)} title={`Open live ${label} stream`}>
      {src && <img src={src} alt={`${label} preview`} />}
      {!src && (
        <div className="placeholder">
          {failed ? "stream not listening" : paused ? "paused" : "waiting for frame…"}
        </div>
      )}
      <span className="label">{label}</span>
    </button>
  );
}

/**
 * Full-rate view. Only one is open at a time, and the cost is stated plainly —
 * an attached client makes the worker copy, overlay and JPEG-encode every frame.
 */
function LiveStream({ inst, onClose }: { inst: { key: string; kind: string }; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="livebar" onClick={onClose}>
      <div className="livebox" onClick={(e) => e.stopPropagation()}>
        <div className="livehead">
          <strong>
            {inst.key.replace(/^config/, "")} · {inst.kind}
          </strong>
          <span className="livewarn">
            live stream attached — this costs CPU on the Mac mini
          </span>
          <button style={{ marginLeft: "auto" }} onClick={onClose}>
            Close (Esc)
          </button>
        </div>
        {/* Unmounting this img aborts the request, which tears down the upstream
            socket and releases the Northstar worker. */}
        <img src={`/api/stream/${inst.key}/${inst.kind}`} alt="live stream" />
      </div>
    </div>
  );
}
