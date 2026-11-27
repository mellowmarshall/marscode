// @effect-diagnostics nodeBuiltinImport:off - Bounded hot-process section of the standard-Unix SSH fleet probe.
import * as NodePath from "node:path";

import { sanitizeRemoteSessions } from "./FleetPeerWire.ts";
import type { FleetSessionItem } from "./FleetTypes.ts";
import { parsePsOutput } from "./NativeSessionsScanner.ts";

const HIGH_CPU_PCT = 15;
const RUNAWAY_CPU_PCT = 80;
const HIGH_MEM_BYTES = 256 * 1024 * 1024;
const MAX_REMOTE_PROCS = 20;
/** The probe's own pipeline (incl. macOS `top` CPU sample) and the SSH session that carries it. */
const PROBE_SELF_RE = /^(?:ps|sort|head|top|sshd|sshd-session)$/;

/**
 * Shell fragment for `REMOTE_PROBE_SCRIPT`. It prints the busiest processes by CPU and
 * by resident memory, at most 50 lines. It asks `ps` for `comm` (the executable name)
 * and never for `args`, so no command line, token, or flag value leaves the host.
 * `-ww` stops macOS `ps` from cutting `comm` to the width of a terminal it does not have.
 */
export const REMOTE_PROCS_PROBE = `echo "---PROCS---"
ps_out=$(LC_ALL=C ps -A -ww -o pid=,ppid=,pcpu=,rss=,etime=,stat=,comm= 2>/dev/null || true)
if [ -n "$ps_out" ]; then
  printf '%s\\n' "$ps_out" | LC_ALL=C sort -k3,3 -nr 2>/dev/null | head -n 30
  printf '%s\\n' "$ps_out" | LC_ALL=C sort -k4,4 -nr 2>/dev/null | head -n 20
fi
`;

/** Parses the `---PROCS---` section into view-only, sanitized remote sessions. */
export function parseRemoteProcs(text: string): ReadonlyArray<FleetSessionItem> {
  const seen = new Set<number>();
  const hot: Array<Record<string, unknown>> = [];
  const procs = parsePsOutput(text).toSorted(
    (a, b) => b.cpuPct - a.cpuPct || b.memBytes - a.memBytes,
  );
  for (const p of procs) {
    if (seen.has(p.pid)) continue;
    seen.add(p.pid);
    // `comm` is the last column, so the whole remainder is the name (macOS paths hold spaces).
    const name = NodePath.posix.basename(p.args.trim());
    if (!name || PROBE_SELF_RE.test(name)) continue;
    const high = p.cpuPct >= HIGH_CPU_PCT || p.memBytes >= HIGH_MEM_BYTES;
    if (!high) continue;
    hot.push({
      kind: "process",
      name,
      age_s: p.ageSeconds,
      mem_bytes: p.memBytes,
      cpu_pct: p.cpuPct,
      high: true,
      runaway: p.cpuPct >= RUNAWAY_CPU_PCT && p.ageSeconds >= 60,
      orphaned: p.ppid === 1 && p.cpuPct >= HIGH_CPU_PCT,
    });
    if (hot.length >= MAX_REMOTE_PROCS) break;
  }
  return sanitizeRemoteSessions(hot);
}
