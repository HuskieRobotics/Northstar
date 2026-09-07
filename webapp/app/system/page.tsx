"use client";

import { useEffect, useState } from "react";
import { TopBar, fmtDuration, num } from "@/components/shared";

export default function SystemPage() {
  const [sys, setSys] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const load = () =>
      fetch("/api/system")
        .then((r) => r.json())
        .then((d) => (d.error ? setErr(d.error) : setSys(d)))
        .catch((e) => setErr(String(e)));
    load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, []);

  return (
    <>
      <TopBar />
      <div className="wrap">
        <h1>Mac mini</h1>
        {err && <p className="note">{err}</p>}
        {!sys && !err && <p className="sub">Loading…</p>}
        {sys && (
          <>
            <div className="scroll">
              <table>
                <tbody>
                  <tr>
                    <th>Host</th>
                    <td className="num">
                      {sys.hostname} · {sys.platform}
                    </td>
                  </tr>
                  <tr>
                    <th>Uptime</th>
                    <td className="num">{fmtDuration(sys.uptimeSeconds)}</td>
                  </tr>
                  <tr>
                    <th>Load (1/5/15)</th>
                    <td className="num">{sys.loadavg.map((l: number) => l.toFixed(2)).join("  ")}</td>
                  </tr>
                  <tr>
                    <th>Memory</th>
                    <td className="num">
                      {num(sys.memTotalGb - sys.memFreeGb, 1)} / {num(sys.memTotalGb, 1)} GB used
                    </td>
                  </tr>
                  <tr>
                    <th>Disk free</th>
                    <td className="num" style={{ color: sys.disk.warn ? "var(--fail)" : undefined }}>
                      {num(sys.disk.freeGb, 1)} GB
                      {sys.disk.warn && ` ▲ below ${sys.disk.warnThresholdGb} GB`}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            <h3>
              Power &amp; thermal
              <span className="sub"> — collected by the configPower instance, not by this app</span>
            </h3>
            {sys.power ? (
              <div className="scroll">
                <table>
                  <tbody>
                    <tr>
                      <th>CPU</th>
                      <td className="num">{num(sys.power.cpuMw, 0, " mW")}</td>
                    </tr>
                    <tr>
                      <th>GPU</th>
                      <td className="num">{num(sys.power.gpuMw, 0, " mW")}</td>
                    </tr>
                    <tr>
                      <th>ANE</th>
                      <td className="num">{num(sys.power.aneMw, 0, " mW")}</td>
                    </tr>
                    <tr>
                      <th>Pressure</th>
                      <td className="num">{sys.power.pressure}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="sub">No power metrics — the power instance is not running or NT is down.</p>
            )}

            <h3>Northstar processes</h3>
            <div className="scroll">
              <table>
                <thead>
                  <tr>
                    <th>Instance</th>
                    <th>PID</th>
                    <th>CPU %</th>
                    <th>RSS</th>
                  </tr>
                </thead>
                <tbody>
                  {sys.processes.map((p: any) => (
                    <tr key={p.pid}>
                      <td>{p.key}</td>
                      <td className="num">{p.pid}</td>
                      <td className="num">{p.cpu.toFixed(1)}</td>
                      <td className="num">{p.rssMb.toFixed(0)} MB</td>
                    </tr>
                  ))}
                  {sys.processes.length === 0 && (
                    <tr>
                      <td colSpan={4} className="empty">
                        No Northstar processes running.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </>
  );
}
