"use client";

import { useEffect, useState } from "react";
import { TopBar, fmtBytes } from "@/components/shared";

export default function VideosPage() {
  const [videos, setVideos] = useState<any[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/videos")
      .then((r) => r.json())
      .then((d) => (d?.error ? setErr(d.error) : setVideos(d.videos ?? [])))
      .catch((e) => setErr(String(e)));
  }, []);

  return (
    <>
      <TopBar />
      <div className="wrap">
        <h1>Recordings</h1>
        {err && <p className="note">▲ {err}</p>}
        <p className="sub">
          HEVC in MKV — most browsers will not play these, so they are download links. A recording
          interrupted by the robot being switched off is never finalized by ffmpeg and may not open.
        </p>
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Device</th>
                <th>When</th>
                <th>Match</th>
                <th>Type</th>
                <th>Size</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {videos?.map((v) => (
                <tr key={v.file}>
                  <td>{v.device}</td>
                  <td className="num">{v.when}</td>
                  <td className="num">{v.rest ?? "—"}</td>
                  <td>{v.raw ? "raw" : "overlaid"}</td>
                  <td className="num" style={{ color: v.suspect ? "var(--fail)" : undefined }}>
                    {fmtBytes(v.sizeBytes)}
                    {v.suspect && " ▲ empty"}
                  </td>
                  <td>
                    <a className="btn" href={`/api/videos/${encodeURIComponent(v.name)}`}>
                      Download
                    </a>
                  </td>
                </tr>
              ))}
              {videos?.length === 0 && (
                <tr>
                  <td colSpan={6} className="empty">
                    No recordings found.
                  </td>
                </tr>
              )}
              {!videos && (
                <tr>
                  <td colSpan={6} className="sub">
                    Loading…
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
