// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off globalFetch:off - Multi-host fleet prober: T3 PeerLinks first (zero SSH), standard-Unix SSH fallback for unlinked CI hosts.
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";

import {
  NODE_HIST_LEN,
  type CiHostManifestEntry,
  type FleetDiskInfo,
  type FleetGpuInfo,
  type FleetHostTelemetry,
  type FleetNodeState,
  type FleetServerItem,
} from "./FleetTypes.ts";
import { sanitizeRemoteSessions } from "./FleetPeerWire.ts";
import { parseRemoteProbeOutput, REMOTE_PROBE_SCRIPT } from "./RemoteProbeParser.ts";

const PEER_FETCH_TIMEOUT_MS = 4_000;
const SSH_PROBE_TIMEOUT_MS = 12_000;
const ROUTE_HIST_INTERVAL_MS = 25_000;
const SAFE_SSH_ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/;

export interface PeerLinkCandidate {
  readonly environmentId: string;
  readonly label: string;
  readonly resolve: () => Promise<{ readonly url: string; readonly token: string } | null>;
}

export interface RemoteNodeProberDeps {
  readonly listPeerLinks?: (() => Promise<ReadonlyArray<PeerLinkCandidate>>) | undefined;
  readonly fetchJson?:
    | ((url: string, token: string, timeoutMs: number) => Promise<unknown | null>)
    | undefined;
  readonly runSshProbe?: ((sshAlias: string, script: string) => Promise<string | null>) | undefined;
  readonly localUsername?: string | undefined;
}

function defaultLocalUsername(): string {
  try {
    return NodeOS.userInfo().username;
  } catch {
    return "";
  }
}

// Installers commonly name a machine `<user>-<model>`, while peer labels often omit the user.
function normalizeToken(raw: string, userPrefix: string): string {
  const lower = raw.trim().toLowerCase();
  return (userPrefix && lower.startsWith(userPrefix) ? lower.slice(userPrefix.length) : lower)
    .replace(/\.local$/, "")
    .replace(/(?:[\s_-]+wsl)+$/, "")
    .replace(/[^a-z0-9]+/g, "");
}

