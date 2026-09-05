"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export type SignalState = "ok" | "warn" | "fail" | "starting" | "unknown" | "n/a";

/**
 * Never colour alone. Every state carries a glyph so it survives colourblindness
 * and a washed-out laptop screen in a venue.
 */
export const GLYPH: Record<SignalState, string> = {
  ok: "●",
  warn: "▲",
  fail: "✕",
  starting: "◐",
  unknown: "?",
  "n/a": "–",
};

export function Signal({
  label,
  state,
  detail,
  emphasize,
}: {
  label: string;
  state: SignalState;
  detail?: string;
  emphasize?: boolean;
}) {
  return (
    <span
      className={`sig${emphasize ? " first-fail" : ""}`}
      data-state={state}
      title={detail ? `${label}: ${detail}` : label}
    >
      <span className="glyph">{GLYPH[state]}</span>
      {label}
    </span>
  );
}

export function TopBar({ children }: { children?: React.ReactNode }) {
  const path = usePathname();
  const link = (href: string, text: string) => (
    <Link href={href} className={path === href ? "active" : ""}>
      {text}
    </Link>
  );
  return (
    <header className="topbar">
      <div className="brand">
        Northstar <span>· 3061</span>
      </div>
      {children}
      <nav>
        {link("/", "Dashboard")}
        {link("/cameras", "Cameras")}
        {link("/videos", "Recordings")}
        {link("/system", "System")}
      </nav>
    </header>
  );
}

export function fmtDuration(seconds?: number | null): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "—";
  const s = Math.floor(seconds % 60);
  const m = Math.floor((seconds / 60) % 60);
  const h = Math.floor(seconds / 3600);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/** Round-trip a number for display, or an em dash when we genuinely do not know. */
export const num = (v: number | null | undefined, digits = 0, suffix = "") =>
  v === null || v === undefined || !Number.isFinite(v) ? "—" : `${v.toFixed(digits)}${suffix}`;
