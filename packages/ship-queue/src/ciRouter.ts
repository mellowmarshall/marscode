// @effect-diagnostics nodeBuiltinImport:off - CI capability/arch routing, room rules, battery skip, settle window, route leases, and host-off parking.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { normalizeArch, type CiHostEntry, type CiHostsManifest } from "./ciHosts.ts";
import { computeHostLacks } from "./ciToolVersion.ts";
import { isHostOff, readProbeFile } from "./hostProbe.ts";

export const NODE_MAX_AGE_S = 120;
export const NODE_SAMPLES = 10;
export const NODE_NEWEST = 2;
export const ON_BATTERY_BUSY = 999;
export const DEFAULT_ROUTE_SETTLE_S = 90;

/**
 * In-memory fleet telemetry snapshot shape compatible with MarsCode's `NativeFleetService.getNodesMap(true)`
 * and `RemoteNodeProber.getCachedNodes(true)`. Zero `fleet-nodes.json` file handoff!
 */
export interface FleetNodeTelemetrySample {
  readonly host: {
    readonly name: string;
    readonly cpus: number;
    readonly cpu_pct?: number | undefined;
    readonly cpu_hist: ReadonlyArray<number>;
    readonly ts: string;
  };
  readonly status?: string | undefined;
  readonly power?: "ac" | "battery" | undefined;
}

export interface LocalPowerState {
  readonly onBattery: "true" | "false" | "unknown";
}

export interface FleetTelemetryProvider {
  readonly getNodesMap: () => Readonly<Record<string, FleetNodeTelemetrySample>>;
  readonly getLocalPower?: (() => LocalPowerState | null) | undefined;
}

export interface NodeLoadReading {
  readonly busy: number;
  readonly cores: number;
  readonly sampledAtSec: number;
  readonly onBattery: boolean;
}

export interface RouteCandidateInput {
  readonly name: string;
  readonly kind: "local" | "remote";
  readonly busy: number;
  readonly cores: number;
  readonly active: number;
  readonly limit: number;
}

export interface SelectedRouteTarget {
  readonly kind: "local" | "remote";
  readonly host: string;
  readonly busy: number;
  readonly cores: number;
  readonly verdict: "room" | "full";
}

export interface ActiveRouteLease {
  readonly jobId: string;
  readonly host: string;
  readonly routedAtSec: number;
  readonly ciDone: boolean;
}

export interface HostQualifyResult {
  readonly qualified: ReadonlyArray<CiHostEntry>;
  readonly localOk: boolean;
  readonly offCandidates: ReadonlyArray<string>;
  readonly allOff: boolean;
  readonly reason: string;
  readonly lacksByHost: Readonly<Record<string, ReadonlyArray<string>>>;
}

export interface JobParkRecord {
  readonly for: "ci-host-off";
  readonly hosts: ReadonlyArray<string>;
  readonly atSec: number;
}

/** Room limit for a host: fewer than half its cores busy (minimum 1). */
export function computeHostRoomLimit(cores: number): number {
  return Math.max(1, Math.floor(Math.max(1, cores) / 2));
}

export function buildHostPriorityMap(manifest: CiHostsManifest): ReadonlyMap<string, number> {
  const map = new Map<string, number>();
  for (const h of manifest.hosts) {
    if (typeof h.priority === "number" && Number.isInteger(h.priority) && h.priority >= 1) {
      map.set(h.name, h.priority);
    }
  }
  return map;
}

export function hostPriorityRank(host: string, priorities: ReadonlyMap<string, number>): number {
  const explicit = priorities.get(host);
  if (explicit !== undefined) return explicit;
  let maxRank = 3;
  for (const val of priorities.values()) {
    if (val > maxRank) maxRank = val;
  }
  return priorities.size > 0 ? maxRank + 1 : 4;
}

/**
 * Evaluates a single node's load from in-memory fleet telemetry (`NativeFleetService` / `RemoteNodeProber`).
 * Uses the higher of the last 10-sample mean and the newest 2-sample mean, returning `null` if stale (>120s).
 */
