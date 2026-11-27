import type { FleetServerItem, FleetSessionItem } from "./FleetTypes.ts";

/** Most sessions a peer or remote probe may report for one host. */
export const MAX_REMOTE_SESSIONS = 40;
const MAX_LABEL_LEN = 64;
const REMOTE_CLOSE_BLOCKED_REASON = "Close remote processes from their own host";

/** The server fields a peer link may see: no PIDs, command lines, paths, or images. */
export function redactPeerServerItem(srv: FleetServerItem): FleetServerItem {
  return {
    id: srv.id,
    ...(srv.project ? { project: srv.project } : {}),
    ...(srv.service ? { service: srv.service } : {}),
    kind: srv.kind,
    ...(srv.port !== undefined ? { port: srv.port } : {}),
    ...(srv.ports ? { ports: srv.ports } : {}),
    state: srv.state,
    ...(srv.cpu_pct !== undefined ? { cpu_pct: srv.cpu_pct } : {}),
    ...(srv.mem_bytes !== undefined ? { mem_bytes: srv.mem_bytes } : {}),
    ...(srv.uptime_s !== undefined ? { uptime_s: srv.uptime_s } : {}),
  };
}

/** A short display label: printable characters only, bounded length. */
function safeLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  // C0, DEL, and C1 control characters.
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .trim()
    .slice(0, MAX_LABEL_LEN)
    .trim();
  return cleaned || undefined;
}

/** A finite, non-negative number no larger than `max`, or undefined. */
function boundedNumber(value: unknown, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return Math.min(value, max);
}

/** Per-process CPU can pass 100% on a multi-core host; no real host reaches this ceiling. */
const MAX_CPU_PCT = 100_000;

/**
 * Rebuilds one session from known primitives for a peer link or a remote host.
 * It drops the PID, command line, working directory, and any unknown field, and a
 * viewer can never close it: the process belongs to another host.
 */
function toRemoteSession(raw: unknown, index: number): FleetSessionItem | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const name = safeLabel(rec.name);
  if (!name) return null;
  const kind = safeLabel(rec.kind) ?? "process";
  const project = safeLabel(rec.project);
  const managed = safeLabel(rec.managed);
  const ageS = boundedNumber(rec.age_s, Number.MAX_SAFE_INTEGER);
  const memBytes = boundedNumber(rec.mem_bytes, Number.MAX_SAFE_INTEGER);
  const cpuPct = boundedNumber(rec.cpu_pct, MAX_CPU_PCT);
  return {
    id: `remote:${index}:${name}`,
    kind,
    name,
    ...(project ? { project } : {}),
    ...(managed ? { managed } : {}),
    ...(ageS !== undefined ? { age_s: Math.floor(ageS) } : {}),
    ...(memBytes !== undefined ? { mem_bytes: Math.floor(memBytes) } : {}),
    ...(cpuPct !== undefined ? { cpu_pct: Math.round(cpuPct * 10) / 10 } : {}),
    ...(rec.high === true ? { high: true } : {}),
    ...(rec.runaway === true ? { runaway: true } : {}),
    ...(rec.orphaned === true ? { orphaned: true } : {}),
    close_allowed: false,
    close_blocked_reason: REMOTE_CLOSE_BLOCKED_REASON,
  };
}

/** Sanitizes an untrusted session list (peer JSON or a parsed SSH probe), bounded in size. */
export function sanitizeRemoteSessions(raw: unknown): ReadonlyArray<FleetSessionItem> {
  if (!Array.isArray(raw)) return [];
  const out: FleetSessionItem[] = [];
  for (const item of raw) {
    if (out.length >= MAX_REMOTE_SESSIONS) break;
    const session = toRemoteSession(item, out.length);
    if (session) out.push(session);
  }
  return out;
}

/** The session fields a peer link may see; the same rules as an inbound remote session. */
export function redactPeerSessions(
  sessions: ReadonlyArray<FleetSessionItem>,
): ReadonlyArray<FleetSessionItem> {
  return sanitizeRemoteSessions(sessions);
}
