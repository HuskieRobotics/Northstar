import { exec } from "node:child_process";
import { promisify } from "node:util";
import * as C from "./contract";
import * as NT from "./nt";
import { discoverInstances } from "./discovery";
import { WHATCABLE_BIN, WHATCABLE_CACHE_MS, WHATCABLE_NO_PROBE } from "./settings";

const sh = promisify(exec);

/**
 * WhatCable integration — USB link quality per camera.
 *
 * Motivation: Northstar sometimes stops receiving frames, kills the instance,
 * re-enumerates the port and retries. One candidate cause is the camera
 * negotiating *down* from USB 3 to USB 2 — the pipeline looks healthy by every
 * other measure while the link silently halved. WhatCable exposes exactly that:
 * which transports a port supports, which were provisioned, and which are
 * actually active.
 *
 * Join key: `devices[].serialNumber` from WhatCable equals Northstar's
 * `camera_id` (verified against a Basler daA1280-54um reporting 24608715 on
 * both sides).
 *
 * Shape below is from `whatcable --json` v1.4.0. It is an external tool's
 * output format, not an API — treat it as loosely as the Northstar log strings,
 * and fail soft rather than throwing if a field moves.
 */

export type WcDevice = {
  name?: string;
  vendorName?: string;
  serialNumber?: string;
  speed?: string;
  usbVersion?: string;
  locationID?: string;
};

export type WcPort = {
  name?: string;
  type?: string;
  status?: string;
  headline?: string;
  subtitle?: string;
  connectionActive?: boolean;
  devices?: WcDevice[];
  transports?: {
    active?: string[];
    provisioned?: string[];
    supported?: string[];
    usb3Speed?: string;
  };
  dataLink?: {
    summary?: string;
    detail?: string;
    bottleneck?: string;
    isWarning?: boolean;
  };
};

export type WcReport = { version?: string; ports?: WcPort[]; isDesktopMac?: boolean };

type Cached = { at: number; report: WcReport | null; error: string | null };
const g = globalThis as unknown as { __ns_wc?: Cached };

/** Is this device running at USB 2 speed? */
export function isUsb2(dev: WcDevice): boolean {
  if (dev.usbVersion && /^2/.test(dev.usbVersion)) return true;
  return /high[- ]speed|full[- ]speed|480\s*mbps|12\s*mbps/i.test(dev.speed ?? "");
}

/**
 * A camera running at USB 2 on a port that supports USB 3 is the degradation
 * worth catching — it is invisible to every other signal on the dashboard.
 */
export function linkDegraded(dev: WcDevice, port: WcPort): boolean {
  const couldDoUsb3 =
    !!port.transports?.supported?.includes("USB3") ||
    !!port.transports?.provisioned?.includes("USB3");
  return isUsb2(dev) && couldDoUsb3;
}