export function evaluateNodeLoad(
  node: FleetNodeTelemetrySample | undefined,
  nowEpochSec: number,
  localPowerOverride?: LocalPowerState | null,
): NodeLoadReading | null {
  if (!node?.host) return null;
  const { cpus, cpu_pct, cpu_hist, ts } = node.host;
  if (!Number.isInteger(cpus) || cpus < 1 || typeof ts !== "string" || !Array.isArray(cpu_hist)) {
    return null;
  }
  if (typeof cpu_pct !== "number" || !Number.isFinite(cpu_pct)) return null;
  const parsedMs = Date.parse(ts.length === 19 ? `${ts}Z` : ts);
  if (!Number.isFinite(parsedMs)) return null;
  const sampledAtSec = Math.floor(parsedMs / 1000);
  const age = nowEpochSec - sampledAtSec;
  if (age < -NODE_MAX_AGE_S || age > NODE_MAX_AGE_S) return null;

  if (node.power === "battery" || localPowerOverride?.onBattery === "true") {
    return { busy: ON_BATTERY_BUSY, cores: cpus, sampledAtSec, onBattery: true };
  }
  const recent = cpu_hist
    .slice(-NODE_SAMPLES)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (recent.length === 0) return null;

  const newest = recent.slice(-NODE_NEWEST);
  const avgAll = recent.reduce((sum, v) => sum + v, 0) / recent.length;
  const avgNew = newest.reduce((sum, v) => sum + v, 0) / newest.length;
  const pct = Math.min(100, Math.max(0, avgAll, avgNew));
  const busy = Math.ceil((cpus * pct) / 100 - 1e-9);
  return { busy, cores: cpus, sampledAtSec, onBattery: false };
}

/** Reads in-memory loads for all named hosts, resolving guest `on` parent machine telemetry automatically. */
export function readInMemoryNodeLoads(input: {
  readonly manifest: CiHostsManifest;
  readonly telemetry: FleetTelemetryProvider;
  readonly hostNames: ReadonlyArray<string>;
  readonly nowEpochSec: number;
}): ReadonlyMap<string, NodeLoadReading> {
  const nodes = input.telemetry.getNodesMap();
  const localPower = input.telemetry.getLocalPower?.() ?? null;
  const onParentByHost = new Map<string, string>();
  const localHostName = input.manifest.hosts.find((h) => h.ssh === null)?.name;
  for (const h of input.manifest.hosts) {
    if (h.on) onParentByHost.set(h.name, h.on);
  }

  const out = new Map<string, NodeLoadReading>();
  for (const name of input.hostNames) {
    const parent = onParentByHost.get(name);
    const node = (parent ? nodes[parent] : undefined) ?? nodes[name];
    const reading = evaluateNodeLoad(
      node,
      input.nowEpochSec,
      name === localHostName ? localPower : null,
    );
    if (reading) out.set(name, reading);
  }
  return out;
}

export function readLastAssigned(queueRoot: string): {
  readonly seq: number;
  readonly hosts: Readonly<Record<string, number>>;
} {
  const ledgerPath = NodePath.join(queueRoot, "last_assigned.json");
  if (!NodeFS.existsSync(ledgerPath)) return { seq: 0, hosts: {} };
  try {
    const parsed = JSON.parse(NodeFS.readFileSync(ledgerPath, "utf8")) as Record<string, unknown>;
    const seq = typeof parsed.seq === "number" && Number.isInteger(parsed.seq) ? parsed.seq : 0;
    const rawHosts =
      parsed.hosts && typeof parsed.hosts === "object" && !Array.isArray(parsed.hosts)
        ? (parsed.hosts as Record<string, unknown>)
        : {};
    const hosts: Record<string, number> = {};
    for (const [k, v] of Object.entries(rawHosts)) {
      if (typeof v === "number" && Number.isInteger(v)) hosts[k] = v;
    }
    return { seq, hosts };
  } catch {
    return { seq: 0, hosts: {} };
  }
}

