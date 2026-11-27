// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Builds this host's fleet node state for the console, ship-queue routing, and peer links.
import * as NodeOS from "node:os";

import { redactPeerServerItem, redactPeerSessions } from "./FleetPeerWire.ts";
import type {
  FleetHostTelemetry,
  FleetNodeState,
  FleetServerItem,
  FleetSessionItem,
} from "./FleetTypes.ts";
import type { NativeHostSampler } from "./NativeHostSampler.ts";

export interface SelfNodeOptions {
  readonly includeSessions?: boolean;
  /** Strips PIDs, command lines, and paths for a peer link (`/api/devtools/fleet/self`). */
  readonly redactPeer?: boolean;
  readonly forRouting?: boolean;
}

export interface SelfNodeSources {
  readonly hostname: string;
  readonly hostSampler: NativeHostSampler;
  readonly servers: ReadonlyArray<FleetServerItem>;
  readonly sessions: ReadonlyArray<FleetSessionItem>;
}

/** The latest sampled host telemetry, or a coarse `node:os` reading before the first sample. */
export function buildLocalHostTelemetry(
  hostname: string,
  hostSampler: NativeHostSampler,
  forRouting = false,
): FleetHostTelemetry {
  const latest = hostSampler.getLatest();
  if (latest) {
    return forRouting ? { ...latest.host, cpu_hist: hostSampler.getRouteCpuHist() } : latest.host;
  }
  return {
    name: hostname,
    uptime_s: Math.max(0, Math.floor(NodeOS.uptime())),
    cpus: Math.max(1, NodeOS.cpus().length),
    cpu_hist: [],
    mem: {
      used: Math.max(0, NodeOS.totalmem() - NodeOS.freemem()),
      total: NodeOS.totalmem(),
    },
    disks: [],
    ts: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  };
}

export function buildSelfNodeState(
  sources: SelfNodeSources,
  options?: SelfNodeOptions,
): FleetNodeState {
  const latest = sources.hostSampler.getLatest();
  const host = buildLocalHostTelemetry(
    sources.hostname,
    sources.hostSampler,
    options?.forRouting ?? false,
  );
  const redact = options?.redactPeer ?? false;
  const servers = redact ? sources.servers.map(redactPeerServerItem) : sources.servers;
  const sessions = redact ? redactPeerSessions(sources.sessions) : sources.sessions;
  return {
    host,
    servers,
    ...(options?.includeSessions ? { sessions } : {}),
    status: "up",
    is_local: true,
    ...(latest?.power.power ? { power: latest.power.power } : {}),
    ...(latest?.power.powerSaver ? { power_saver: true } : {}),
    updated_at: host.ts,
  };
}