function finiteNum(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function numArray(value: unknown): ReadonlyArray<number> {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
}

/**
 * Strictly validates and reconstructs a peer's `/api/devtools/fleet/self` response from
 * known primitives only so a malformed peer payload can never throw or inject unknown fields.
 */
export function sanitizePeerNodeState(
  raw: unknown,
  entry: { readonly name: string; readonly ssh: string; readonly note?: string | undefined },
): FleetNodeState | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  if (!rec.host || typeof rec.host !== "object" || Array.isArray(rec.host)) return null;
  const h = rec.host as Record<string, unknown>;
  const cpus = finiteNum(h.cpus);
  if (typeof h.name !== "string" || !h.name.trim() || cpus === undefined || cpus <= 0) {
    return null;
  }

  const memRec = h.mem && typeof h.mem === "object" ? (h.mem as Record<string, unknown>) : null;
  const mem = {
    used: Math.max(0, finiteNum(memRec?.used) ?? 0),
    total: Math.max(0, finiteNum(memRec?.total) ?? 0),
  };

  const disks: FleetDiskInfo[] = [];
  if (Array.isArray(h.disks)) {
    for (const d of h.disks) {
      if (!d || typeof d !== "object") continue;
      const dr = d as Record<string, unknown>;
      const total = finiteNum(dr.total);
      const used = finiteNum(dr.used);
      if (typeof dr.mount !== "string" || total === undefined || total <= 0) continue;
      disks.push({
        mount: dr.mount,
        label: typeof dr.label === "string" && dr.label ? dr.label : dr.mount,
        used: Math.max(0, used ?? 0),
        total,
      });
    }
  }

  let gpu: FleetGpuInfo | undefined;
  if (h.gpu && typeof h.gpu === "object" && !Array.isArray(h.gpu)) {
    const gr = h.gpu as Record<string, unknown>;
    const busyPct = finiteNum(gr.busy_pct);
    const vramUsed = Math.max(0, finiteNum(gr.vram_used) ?? 0);
    const vramTotal = Math.max(0, finiteNum(gr.vram_total) ?? 0);
    const busyHist = numArray(gr.busy_hist);
    if (busyPct !== undefined || vramTotal > 0) {
      gpu = {
        ...(busyPct !== undefined ? { busy_pct: busyPct } : {}),
        ...(busyHist.length > 0 ? { busy_hist: busyHist } : {}),
        vram_used: vramUsed,
        vram_total: vramTotal,
      };
    }
  }

  const servers: FleetServerItem[] = [];
  if (Array.isArray(rec.servers)) {
    for (const s of rec.servers) {
      if (!s || typeof s !== "object") continue;
      const sr = s as Record<string, unknown>;
      if (typeof sr.id !== "string" || !sr.id) continue;
      const port = finiteNum(sr.port);
      const cpuPct = finiteNum(sr.cpu_pct);
      const memBytes = finiteNum(sr.mem_bytes);
      const uptimeS = finiteNum(sr.uptime_s);
      servers.push({
        id: sr.id,
        ...(typeof sr.project === "string" ? { project: sr.project } : {}),
        ...(typeof sr.service === "string" ? { service: sr.service } : {}),
        kind: typeof sr.kind === "string" ? sr.kind : "container",
        state: typeof sr.state === "string" ? sr.state : "up",
        ...(port !== undefined ? { port } : {}),
        ...(cpuPct !== undefined ? { cpu_pct: cpuPct } : {}),
        ...(memBytes !== undefined ? { mem_bytes: memBytes } : {}),
        ...(uptimeS !== undefined ? { uptime_s: uptimeS } : {}),
      });
    }
  }

  const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const ts = typeof h.ts === "string" && h.ts.length >= 19 ? h.ts : nowIso;
  const load1 = finiteNum(h.load1);
  const cpuPct = finiteNum(h.cpu_pct);
  const host: FleetHostTelemetry = {
    name: entry.name,
    uptime_s: Math.max(0, Math.floor(finiteNum(h.uptime_s) ?? 0)),
    ...(load1 !== undefined ? { load1 } : {}),
    cpus: Math.max(1, Math.floor(cpus)),
    ...(cpuPct !== undefined ? { cpu_pct: cpuPct } : {}),
    cpu_hist: numArray(h.cpu_hist),
    mem,
    disks,
    ...(gpu ? { gpu } : {}),
    ts,
  };

  const power = rec.power === "ac" || rec.power === "battery" ? rec.power : undefined;
  return {
    host,
    servers,
    sessions: sanitizeRemoteSessions(rec.sessions),
    status: "up",
    is_local: false,
    ssh: entry.ssh,
    ...(entry.note ? { note: entry.note } : {}),
    ...(power ? { power } : {}),
    ...(rec.power_saver === true ? { power_saver: true } : {}),
    updated_at: ts,
  };
}

async function defaultFetchJson(
  url: string,
  token: string,
  timeoutMs: number,
): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
      },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function defaultRunSshProbe(sshAlias: string, script: string): Promise<string | null> {
  if (!SAFE_SSH_ALIAS_RE.test(sshAlias)) return Promise.resolve(null);
  return new Promise((resolve) => {
    NodeChildProcess.execFile(
      "ssh",
      [
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=5",
        "-o",
        "ServerAliveInterval=5",
        "-o",
        "ServerAliveCountMax=1",
        "-T",
        "--",
        sshAlias,
        script,
      ],
      { timeout: SSH_PROBE_TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024 },
      (err, stdout) => {
        if (stdout && stdout.includes("---OS---")) {
          resolve(stdout);
          return;
        }
        resolve(err ? null : stdout || null);
      },
    );
  });
}

