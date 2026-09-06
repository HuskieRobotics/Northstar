"use client";

import { useEffect, useState } from "react";

/**
 * Frame-loss episodes lined up against USB link state.
 *
 * The point is not to declare a cause. It is to make the question answerable:
 * when Northstar lost frames, was the link already degraded? A live reading
 * cannot say; a timeline can.
 */
export default function LinkHistory() {
  const [data, setData] = useState<any>(null);
  const [hours, setHours] = useState(6);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/cabling/history?hours=${hours}`)
      .then((r) => r.json())
      .then((d) => (d?.error ? setErr(d.error) : (setData(d), setErr(null))))
      .catch((e) => setErr(String(e)));
  }, [hours]);

  const fmt = (ms: number) => new Date(ms).toLocaleTimeString();
  const dur = (a: number, b?: number) =>
    b && b > a ? `${Math.max(1, Math.round((b - a) / 1000))}s` : "—";

  return (
    <>
      <h3>Frame loss vs USB link</h3>
      <p className="sub">
        The logs are watched sub-second, and the moment <code>No frame received</code> appears the USB
        bus is checked immediately rather than waiting for the next sampling tick. Measured latency
        from log line to check: ~0.3s. That matters because an episode can recover in just over a
        second — a periodic sampler would essentially never see it.
      </p>

      {err && <p className="note">▲ {err}</p>}

      <div className="tabrow" style={{ margin: "0 0 10px" }}>
        {[1, 6, 24, 72].map((h) => (
          <button key={h} aria-pressed={hours === h} onClick={() => setHours(h)}>
            {h}h
          </button>
        ))}
      </div>

      {data && (
        <>
          <p
            className={data.summary.episodesPrecededByDegradedLink > 0 ? "note" : "sub"}
            style={{ marginTop: 0 }}
          >
            {data.summary.frameLossEpisodes} frame-loss episode
            {data.summary.frameLossEpisodes === 1 ? "" : "s"} · {data.summary.verdict}
          </p>

          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Instance</th>
                  <th>Frame loss</th>
                  <th>Checked during episode</th>
                  <th>Link before</th>
                  <th>Changed just before?</th>
                </tr>
              </thead>
              <tbody>
                {data.correlations.map((c: any, i: number) => (
                  <tr key={i}>
                    <td className="num">{fmt(c.event.atMs)}</td>
                    <td>{c.event.instanceKey.replace(/^config/, "")}</td>
                    <td className="num">
                      {dur(c.event.atMs, c.event.untilMs)}
                      {c.event.count > 1 ? ` · ${c.event.count} lines` : ""}
                    </td>
                    <td
                      className="num"
                      style={{ color: c.degradedDuring === true ? "var(--fail)" : undefined }}
                      title={c.duringEpisode?.trigger ?? ""}
                    >
                      {c.degradedDuring === null
                        ? "— not checked"
                        : c.degradedDuring
                          ? `✕ degraded (${c.duringEpisode?.speed ?? "USB 2"})`
                          : `● healthy (${c.duringEpisode?.speed ?? "USB 3"})`}
                    </td>
                    <td
                      className="num"
                      style={{ color: c.degradedBefore === true ? "var(--fail)" : undefined }}
                    >
                      {c.degradedBefore === null
                        ? "— no history"
                        : c.degradedBefore
                          ? `✕ degraded (${c.linkBefore?.speed ?? "USB 2"})`
                          : `● ok (${c.linkBefore?.speed ?? "USB 3"})`}
                    </td>
                    <td className="num">
                      {c.precedingChange
                        ? `${c.precedingChange.kind} at ${fmt(c.precedingChange.atMs)}`
                        : "—"}
                    </td>
                  </tr>
                ))}
                {data.correlations.length === 0 && (
                  <tr>
                    <td colSpan={5} className="empty">
                      No frame-loss episodes in this window. That is the good outcome.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <h3>Link changes recorded</h3>
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Camera</th>
                  <th>Event</th>
                  <th>Speed</th>
                  <th>Active transports</th>
                </tr>
              </thead>
              <tbody>
                {data.history
                  .slice()
                  .reverse()
                  .slice(0, 60)
                  .map((h: any, i: number) => (
                    <tr key={i}>
                      <td className="num">{fmt(h.atMs)}</td>
                      <td className="num">
                        {h.instanceKey?.replace(/^config/, "") ?? h.cameraId}
                      </td>
                      <td
                        style={{
                          color:
                            h.kind === "disappeared"
                              ? "var(--fail)"
                              : h.kind === "change"
                                ? "var(--warn)"
                                : undefined,
                        }}
                      >
                        {h.kind}
                      </td>
                      <td className="num" style={{ color: h.degraded ? "var(--fail)" : undefined }}>
                        {h.speed ?? "—"}
                      </td>
                      <td className="num">{h.active?.join("+") || "—"}</td>
                    </tr>
                  ))}
                {data.history.length === 0 && (
                  <tr>
                    <td colSpan={5} className="empty">
                      No link history yet — the sampler records only on change, so this stays empty
                      while everything is stable.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
