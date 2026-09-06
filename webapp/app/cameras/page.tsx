"use client";

import { useEffect, useState } from "react";
import { TopBar } from "@/components/shared";
import LinkHistory from "@/components/LinkHistory";

export default function CamerasPage() {
  const [cal, setCal] = useState<any>(null);
  const [cab, setCab] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * Deliberately on a long cache with a manual re-check: whatcable probes the
   * USB bus, and this app must not disturb cameras that are actively streaming.
   */
  const loadCabling = (force = false) => {
    setBusy(true);
    return fetch(`/api/cabling${force ? "?refresh=1" : ""}`)
      .then((r) => r.json())
      .then(setCab)
      .catch((e) => setErr(`/api/cabling: ${String(e)}`))
      .finally(() => setBusy(false));
  };

  useEffect(() => {
    // Surface failures rather than sitting on "Loading…" forever.
    fetch("/api/calibrations")
      .then((r) => r.json())
      .then((d) => (d?.error ? setErr(`/api/calibrations: ${d.error}`) : setCal(d)))
      .catch((e) => setErr(`/api/calibrations: ${String(e)}`));
    loadCabling();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <TopBar />
      <div className="wrap">
        <h1>Cameras</h1>
        {err && <p className="note">▲ {err}</p>}

        <h3>Calibration per instance</h3>
        <p className="sub">
          A missing calibration is a quiet failure: the pipeline runs but publishes nothing, logging
          only every five seconds.
        </p>
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Instance</th>
                <th>camera_id</th>
                <th>Calibration</th>
              </tr>
            </thead>
            <tbody>
              {cal?.perInstance
                ?.filter((p: any) => p.isCamera)
                .map((p: any) => (
                  <tr key={p.key}>
                    <td>{p.key.replace(/^config/, "")}</td>
                    <td className="num">{p.cameraId ?? "—"}</td>
                    <td
                      className="num"
                      style={{
                        color:
                          p.present === false ? "var(--fail)" : p.present ? "var(--ok)" : undefined,
                      }}
                    >
                      {p.present === null
                        ? "— (no camera id yet)"
                        : p.present
                          ? "✓ present"
                          : "✕ missing"}
                    </td>
                  </tr>
                ))}
              {!cal && (
                <tr>
                  <td colSpan={3} className="sub">
                    Loading…
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <h3>USB cabling &amp; link quality</h3>
        <p className="sub">
          From <code>whatcable --json</code>, matched to instances by serial number. A camera that has
          negotiated down to USB&nbsp;2 still reports frames and FPS, so it looks healthy everywhere
          else on this dashboard — it is called out here.
        </p>

        {cab && !cab.available && <p className="note">▲ {cab.error}</p>}

        {cab?.available && (
          <>
            <div className="tabrow" style={{ margin: "0 0 10px" }}>
              <button onClick={() => loadCabling(true)} disabled={busy}>
                {busy ? "Checking…" : "Re-check now"}
              </button>
              <span className="sub" style={{ margin: 0, alignSelf: "center" }}>
                whatcable {cab.version} · read {Math.round((Date.now() - cab.checkedAtMs) / 1000)}s
                ago · cached {Math.round(cab.cacheMs / 1000)}s
              </span>
            </div>

            <div className="scroll">
              <table>
                <thead>
                  <tr>
                    <th>Instance</th>
                    <th>Camera</th>
                    <th>Port</th>
                    <th>Link</th>
                    <th>Transports active / supported</th>
                    <th>Verdict</th>
                  </tr>
                </thead>
                <tbody>
                  {cab.links.map((l: any, i: number) => (
                    <tr key={i}>
                      <td>{l.instanceKey?.replace(/^config/, "") ?? <em>unmatched</em>}</td>
                      <td className="num" title={l.device?.name ?? ""}>
                        {l.cameraId ?? "—"}
                      </td>
                      <td className="num">
                        {l.portName ?? "—"}
                        {l.locationID ? ` · ${l.locationID}` : ""}
                      </td>
                      <td className="num" style={{ color: l.degraded ? "var(--fail)" : undefined }}>
                        {l.speed ?? "—"}
                      </td>
                      <td className="num">
                        {l.transports.active.join("+") || "—"}
                        <span style={{ color: "var(--dim)" }}>
                          {" / "}
                          {l.transports.supported.join("+") || "—"}
                        </span>
                      </td>
                      <td style={{ color: l.degraded ? "var(--fail)" : undefined }}>
                        {l.degraded
                          ? "✕ degraded to USB 2 on a USB 3 port"
                          : (l.dataLinkWarning ?? "● ok")}
                      </td>
                    </tr>
                  ))}
                  {cab.links.length === 0 && (
                    <tr>
                      <td colSpan={6} className="empty">
                        No cameras found on the USB bus.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {cab.missing?.length > 0 && (
              <p className="note" style={{ marginTop: 10 }}>
                ▲ Configured but not present on the USB bus:{" "}
                {cab.missing
                  .map((m: any) => `${m.key.replace(/^config/, "")} (${m.cameraId})`)
                  .join(", ")}
              </p>
            )}
          </>
        )}

        <LinkHistory />

        <h3>Calibration files on disk</h3>
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>camera_id</th>
                <th>Modified</th>
                <th>Size</th>
              </tr>
            </thead>
            <tbody>
              {cal?.files?.map((f: any) => (
                <tr key={f.file}>
                  <td className="num">{f.cameraId}</td>
                  <td className="num">{new Date(f.mtimeMs).toLocaleString()}</td>
                  <td className="num">{f.sizeBytes} B</td>
                </tr>
              ))}
              {cal?.files?.length === 0 && (
                <tr>
                  <td colSpan={3} className="empty">
                    No calibration files found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