export class RemoteNodeProber {
  private readonly listPeerLinks: (() => Promise<ReadonlyArray<PeerLinkCandidate>>) | undefined;
  private readonly fetchJson: (
    url: string,
    token: string,
    timeoutMs: number,
  ) => Promise<unknown | null>;
  private readonly runSshProbe: (sshAlias: string, script: string) => Promise<string | null>;
  private readonly hostUserPrefix: string;

  private readonly cpuHistByHost = new Map<string, number[]>();
  private readonly routeCpuHistByHost = new Map<
    string,
    { readonly hist: number[]; lastAt: number }
  >();
  private readonly gpuHistByHost = new Map<string, number[]>();
  private readonly lastNodeByHost = new Map<string, FleetNodeState>();
  private readonly inflightByHost = new Map<string, Promise<FleetNodeState>>();

  constructor(deps: RemoteNodeProberDeps = {}) {
    this.listPeerLinks = deps.listPeerLinks;
    this.fetchJson = deps.fetchJson ?? defaultFetchJson;
    this.runSshProbe = deps.runSshProbe ?? defaultRunSshProbe;
    const username = (deps.localUsername ?? defaultLocalUsername()).trim().toLowerCase();
    this.hostUserPrefix = username ? `${username}-` : "";
  }

  getCachedNodes(forRouting = false): Readonly<Record<string, FleetNodeState>> {
    const out: Record<string, FleetNodeState> = {};
    for (const [name, state] of this.lastNodeByHost) {
      if (forRouting) {
        const routeEntry = this.routeCpuHistByHost.get(name);
        const routeHist =
          routeEntry && routeEntry.hist.length > 0
            ? [...routeEntry.hist]
            : state.host.cpu_pct !== undefined
              ? [state.host.cpu_pct]
              : [];
        out[name] = { ...state, host: { ...state.host, cpu_hist: routeHist } };
      } else {
        out[name] = state;
      }
    }
    return out;
  }

  private mergeHistory(hostName: string, state: FleetNodeState): FleetNodeState {
    let cpuHist = this.cpuHistByHost.get(hostName) ?? [];
    if (state.host.cpu_hist.length > 1) {
      cpuHist = [...state.host.cpu_hist].slice(-NODE_HIST_LEN);
    } else if (typeof state.host.cpu_pct === "number") {
      cpuHist = [...cpuHist, state.host.cpu_pct].slice(-NODE_HIST_LEN);
    }
    this.cpuHistByHost.set(hostName, cpuHist);

    // Maintain a strict ~30s-cadence history for ship-queue routing so 5s UI kicks never compress the 5m window.
    if (typeof state.host.cpu_pct === "number") {
      const nowMs = Date.now();
      const prev = this.routeCpuHistByHost.get(hostName);
      if (!prev || prev.hist.length === 0 || nowMs - prev.lastAt >= ROUTE_HIST_INTERVAL_MS) {
        const nextHist = [...(prev?.hist ?? []), state.host.cpu_pct].slice(-NODE_HIST_LEN);
        this.routeCpuHistByHost.set(hostName, { hist: nextHist, lastAt: nowMs });
      }
    }

    let gpu = state.host.gpu;
    if (gpu) {
      let gpuHist = this.gpuHistByHost.get(hostName) ?? [];
      if (gpu.busy_hist && gpu.busy_hist.length > 1) {
        gpuHist = [...gpu.busy_hist].slice(-NODE_HIST_LEN);
      } else if (typeof gpu.busy_pct === "number") {
        gpuHist = [...gpuHist, gpu.busy_pct].slice(-NODE_HIST_LEN);
      }
      this.gpuHistByHost.set(hostName, gpuHist);
      gpu = {
        ...gpu,
        ...(gpuHist.length > 0 ? { busy_hist: gpuHist } : {}),
      };
    }

    return {
      ...state,
      host: {
        ...state.host,
        name: hostName,
        cpu_hist: cpuHist,
        ...(gpu ? { gpu } : {}),
      },
    };
  }

