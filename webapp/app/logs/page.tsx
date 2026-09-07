"use client";

import { useEffect, useState } from "react";
import { TopBar } from "@/components/shared";
import LogView from "@/components/LogView";

/**
 * Pick an instance, read its stdout and stderr. The error log gets its own tab
 * with a count, because that is where the useful information lands and it is
 * the one people forget to open.
 */
export default function LogsPage() {
  const [instances, setInstances] = useState<any[] | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [stream, setStream] = useState<"out" | "err">("out");
  const [errCounts, setErrCounts] = useState<Record<string, number>>({});

  useEffect(() => {
    const es = new EventSource("/api/status/stream");
    es.onmessage = (e) => {
      try {
        const d = JSON.parse(e.data);
        setInstances(d.instances);
        setErrCounts(
          Object.fromEntries(d.instances.map((i: any) => [i.key, i.logs?.newErrors ?? 0])),
        );
        setSel((cur) => cur ?? d.instances[0]?.key ?? null);
      } catch {
        /* ignore */
      }
    };
    return () => es.close();
  }, []);

  const current = instances?.find((i) => i.key === sel);

  return (
    <>
      <TopBar />
      <div className="wrap">
        <h1>Logs</h1>

        {!instances && <p className="sub">Loading…</p>}
        {instances?.length === 0 && <p className="empty">No instances discovered.</p>}

        {instances && instances.length > 0 && (
          <>
            <div className="tabrow">
              {instances.map((i) => (
                <button
                  key={i.key}
                  aria-pressed={sel === i.key}
                  onClick={() => setSel(i.key)}
                  title={i.deviceId ?? ""}
                >
                  {i.key.replace(/^config/, "")}
                  {errCounts[i.key] > 0 && <span className="badge err">{errCounts[i.key]}</span>}
                </button>
              ))}
            </div>

            {sel && (
              <>
                <div className="tabrow" style={{ marginTop: 10 }}>
                  <button aria-pressed={stream === "out"} onClick={() => setStream("out")}>
                    stdout
                  </button>
                  <button aria-pressed={stream === "err"} onClick={() => setStream("err")}>
                    stderr
                    {errCounts[sel] > 0 && <span className="badge err">{errCounts[sel]}</span>}
                  </button>
                  <span className="sub" style={{ margin: "0 0 0 8px", alignSelf: "center" }}>
                    {current?.deviceId}
                  </span>
                </div>

                {/* Remount on change so the tail and follow-stream restart cleanly. */}
                <LogView key={`${sel}:${stream}`} instKey={sel} stream={stream} />
              </>
            )}
          </>
        )}
      </div>
    </>
  );
}