export function recordLastAssigned(queueRoot: string, hostName: string): void {
  NodeFS.mkdirSync(queueRoot, { recursive: true });
  const prev = readLastAssigned(queueRoot);
  const nextSeq = prev.seq + 1;
  const nextHosts = { ...prev.hosts, [hostName]: nextSeq };
  const ledgerPath = NodePath.join(queueRoot, "last_assigned.json");
  const tmp = `${ledgerPath}.tmp.${process.pid}`;
  NodeFS.writeFileSync(tmp, JSON.stringify({ seq: nextSeq, hosts: nextHosts }), "utf8");
  NodeFS.renameSync(tmp, ledgerPath);
}

/** Counts CI runs on `hostName` that were routed after `cutoffEpochSec` (inside settle window) and are still running. */
export function countYoungActiveRoutes(
  leases: ReadonlyArray<ActiveRouteLease>,
  hostName: string,
  cutoffEpochSec: number,
): number {
  return leases.filter((l) => l.host === hostName && !l.ciDone && l.routedAtSec > cutoffEpochSec)
    .length;
}

/** Tie-breaker matching `sq_route.py`: room first, free-core ratio, priority, LRU, index. */
function compareRouteTarget(
  a: {
    readonly c: RouteCandidateInput;
    readonly rank: number;
    readonly seq: number;
    readonly idx: number;
  },
  b: {
    readonly c: RouteCandidateInput;
    readonly rank: number;
    readonly seq: number;
    readonly idx: number;
  },
): number {
  const aFull = a.c.active === 0 && a.c.busy < a.c.limit ? 0 : 1;
  const bFull = b.c.active === 0 && b.c.busy < b.c.limit ? 0 : 1;
  if (aFull !== bFull) return aFull - bFull;

  const aNum = aFull === 0 ? a.c.busy : a.c.busy + a.c.active * Math.floor(a.c.cores / 2);
  const bNum = bFull === 0 ? b.c.busy : b.c.busy + b.c.active * Math.floor(b.c.cores / 2);
  // Exact cross-multiplication to avoid floating-point drift (mirrors Python `Fraction(num, cores)`).
  const fracDiff = aNum * b.c.cores - bNum * a.c.cores;
  if (fracDiff !== 0) return fracDiff;

  if (a.rank !== b.rank) return a.rank - b.rank;
  if (a.seq !== b.seq) return a.seq - b.seq;
  return a.idx - b.idx;
}

/** Selects the optimal CI target host from candidate load snapshots (skipping battery hosts). */
export function selectRouteTarget(input: {
  readonly manifest: CiHostsManifest;
  readonly queueRoot: string;
  readonly candidates: ReadonlyArray<RouteCandidateInput>;
}):
  | { readonly kind: "selected"; readonly target: SelectedRouteTarget }
  | { readonly kind: "none"; readonly onBattery: ReadonlyArray<string> } {
  const priorities = buildHostPriorityMap(input.manifest);
  const { hosts: assigned } = readLastAssigned(input.queueRoot);
  const onBattery: string[] = [];
  const eligible: Array<{
    readonly c: RouteCandidateInput;
    readonly rank: number;
    readonly seq: number;
    readonly idx: number;
  }> = [];

  for (const [idx, c] of input.candidates.entries()) {
    if (c.busy >= ON_BATTERY_BUSY) {
      onBattery.push(c.name);
      continue;
    }
    eligible.push({
      c: { ...c, cores: Math.max(1, c.cores) },
      rank: hostPriorityRank(c.name, priorities),
      seq: assigned[c.name] ?? 0,
      idx,
    });
  }

  if (eligible.length === 0) {
    return { kind: "none", onBattery };
  }
  eligible.sort(compareRouteTarget);
  const best = eligible[0]!;
  const verdict: "room" | "full" =
    best.c.active === 0 && best.c.busy < best.c.limit ? "room" : "full";
  return {
    kind: "selected",
    target: {
      kind: best.c.kind,
      host: best.c.name,
      busy: best.c.busy,
      cores: best.c.cores,
      verdict,
    },
  };
}

