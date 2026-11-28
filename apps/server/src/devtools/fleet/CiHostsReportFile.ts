// @effect-diagnostics nodeBuiltinImport:off globalDate:off - The Fleet hosts-check report file: parse, merge, write, and cheap change signatures.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { readHostOffState } from "@t3tools/ship-queue/hostOffMarker";

import type { FleetHostsReport } from "./FleetTypes.ts";

export function atomicWriteJson(filePath: string, value: unknown): void {
  try {
    NodeFS.mkdirSync(NodePath.dirname(filePath), { recursive: true, mode: 0o700 });
    const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
    NodeFS.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
    NodeFS.renameSync(tmp, filePath);
  } catch {
    // best-effort state cache write
  }
}

export function parseHostsReport(raw: string): FleetHostsReport | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || parsed.schema !== 1 || !Array.isArray(parsed.hosts)) return null;
    return {
      schema: 1,
      at: typeof parsed.at === "string" ? parsed.at : new Date().toISOString(),
      ...(typeof parsed.manifest === "string" ? { manifest: parsed.manifest } : {}),
      hosts: parsed.hosts.filter((h): h is Record<string, unknown> =>
        Boolean(h && typeof h === "object"),
      ),
      ...(Array.isArray(parsed.settings) ? { settings: parsed.settings } : {}),
    };
  } catch {
    return null;
  }
}

export function mergeHostReports(prev: FleetHostsReport, next: FleetHostsReport): FleetHostsReport {
  const mergedHosts = [...prev.hosts];
  for (const h of next.hosts) {
    const name = typeof h.name === "string" ? h.name : "";
    if (!name) continue;
    const idx = mergedHosts.findIndex((old) => old.name === name);
    if (idx >= 0) mergedHosts[idx] = h;
    else mergedHosts.push(h);
  }
  return { ...prev, at: next.at, hosts: mergedHosts };
}

/** Changes when the file is rewritten, replaced, created or removed; one stat, no read. */
export function fileSignature(filePath: string | null): string {
  if (!filePath) return "none";
  try {
    const st = NodeFS.statSync(filePath, { throwIfNoEntry: false });
    return st ? `${st.ino}:${st.size}:${st.mtimeMs}` : "missing";
  } catch {
    // An untraversable queue root must not break the whole Fleet snapshot.
    return "unreadable";
  }
}

/**
 * A hosts check reads each `.off` marker once, and `ship-queue hosts off|on` can change one later.
 * Rewrites every row's CI state from the live marker, so the Fleet switch never shows a host as on
 * (or off) from a stale report.
 */
export function withLiveOffState(
  rep: FleetHostsReport,
  queueRoot: string,
  extra: ReadonlyArray<Record<string, unknown>> = [],
): FleetHostsReport {
  const hosts = [...rep.hosts, ...extra].map((h) => {
    const name = typeof h.name === "string" ? h.name : "";
    if (!name) return h;
    let off: { at: string; by: string; reason: string; version: string } | null;
    try {
      off = readHostOffState(queueRoot, name);
    } catch {
      // The marker exists but cannot be read: show the host as off, never as on.
      off = { at: "", by: "", reason: "unreadable .off marker", version: "" };
    }
    return {
      ...h,
      ci_off: off !== null,
      ci_off_at: off?.at || null,
      ci_off_by: off?.by || null,
      ci_off_reason: off?.reason || null,
      ci_off_version: off?.version || null,
    };
  });
  return { ...rep, hosts };
}
