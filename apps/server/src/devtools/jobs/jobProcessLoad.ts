import type { DevtoolsJobLoad } from "@t3tools/contracts";

import { isTerminalJobState, type JobSummary } from "./types.ts";

const CPU_PUBLISH_STEP_PCT = 5;
const MEM_PUBLISH_STEP_BYTES = 64 * 1024 * 1024;
const MEM_PUBLISH_STEP_RATIO = 0.1;
// The Fleet background scan runs every 30 s; past three missed scans a load is no longer live.
const LOAD_STALE_AFTER_MS = 90_000;

export interface ProcessTableRow {
  readonly pid: number;
  readonly ppid: number;
  readonly cpuPct: number;
  readonly memBytes: number;
}

export interface ProcessTreeIndex {
  readonly byPid: ReadonlyMap<number, ProcessTableRow>;
  readonly childrenByPpid: ReadonlyMap<number, ReadonlyArray<number>>;
}

export function indexProcessTable(rows: ReadonlyArray<ProcessTableRow>): ProcessTreeIndex {
  const byPid = new Map<number, ProcessTableRow>();
  const childrenByPpid = new Map<number, number[]>();
  for (const row of rows) {
    byPid.set(row.pid, row);
    const siblings = childrenByPpid.get(row.ppid);
    if (siblings) siblings.push(row.pid);
    else childrenByPpid.set(row.ppid, [row.pid]);
  }
  return { byPid, childrenByPpid };
}

/** Sums the root PID and every descendant; undefined when the root is not in the table. */
export function aggregateProcessTree(
  index: ProcessTreeIndex,
  rootPid: number,
): DevtoolsJobLoad | undefined {
  if (!index.byPid.has(rootPid)) return undefined;
  let cpu = 0;
  let memBytes = 0;
  let processCount = 0;
  const seen = new Set<number>();
  const stack = [rootPid];
  while (stack.length > 0) {
    const pid = stack.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    const row = index.byPid.get(pid);
    if (!row) continue;
    cpu += row.cpuPct;
    memBytes += row.memBytes;
    processCount += 1;
    for (const child of index.childrenByPpid.get(pid) ?? []) stack.push(child);
  }
  return { cpuPct: Math.max(0, Math.round(cpu)), memBytes, processCount };
}

/**
 * Hysteresis against the last published value, so a load that hovers near a bucket edge
 * does not send a frame on every scan.
 */
export function shouldPublishJobLoad(
  published: DevtoolsJobLoad | undefined,
  next: DevtoolsJobLoad,
): boolean {
  if (!published) return true;
  if (Math.abs(next.cpuPct - published.cpuPct) >= CPU_PUBLISH_STEP_PCT) return true;
  const memStep = Math.max(MEM_PUBLISH_STEP_BYTES, published.memBytes * MEM_PUBLISH_STEP_RATIO);
  return Math.abs(next.memBytes - published.memBytes) >= memStep;
}

export interface JobLoadTarget {
  readonly id: string;
  readonly rootPid: number;
}

/** Live local jobs with a known root PID: visible cerno jobs, and background jobs matched to one. */
export function collectJobLoadTargets(input: {
  readonly localHostname: string;
  readonly cernoSummaries: ReadonlyArray<JobSummary>;
  readonly backgroundSummaries: ReadonlyArray<JobSummary>;
  readonly rootPidForBackgroundJob: (id: string) => number | undefined;
}): ReadonlyArray<JobLoadTarget> {
  const isLiveLocal = (s: JobSummary) =>
    !isTerminalJobState(s.state) && s.binding.host === input.localHostname;
  const out: JobLoadTarget[] = [];
  for (const s of input.cernoSummaries) {
    if (isLiveLocal(s) && s.pidStats?.alive) out.push({ id: s.id, rootPid: s.pidStats.pid });
  }
  for (const s of input.backgroundSummaries) {
    if (!isLiveLocal(s)) continue;
    const rootPid = s.pidStats?.alive ? s.pidStats.pid : input.rootPidForBackgroundJob(s.id);
    if (rootPid !== undefined) out.push({ id: s.id, rootPid });
  }
  return out;
}

/** Holds the last published load per job and attaches it to summaries on read. */
export class JobProcessLoadTracker {
  private published = new Map<string, DevtoolsJobLoad>();
  private sampledAtMs: number | null = null;
  private readonly nowMs: () => number;

  constructor(nowMs: () => number) {
    this.nowMs = nowMs;
  }

  /** Returns the IDs whose wire-visible load changed and need a delta frame. */
  apply(
    rows: ReadonlyArray<ProcessTableRow>,
    targets: ReadonlyArray<JobLoadTarget>,
  ): ReadonlyArray<string> {
    const index = indexProcessTable(rows);
    const next = new Map<string, DevtoolsJobLoad>();
    const changed: string[] = [];
    for (const target of targets) {
      const load = aggregateProcessTree(index, target.rootPid);
      if (!load) continue;
      const prev = this.published.get(target.id);
      if (shouldPublishJobLoad(prev, load)) {
        next.set(target.id, load);
        changed.push(target.id);
      } else if (prev) {
        next.set(target.id, prev);
      }
    }
    for (const id of this.published.keys()) {
      if (!next.has(id)) changed.push(id);
    }
    this.published = next;
    this.sampledAtMs = this.nowMs();
    return changed;
  }

  attach(summary: JobSummary): JobSummary {
    if (this.sampledAtMs === null || this.nowMs() - this.sampledAtMs > LOAD_STALE_AFTER_MS) {
      return summary;
    }
    if (isTerminalJobState(summary.state)) return summary;
    const load = this.published.get(summary.id);
    return load ? { ...summary, load } : summary;
  }
}
