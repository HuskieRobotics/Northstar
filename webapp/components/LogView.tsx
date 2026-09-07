"use client";

import { useEffect, useRef, useState } from "react";

type Line = { text: string; kind: string };

export default function LogView({ instKey, stream }: { instKey: string; stream: "out" | "err" }) {
  const [lines, setLines] = useState<Line[]>([]);
  const [available, setAvailable] = useState(true);
  const [reason, setReason] = useState<string | null>(null);
  const [bootIndex, setBootIndex] = useState<number | null>(null);
  const [follow, setFollow] = useState(true);
  const [filter, setFilter] = useState("");
  const boxRef = useRef<HTMLPreElement>(null);
  const esRef = useRef<EventSource | null>(null);

  // Initial tail
  useEffect(() => {
    let alive = true;
    (async () => {
      const res = await fetch(`/api/logs/${instKey}/${stream}?lines=400`, { cache: "no-store" });
      const data = await res.json();
      if (!alive) return;
      setAvailable(data.available);
      setReason(data.reason ?? null);
      setLines(data.lines ?? []);
      setBootIndex(data.bootIndex ?? null);
      if (data.available) {
        esRef.current?.close();
        const es = new EventSource(`/api/logs/${instKey}/${stream}/stream?from=${data.nextOffset}`);
        es.onmessage = (e) => {
          try {
            const incoming: Line[] = JSON.parse(e.data);
            setLines((prev) => [...prev, ...incoming].slice(-3000));
          } catch {
            /* keepalive or malformed */
          }
        };
        esRef.current = es;
      }
    })();
    return () => {
      alive = false;
      esRef.current?.close();
    };
  }, [instKey, stream]);

  // Auto-scroll, which disengages as soon as the user scrolls up.
  useEffect(() => {
    if (!follow || !boxRef.current) return;
    boxRef.current.scrollTop = boxRef.current.scrollHeight;
  }, [lines, follow]);

  const onScroll = () => {
    const el = boxRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (!atBottom && follow) setFollow(false);
  };

  if (!available) {
    return (
      <p className="sub">
        {reason ?? "No log file."}{" "}
        <span className="note">
          Redirect through <code>tee</code> to the conventional path if you want log features here.
        </span>
      </p>
    );
  }

  const shown = filter
    ? lines.filter((l) => {
        try {
          return new RegExp(filter, "i").test(l.text);
        } catch {
          return l.text.toLowerCase().includes(filter.toLowerCase());
        }
      })
    : lines;

  return (
    <>
      <div style={{ display: "flex", gap: 8, alignItems: "center", margin: "8px 0" }}>
        <input
          placeholder="filter (substring or regex)"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{
            flex: 1,
            background: "var(--panel-2)",
            color: "var(--text)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            padding: "5px 9px",
            font: "inherit",
          }}
        />
        <button aria-pressed={follow} onClick={() => setFollow((f) => !f)}>
          {follow ? "Following" : "Paused"}
        </button>
        <a className="btn" href={`/api/logs/${instKey}/${stream}/download`}>
          Download
        </a>
      </div>

      <pre className="log" ref={boxRef} onScroll={onScroll}>
        {shown.map((l, i) => (
          <span key={i}>
            {/* Log files persist across power cycles with no boot marker, so mark
                where this power-on began. */}
            {!filter && bootIndex !== null && i === bootIndex && (
              <span className="bootline">— current boot —</span>
            )}
            <span className={`l ${l.kind}`}>{l.text}</span>
          </span>
        ))}
        {shown.length === 0 && <span className="l">(no matching lines)</span>}
      </pre>
    </>
  );
}