/** Qualifies hosts against arch, tools, paths, and host-off state, detecting when only off hosts fit (for parking). */
export function qualifyCiHosts(input: {
  readonly queueRoot: string;
  readonly manifest: CiHostsManifest;
  readonly probesByHost: Readonly<Record<string, Readonly<Record<string, string>> | null>>;
  readonly requiredTools: ReadonlyArray<string>;
  readonly requiredArch?: ReadonlyArray<string> | undefined;
  readonly localOnly?: boolean | undefined;
  readonly ignoreOffState?: boolean | undefined;
}): HostQualifyResult {
  const localHost = input.manifest.hosts.find((h) => h.ssh === null);
  const candidates = input.localOnly && localHost ? [localHost] : [...input.manifest.hosts];
  const qualified: CiHostEntry[] = [];
  const offHosts: CiHostEntry[] = [];
  const lacksByHost: Record<string, ReadonlyArray<string>> = {};
  let localOk = false;
  let missingTokens = "";
  let toolMiss = false;
  let archMiss = false;

  const allowedArches = new Set((input.requiredArch ?? []).map(normalizeArch));

  for (const host of candidates) {
    if (!input.ignoreOffState && isHostOff(input.queueRoot, host.name)) {
      offHosts.push(host);
      continue;
    }
    const probe = input.probesByHost[host.name];
    if (!probe) {
      missingTokens += ` host=${host.name} tool=unprobed`;
      continue;
    }
    if (allowedArches.size > 0) {
      const arch = normalizeArch(probe.__arch ?? "");
      if (!arch || !allowedArches.has(arch)) {
        missingTokens += ` host=${host.name} arch=${arch || "unknown"}`;
        archMiss = true;
        continue;
      }
    }
    const lacks = computeHostLacks(input.manifest, probe, "base", input.requiredTools);
    if (lacks.length > 0) {
      lacksByHost[host.name] = lacks;
      missingTokens += ` host=${host.name} tool=${lacks[0]!.split(" ", 1)[0]}`;
      toolMiss = true;
      continue;
    }
    qualified.push(host);
    if (host.ssh === null) localOk = true;
  }

  if (qualified.length > 0) {
    return { qualified, localOk, offCandidates: [], allOff: false, reason: "", lacksByHost };
  }

  // Check whether any off host could satisfy the job based on its last cached probe.
  const fitOff: string[] = [];
  for (const host of offHosts) {
    const cachedProbe =
      input.probesByHost[host.name] ??
      readProbeFile(NodePath.join(input.queueRoot, "hosts", `${host.name}.probe`));
    if (!cachedProbe) {
      missingTokens += ` host=${host.name} tool=unprobed`;
      continue;
    }
    if (allowedArches.size > 0) {
      const arch = normalizeArch(cachedProbe.__arch ?? "");
      if (!arch || !allowedArches.has(arch)) {
        missingTokens += ` host=${host.name} arch=${arch || "unknown"}`;
        archMiss = true;
        continue;
      }
    }
    const lacks = computeHostLacks(input.manifest, cachedProbe, "base", input.requiredTools);
    if (lacks.length > 0) {
      missingTokens += ` host=${host.name} tool=${lacks[0]!.split(" ", 1)[0]}`;
      toolMiss = true;
      continue;
    }
    fitOff.push(host.name);
  }

  const allOff = fitOff.length > 0;
  const reason = allOff
    ? `ci_hosts_off hosts=${fitOff.join(",")}`
    : !toolMiss && archMiss
      ? `ci_host_wrong_arch${missingTokens}`
      : `ci_host_missing_tool${missingTokens}`;

  return { qualified: [], localOk: false, offCandidates: fitOff, allOff, reason, lacksByHost };
}

