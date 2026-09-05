"use client";

import { useEffect, useState } from "react";
import { TopBar } from "@/components/shared";

export default function CamerasPage() {
  const [data, setData] = useState<any>(null);
  const [cal, setCal] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    // Surface failures rather than sitting on "Loading…" forever.
    const load = (url: string, set: (v: any) => void) =>
      fetch(url)
        .then((r) => r.json())
        .then((d) => (d?.error ? setErr(`${url}: ${d.error}`) : set(d)))
        .catch((e) => setErr(`${url}: ${String(e)}`));
    load("/api/cameras", setData);
    load("/api/calibrations", setCal);
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
              {cal?.perInstance?.filter((p: any) => p.isCamera).map((p: any) => (
                <tr key={p.key}>
                  <td>{p.key}</td>
                  <td className="num">{p.cameraId ?? "—"}</td>
                  <td
                    className="num"
                    style={{ color: p.present === false ? "var(--fail)" : p.present ? "var(--ok)" : undefined }}
                  >
                    {p.present === null ? "— (no camera id yet)" : p.present ? "✓ present" : "✕ missing"}
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

        <h3>Cabling</h3>
        <p className="sub">
          Not yet implemented. The intent is to integrate with WhatCable and report the cabling it
          detects, so a camera that is present but wired wrong is visible here rather than inferred
          from a dead tile.
        </p>

      </div>
    </>
  );
}