  private async tryPeerProbe(
    entry: { readonly name: string; readonly ssh: string; readonly note?: string | undefined },
    peers: ReadonlyArray<PeerLinkCandidate>,
  ): Promise<FleetNodeState | null> {
    const normalize = (raw: string) => normalizeToken(raw, this.hostUserPrefix);
    const wantedTokens = new Set([entry.name, entry.ssh].map(normalize).filter(Boolean));
    const matched = peers.find((p) => {
      const lbl = normalize(p.label);
      return lbl && wantedTokens.has(lbl);
    });
    if (!matched) return null;
    try {
      const resolved = await matched.resolve();
      if (!resolved) return null;
      const url = `${resolved.url.replace(/\/$/, "")}/api/devtools/fleet/self`;
      const payload = await this.fetchJson(url, resolved.token, PEER_FETCH_TIMEOUT_MS);
      return sanitizePeerNodeState(payload, entry);
    } catch {
      return null;
    }
  }

  async probeTarget(
    entry: { readonly name: string; readonly ssh: string; readonly note?: string | undefined },
    peers?: ReadonlyArray<PeerLinkCandidate>,
  ): Promise<FleetNodeState> {
    const existing = this.inflightByHost.get(entry.name);
    if (existing) return existing;

    const promise = (async (): Promise<FleetNodeState> => {
      try {
        const peerList =
          peers ?? (this.listPeerLinks ? await this.listPeerLinks().catch(() => []) : []);
        const fromPeer = await this.tryPeerProbe(entry, peerList);
        if (fromPeer) {
          const merged = this.mergeHistory(entry.name, fromPeer);
          this.lastNodeByHost.set(entry.name, merged);
          return merged;
        }

        const sshOut = await this.runSshProbe(entry.ssh, REMOTE_PROBE_SCRIPT);
        if (sshOut) {
          const parsed = parseRemoteProbeOutput(entry.name, sshOut, entry.ssh, entry.note);
          const merged = this.mergeHistory(entry.name, parsed);
          this.lastNodeByHost.set(entry.name, merged);
          return merged;
        }
      } catch {
        // fall through to offline state
      }

      const prev = this.lastNodeByHost.get(entry.name);
      const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
      const offline: FleetNodeState = {
        host: prev?.host ?? {
          name: entry.name,
          uptime_s: 0,
          cpus: 1,
          cpu_hist: this.cpuHistByHost.get(entry.name) ?? [],
          mem: { used: 0, total: 0 },
          disks: [],
          ts: nowIso,
        },
        servers: prev?.servers ?? [],
        sessions: [],
        status: "offline",
        is_local: false,
        ssh: entry.ssh,
        ...(entry.note ? { note: entry.note } : {}),
        error: `Unreachable via T3 peer link and SSH (${entry.ssh})`,
        updated_at: nowIso,
      };
      this.lastNodeByHost.set(entry.name, offline);
      return offline;
    })().finally(() => {
      this.inflightByHost.delete(entry.name);
    });

    this.inflightByHost.set(entry.name, promise);
    return promise;
  }

  async probeManifest(
    manifest: ReadonlyArray<CiHostManifestEntry>,
    localHostName: string,
  ): Promise<Readonly<Record<string, FleetNodeState>>> {
    const targets: Array<{
      readonly name: string;
      readonly ssh: string;
      readonly note?: string | undefined;
    }> = [];
    const seen = new Set<string>([localHostName]);

    for (const h of manifest) {
      if (h.ssh && !seen.has(h.name)) {
        seen.add(h.name);
        targets.push({ name: h.name, ssh: h.ssh, note: h.note });
      }
      if (h.on && !seen.has(h.on)) {
        seen.add(h.on);
        targets.push({ name: h.on, ssh: h.on });
      }
    }

    const peers = this.listPeerLinks ? await this.listPeerLinks().catch(() => []) : [];
    await Promise.all(targets.map((t) => this.probeTarget(t, peers).catch(() => undefined)));
    return this.getCachedNodes();
  }
}