async function runWhatCable(): Promise<{ report: WcReport | null; error: string | null }> {
  const args = WHATCABLE_NO_PROBE ? "--json --no-usb-probe" : "--json";
  try {
    const { stdout } = await sh(`${WHATCABLE_BIN} ${args}`, {
      timeout: 8000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { report: JSON.parse(stdout) as WcReport, error: null };
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    if (/not found|ENOENT/i.test(msg)) {
      return {
        report: null,
        error:
          "whatcable not installed. brew install darrylmorley/whatcable/whatcable-cli, " +
          "or set NORTHSTAR_WHATCABLE_BIN to its path.",
      };
    }
    return { report: null, error: msg.split("\n")[0] };
  }
}

/**
 * Cached because this shells out and performs USB probing. Probing a bus that
 * is actively streaming camera frames is not obviously free, and the whole
 * point of this app is not to disturb the vision pipelines — so it runs on a
 * timer measured in tens of seconds, never per request.
 */
export async function getReport(force = false): Promise<Cached> {
  const now = Date.now();
  const cached = g.__ns_wc;
  if (!force && cached && now - cached.at < WHATCABLE_CACHE_MS) return cached;
  const { report, error } = await runWhatCable();
  g.__ns_wc = { at: now, report, error };
  return g.__ns_wc;
}

export type CameraLink = {
  /** Northstar instance key, when the serial matches a configured camera. */
  instanceKey?: string;
  deviceId?: string;
  cameraId?: string;
  portName?: string;
  device: WcDevice;
  speed?: string;
  usbVersion?: string;
  locationID?: string;
  transports: { active: string[]; provisioned: string[]; supported: string[] };
  usb3Speed?: string;
  degraded: boolean;
  dataLinkWarning?: string;
  dataLinkDetail?: string;
};

/** Correlate WhatCable devices with the Northstar instances that use them. */
export async function cablingReport(force = false) {
  // Sampling starts as soon as anything asks about cabling, so history begins
  // accumulating without needing the history page to be opened first.
  const { ensureSampler } = await import("./cablingHistory");
  ensureSampler();
  const { report, error, at } = await getReport(force);

  const instances = await discoverInstances();
  const byCameraId = new Map<string, { key: string; deviceId: string }>();
  const expected: { key: string; deviceId: string; cameraId?: string; matched: boolean }[] = [];
  for (const i of instances) {
    const deviceId = i.config?.device_id;
    if (!deviceId) continue;
    const isCamera = !!i.config && (i.config.apriltags_enable || i.config.objdetect_enable);
    if (!isCamera) continue;
    const cameraId = NT.getValue<string>(C.nsConfig(deviceId, "camera_id"));
    if (cameraId) byCameraId.set(cameraId, { key: i.key, deviceId });
    expected.push({ key: i.key, deviceId, cameraId, matched: false });
  }

  const links: CameraLink[] = [];
  for (const port of report?.ports ?? []) {
    for (const dev of port.devices ?? []) {
      const match = dev.serialNumber ? byCameraId.get(dev.serialNumber) : undefined;
      // Keep cameras even when unmatched — an unexpected camera on the bus is
      // itself worth seeing.
      const looksLikeCamera =
        !!match || /basler|arducam|camera|daA\d|ov\d{4}/i.test(`${dev.vendorName} ${dev.name}`);
      if (!looksLikeCamera) continue;
      if (match) {
        const e = expected.find((x) => x.key === match.key);
        if (e) e.matched = true;
      }
      links.push({
        instanceKey: match?.key,
        deviceId: match?.deviceId,
        cameraId: dev.serialNumber,
        portName: port.name,
        device: dev,
        speed: dev.speed,
        usbVersion: dev.usbVersion,
        locationID: dev.locationID,
        transports: {
          active: port.transports?.active ?? [],
          provisioned: port.transports?.provisioned ?? [],
          supported: port.transports?.supported ?? [],
        },
        usb3Speed: port.transports?.usb3Speed,
        degraded: linkDegraded(dev, port),
        dataLinkWarning: port.dataLink?.isWarning ? port.dataLink.summary : undefined,
        dataLinkDetail: port.dataLink?.detail,
      });
    }
  }

  return {
    available: !!report,
    error,
    version: report?.version,
    checkedAtMs: at,
    cacheMs: WHATCABLE_CACHE_MS,
    links: links.sort((a, b) => (a.instanceKey ?? "zz").localeCompare(b.instanceKey ?? "zz")),
    /** Configured cameras with no matching USB device — not plugged in. */
    missing: expected.filter((e) => !e.matched && e.cameraId),
  };
}

/** Degradation keyed by instance, for the dashboard cards. Never throws. */
export async function degradedByInstance(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    const { report } = await getReport();
    if (!report) return out;
    const instances = await discoverInstances();
    for (const i of instances) {
      const deviceId = i.config?.device_id;
      if (!deviceId) continue;
      const cameraId = NT.getValue<string>(C.nsConfig(deviceId, "camera_id"));
      if (!cameraId) continue;
      for (const port of report.ports ?? []) {
        for (const dev of port.devices ?? []) {
          if (dev.serialNumber !== cameraId) continue;
          if (linkDegraded(dev, port)) {
            out.set(
              i.key,
              `USB link degraded — running at ${dev.speed ?? "USB 2"} on a port that supports USB 3.`,
            );
          }
        }
      }
    }
  } catch {
    /* cabling is enrichment; never let it break status */
  }
  return out;
}
