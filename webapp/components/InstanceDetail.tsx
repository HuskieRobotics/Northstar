"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import LogView from "./LogView";
import { Signal, TopBar, fmtDuration, num, SignalState } from "./shared";

type Sig = { label: string; state: SignalState; detail?: string };

export default function InstanceDetail({ instKey }: { instKey: string }) {
  const [status, setStatus] = useState<any>(null);
  const [instances, setInstances] = useState<any>(null);
  const [stream, setStream] = useState<"out" | "err">("out");
  const [showLive, setShowLive] = useState<string | null>(null);

  useEffect(() => {
    const es = new EventSource("/api/status/stream");
    es.onmessage = (e) => {
      try {
        setStatus(JSON.parse(e.data));
      } catch {
        /* ignore */
      }
    };
    fetch("/api/instances")
      .then((r) => r.json())
      .then(setInstances)
      .catch(() => {});
    return () => es.close();
  }, []);

  const inst = status?.instances?.find((i: any) => i.key === instKey);
  const raw = instances?.instances?.find((i: any) => i.key === instKey);

  return (
    <>
      <TopBar />
      <div className="wrap">
        <p className="sub">
          <Link href="/">← Dashboard</Link>
        </p>
        <h1>{instKey}</h1>

        {!inst && <p className="empty">Instance not found, or still loading.</p>}

        {inst && (
          <>
            <div className="chain" style={{ margin: "10px 0" }}>
              {inst.signals.map((s: Sig) => (
                <Signal key={s.label} {...s} />
              ))}
            </div>
            {inst.signals
              .filter((s: Sig) => s.detail)
              .map((s: Sig) => (
                <div key={s.label} className="sub">
                  <strong>{s.label}:</strong> {s.detail}
                </div>
              ))}
            {inst.notes?.map((n: string) => (
              <p key={n} className="note">
                {n}
              </p>
            ))}

            <h3>Live values</h3>
            <div className="scroll">
              <table>
                <tbody>
                  <Row k="device_id" v={inst.deviceId} />
                  <Row k="camera location" v={inst.cameraLocation ?? "not tracked by robot code"} />
                  <Row k="discovered via" v={inst.sources?.join(", ")} />
                  <Row k="camera_id" v={inst.vitals.cameraId} />
                  <Row k="resolution" v={inst.vitals.resolution} />
                  <Row k="exposure" v={inst.vitals.exposure} />
                  <Row k="gain" v={inst.vitals.gain} />
                  <Row k="throttle_fps" v={inst.vitals.throttleFps} />
                  <Row k="recording" v={String(inst.vitals.recording ?? "—")} />
                  <Row k="fps (apriltag)" v={inst.vitals.fpsApriltag} />
                  <Row k="fps (objdetect)" v={inst.vitals.fpsObjdetect} />
                  <Row k="tags in frame" v={inst.vitals.tagCount ?? "—"} />
                  <Row k="accepted / s" v={num(inst.vitals.acceptedRate, 2)} />
                  <Row k="rejected / s" v={num(inst.vitals.rejectedRate, 2)} />
                  <Row k="accept rate" v={num(inst.vitals.acceptPct, 0, "%")} />
                  <Row
                    k="cycles with no results"
                    v={
                      inst.vitals.staleCycles === undefined
                        ? "—"
                        : `${inst.vitals.staleCycles} (${num(inst.vitals.staleSeconds, 1, "s")})`
                    }
                  />
                  <Row k="thermal" v={inst.vitals.thermal} />
                </tbody>
              </table>
            </div>

            {raw && (
              <>
                <h3>Process &amp; files</h3>
                <div className="scroll">
                  <table>
                    <tbody>
                      <Row k="config" v={raw.configPath} />
                      <Row k="launchd label" v={raw.launchdLabel ?? "— (not under launchd)"} />
                      <Row k="launchd pid" v={raw.launchdPid ?? "—"} />
                      <Row k="last exit status" v={raw.lastExitStatus ?? "—"} />
                      <Row k="python pid" v={raw.pythonPid ?? "— (not running)"} />
                      <Row
                        k="python uptime"
                        v={
                          raw.pythonStartedMs
                            ? fmtDuration((Date.now() - raw.pythonStartedMs) / 1000)
                            : "—"
                        }
                      />
                      <Row k="stdout log" v={raw.outLog ?? "— (writes to terminal)"} />
                      <Row k="stderr log" v={raw.errLog ?? "—"} />
                      <Row k="capture impl" v={raw.config?.capture_impl} />
                    </tbody>
                  </table>
                </div>
              </>
            )}

            {(inst.streams.apriltag !== undefined || inst.streams.objdetect !== undefined) && (
              <>
                <h3>Streams</h3>
                <div style={{ display: "flex", gap: 8 }}>
                  {inst.streams.apriltag !== undefined && (
                    <button onClick={() => setShowLive("apriltag")}>Open AprilTag stream</button>
                  )}
                  {inst.streams.objdetect !== undefined && (
                    <button onClick={() => setShowLive("objdetect")}>Open object stream</button>
                  )}
                </div>
                {showLive && (
                  <div style={{ marginTop: 10 }}>
                    <p className="note">
                      Live stream attached — this costs a frame copy, overlay and JPEG encode per frame
                      on the Mac mini.{" "}
                      <button onClick={() => setShowLive(null)}>Stop</button>
                    </p>
                    <img
                      src={`/api/stream/${instKey}/${showLive}`}
                      alt="live"
                      style={{ maxWidth: "100%", borderRadius: 8, background: "#000" }}
                    />
                  </div>
                )}
              </>
            )}
          </>
        )}

        <h3>Logs</h3>
        <div style={{ display: "flex", gap: 8 }}>
          <button aria-pressed={stream === "out"} onClick={() => setStream("out")}>
            stdout
          </button>
          <button aria-pressed={stream === "err"} onClick={() => setStream("err")}>
            stderr{inst?.logs?.newErrors ? ` (${inst.logs.newErrors})` : ""}
          </button>
        </div>
        <LogView instKey={instKey} stream={stream} />
      </div>
    </>
  );
}

function Row({ k, v }: { k: string; v: unknown }) {
  return (
    <tr>
      <th style={{ width: 200 }}>{k}</th>
      <td className="num">{v === undefined || v === null || v === "" ? "—" : String(v)}</td>
    </tr>
  );
}