/** Routes a CI job end-to-end using in-memory fleet telemetry, settle window, and route leases. */
export function routeCiJob(input: {
  readonly queueRoot: string;
  readonly manifest: CiHostsManifest;
  readonly telemetry: FleetTelemetryProvider;
  readonly probesByHost: Readonly<Record<string, Readonly<Record<string, string>> | null>>;
  readonly requiredTools: ReadonlyArray<string>;
  readonly requiredArch?: ReadonlyArray<string> | undefined;
  readonly activeLeases: ReadonlyArray<ActiveRouteLease>;
  readonly nowEpochSec: number;
  readonly settleWindowS?: number | undefined;
  readonly localOnly?: boolean | undefined;
  readonly recordSelection?: boolean | undefined;
}):
  | { readonly kind: "routed"; readonly target: SelectedRouteTarget }
  | { readonly kind: "park_off"; readonly hosts: ReadonlyArray<string>; readonly reason: string }
  | {
      readonly kind: "unqualified";
      readonly reason: string;
      readonly lacksByHost: Readonly<Record<string, ReadonlyArray<string>>>;
    }
  | { readonly kind: "on_battery"; readonly hosts: ReadonlyArray<string>; readonly reason: string }
  | {
      readonly kind: "unreachable";
      readonly hosts: ReadonlyArray<string>;
      readonly reason: string;
    } {
  const qual = qualifyCiHosts({
    queueRoot: input.queueRoot,
    manifest: input.manifest,
    probesByHost: input.probesByHost,
    requiredTools: input.requiredTools,
    requiredArch: input.requiredArch,
    localOnly: input.localOnly,
  });
  if (qual.qualified.length === 0) {
    if (qual.allOff) {
      return { kind: "park_off", hosts: qual.offCandidates, reason: qual.reason };
    }
    return { kind: "unqualified", reason: qual.reason, lacksByHost: qual.lacksByHost };
  }

  const settleS = input.settleWindowS ?? DEFAULT_ROUTE_SETTLE_S;
  const loads = readInMemoryNodeLoads({
    manifest: input.manifest,
    telemetry: input.telemetry,
    hostNames: qual.qualified.map((h) => h.name),
    nowEpochSec: input.nowEpochSec,
  });

  const candidates: RouteCandidateInput[] = [];
  for (const host of qual.qualified) {
    const reading = loads.get(host.name);
    if (!reading) continue;
    const cutoff = reading.sampledAtSec - settleS;
    const active = countYoungActiveRoutes(input.activeLeases, host.name, cutoff);
    candidates.push({
      name: host.name,
      kind: host.ssh === null ? "local" : "remote",
      busy: reading.busy,
      cores: reading.cores,
      active,
      limit: computeHostRoomLimit(reading.cores),
    });
  }

  const picked = selectRouteTarget({
    manifest: input.manifest,
    queueRoot: input.queueRoot,
    candidates,
  });
  if (picked.kind === "none") {
    if (picked.onBattery.length > 0) {
      return {
        kind: "on_battery",
        hosts: picked.onBattery,
        reason: `ci_host_on_battery hosts=${picked.onBattery.join(",")}`,
      };
    }
    const qualifiedNames = qual.qualified.map((h) => h.name);
    return {
      kind: "unreachable",
      hosts: qualifiedNames,
      reason: `ci_host_unreachable hosts=${qualifiedNames.join(",")}`,
    };
  }

  if (input.recordSelection !== false) {
    recordLastAssigned(input.queueRoot, picked.target.host);
  }
  return { kind: "routed", target: picked.target };
}

/** Whether a job parked for `ci-host-off` can unpark now (at least one parked host is back on or no longer declared). */
export function isParkedJobReady(
  queueRoot: string,
  manifest: CiHostsManifest,
  park: JobParkRecord,
): boolean {
  const declared = new Set(manifest.hosts.map((h) => h.name));
  return park.hosts.some((h) => !declared.has(h) || !isHostOff(queueRoot, h));
}
