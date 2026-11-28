// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - Stateful OS-grounded bridge for live cerno watch/tail processes via runtime sidecar snapshots.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { CernoJobMatchCandidate } from "./cernoJobMatcher.ts";
import {
  buildCernoDetail,
  buildCernoSummary,
  finalizeCernoRecord,
  upsertCernoRecord,
  type CernoJobRecord,
} from "./cernoJobProjection.ts";
import {
  defaultCernoSnapshotDirs,
  defaultIsPidAlive,
  isCernoProcessPid,
  isSafeCernoSnapshotDir,
  readCernoSnapshotFile,
  readProcRssBytes,
  readProcStartTicks,
  reconstructFullCernoCommand,
  resolveCanonicalLogPath,
  resolveCernoTailLines,
  resolveThreadIdForPid,
} from "./cernoSnapshotReader.ts";
import { classifyCommandTracking } from "./commandJobParser.ts";
import { loadFleetHosts } from "./fleetHostInference.ts";
import { isTerminalJobState, type JobDetail, type JobSummary } from "./types.ts";

export { cernoMatchesBackgroundJob, type CernoJobMatchCandidate } from "./cernoJobMatcher.ts";

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_CANCEL_TIMEOUT_MS = 15_000;
const MAX_SCAN_ENTRIES = 512;
const MAX_SNAPSHOT_FILES = 64;
const MAX_COMPLETED_JOBS = 20;
const STALE_NO_TICKS_MS = 60_000;

export interface CernoProcessBridgeOptions {
  readonly localHostname?: string | undefined;
  readonly ciHostsPath?: string | null | undefined;
  readonly pollIntervalMs?: number | undefined;
  readonly cancelTimeoutMs?: number | undefined;
  readonly snapshotDirs?: ReadonlyArray<string> | undefined;
  readonly expectedUid?: number | null | undefined;
  readonly platform?: NodeJS.Platform | undefined;
  readonly nowMs?: (() => number) | undefined;
  readonly isPidAlive?: ((pid: number) => boolean) | undefined;
  readonly readProcStartTicks?: ((pid: number) => Promise<number | null>) | undefined;
  readonly readProcRssBytes?: ((pid: number) => Promise<number | undefined>) | undefined;
  readonly isCernoProcess?: ((pid: number) => Promise<boolean>) | undefined;
  readonly resolveThreadId?: ((pid: number) => Promise<string | undefined>) | undefined;
  readonly isWorkspaceAllowed?: ((realPath: string) => Promise<boolean>) | undefined;
  readonly killPid?: ((pid: number, signal: NodeJS.Signals) => void) | undefined;
  readonly hasShipJobId?: ((jobId: string) => boolean) | undefined;
  readonly onChanged?:
    | ((changedIds: ReadonlyArray<string>, removedIds: ReadonlyArray<string>) => void)
    | undefined;
}

export class CernoProcessBridge {
  private readonly localHostname: string;
  private readonly ciHostsPath: string | null | undefined;
  private readonly pollIntervalMs: number;
  private readonly cancelTimeoutMs: number;
  private readonly snapshotDirs: ReadonlyArray<string>;
  private readonly expectedUid: number | null;
  private readonly platform: NodeJS.Platform;
  private readonly nowMs: () => number;
  private readonly isPidAlive: (pid: number) => boolean;
  private readonly readProcStartTicksFn: (pid: number) => Promise<number | null>;
  private readonly readProcRssBytesFn: (pid: number) => Promise<number | undefined>;
  private readonly isCernoProcessFn: (pid: number) => Promise<boolean>;
  private readonly resolveThreadIdFn: (pid: number) => Promise<string | undefined>;
  private readonly isWorkspaceAllowed: (realPath: string) => Promise<boolean>;
  private readonly killPid: (pid: number, signal: NodeJS.Signals) => void;
  private readonly hasShipJobId?: ((jobId: string) => boolean) | undefined;
  private readonly onChanged?:
    | ((changedIds: ReadonlyArray<string>, removedIds: ReadonlyArray<string>) => void)
    | undefined;

  private readonly jobs = new Map<string, CernoJobRecord>();
  private readonly threadIdCache = new Map<string, string | null>();
  private observedTicks: ReadonlyMap<number, number | null> = new Map();
  private timer: ReturnType<typeof setInterval> | null = null;
  private inflightRefresh: Promise<void> | null = null;
  private lastRefreshAtMs = 0;
  private disposed = false;

  constructor(options: CernoProcessBridgeOptions = {}) {
    this.platform = options.platform ?? "linux";
    this.localHostname = options.localHostname ?? NodeOS.hostname();
    this.ciHostsPath = options.ciHostsPath;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.cancelTimeoutMs = options.cancelTimeoutMs ?? DEFAULT_CANCEL_TIMEOUT_MS;
    this.snapshotDirs = options.snapshotDirs ?? defaultCernoSnapshotDirs(this.platform);
    this.expectedUid =
      options.expectedUid !== undefined
        ? options.expectedUid
        : typeof process.getuid === "function"
          ? process.getuid()
          : null;
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
    this.readProcStartTicksFn =
      options.readProcStartTicks ?? ((pid) => readProcStartTicks(pid, this.platform));
    this.readProcRssBytesFn =
      options.readProcRssBytes ?? ((pid) => readProcRssBytes(pid, this.platform));
    this.isCernoProcessFn =
      options.isCernoProcess ?? ((pid) => isCernoProcessPid(pid, this.platform));
    this.resolveThreadIdFn =
      options.resolveThreadId ?? ((pid) => resolveThreadIdForPid(pid, this.platform));
    this.isWorkspaceAllowed = options.isWorkspaceAllowed ?? (async () => false);
    this.killPid = options.killPid ?? ((pid, signal) => process.kill(pid, signal));
    this.hasShipJobId = options.hasShipJobId;
    this.onChanged = options.onChanged;
  }

  start(): void {
    if (this.disposed || this.timer !== null) return;
    void this.refresh();
    this.timer = setInterval(() => {
      void this.refresh();
    }, this.pollIntervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
    this.jobs.clear();
    this.threadIdCache.clear();
  }

  async ensureFresh(maxAgeMs = 1_500): Promise<void> {
    if (this.disposed) return;
    if (this.lastRefreshAtMs === 0 || this.nowMs() - this.lastRefreshAtMs >= maxAgeMs) {
      await this.refresh();
    }
  }

  refresh(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.inflightRefresh) return this.inflightRefresh;
    this.inflightRefresh = this.runScan().finally(() => {
      this.inflightRefresh = null;
    });
    return this.inflightRefresh;
  }

  listSummaries(): ReadonlyArray<JobSummary> {
    return [...this.jobs.values()].map(buildCernoSummary);
  }

  listMatchCandidates(): ReadonlyArray<CernoJobMatchCandidate> {
    return [...this.jobs.values()].map((rec) => ({
      id: rec.id,
      threadId: rec.threadId,
      cwd: rec.cwd,
      state: rec.state,
      command: rec.command,
      logPath: rec.logPath,
      cerno: rec.cerno,
      pidStats: rec.pidStats,
    }));
  }

  /**
   * Start ticks the latest scan read for a live cerno PID; null when that scan did not see it or
   * is older than two poll intervals, so a PID reused since then never matches its old ticks.
   */
  observedStartTicks(pid: number): number | null {
    if (this.nowMs() - this.lastRefreshAtMs > this.observedTicksMaxAgeMs()) return null;
    return this.observedTicks.get(pid) ?? null;
  }

  /** Rescans only when not polling (no subscriber), so observed start ticks stay usable. */
  ensureObservedTicksFresh(): Promise<void> {
    return this.ensureFresh(this.observedTicksMaxAgeMs());
  }

  private observedTicksMaxAgeMs(): number {
    return this.pollIntervalMs * 2;
  }

  getSummary(id: string): JobSummary | undefined {
    const rec = this.jobs.get(id);
    return rec ? buildCernoSummary(rec) : undefined;
  }

  getDetail(id: string): JobDetail | null {
    const rec = this.jobs.get(id);
    return rec ? buildCernoDetail(rec) : null;
  }

  async cancelJob(
    id: string,
  ): Promise<{ readonly ok: boolean; readonly error?: string | undefined }> {
    const rec = this.jobs.get(id);
    if (!rec) return { ok: false, error: `Unknown cerno job id "${id}"` };
    if (isTerminalJobState(rec.state)) return { ok: false, error: `Job is already ${rec.state}` };
    if (this.platform !== "linux") {
      return { ok: false, error: "Stopping cerno processes is supported on Linux only" };
    }
    if (rec.pid <= 1 || rec.pid === process.pid) {
      return { ok: false, error: "Refusing to signal protected process" };
    }
    if (rec.startTicks === null) {
      return { ok: false, error: "Cannot verify process identity without start ticks" };
    }
    const currentTicks = await this.readProcStartTicksFn(rec.pid);
    if (currentTicks !== rec.startTicks) {
      finalizeCernoRecord(rec, this.nowMs());
      this.onChanged?.([rec.id], []);
      return { ok: false, error: `Process PID ${rec.pid} exited or was reused before cancel` };
    }
    if (!(await this.isCernoProcessFn(rec.pid))) {
      return { ok: false, error: `Refusing to signal non-cerno process PID ${rec.pid}` };
    }
    try {
      this.killPid(rec.pid, "SIGTERM");
      Object.assign(rec, {
        state: "cancelling",
        phaseLabel: "Cancelling",
        cancellable: false,
        cancellingSinceMs: this.nowMs(),
        cancelTimedOut: false,
        revision: rec.revision + 1,
      });
      this.onChanged?.([rec.id], []);
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : `Failed to stop PID ${rec.pid}`,
      };
    }
  }

  private async runScan(): Promise<void> {
    const now = this.nowMs();
    const fleetHosts = loadFleetHosts(this.localHostname, this.ciHostsPath);
    const seenIds = new Set<string>();
    const changedIds: string[] = [];
    const observedTicks = new Map<number, number | null>();
    let filesRead = 0;

    for (const dir of this.snapshotDirs) {
      if (this.disposed || filesRead >= MAX_SNAPSHOT_FILES) break;
      if (!(await isSafeCernoSnapshotDir(dir, this.expectedUid))) continue;
      let entries: string[];
      try {
        entries = await NodeFSP.readdir(dir);
      } catch {
        continue;
      }
      for (const name of entries.slice(0, MAX_SCAN_ENTRIES)) {
        if (this.disposed || filesRead >= MAX_SNAPSHOT_FILES) break;
        if (!name.endsWith(".json") || name.startsWith(".")) continue;
        filesRead += 1;
        const snap = await readCernoSnapshotFile(NodePath.join(dir, name), this.expectedUid);
        if (!snap || !this.isPidAlive(snap.pid)) continue;

        const actualTicks = await this.readProcStartTicksFn(snap.pid);
        if (snap.proc_start_ticks !== undefined && actualTicks !== snap.proc_start_ticks) {
          if (this.platform === "linux" || actualTicks !== null) continue;
        }
        if (snap.proc_start_ticks === undefined && now - snap.updated_at_ms > STALE_NO_TICKS_MS) {
          continue;
        }

        const fullCommand = reconstructFullCernoCommand(snap);
        if (
          classifyCommandTracking(fullCommand, undefined, this.hasShipJobId) === "skip" ||
          classifyCommandTracking(snap.command, undefined, this.hasShipJobId) === "skip"
        ) {
          continue;
        }

        const startTicks = snap.proc_start_ticks ?? actualTicks;
        const id = startTicks !== null ? `cerno:${snap.pid}:${startTicks}` : `cerno:${snap.pid}`;
        if (seenIds.has(id)) continue;
        seenIds.add(id);
        observedTicks.set(snap.pid, actualTicks);

        const canonicalLogPath = await resolveCanonicalLogPath(snap.log_path, snap.cwd);
        const threadId = await this.lookupThreadId(snap.pid, startTicks);
        const rssBytes = await this.readProcRssBytesFn(snap.pid);
        const tailLines = await resolveCernoTailLines(
          snap,
          canonicalLogPath,
          this.isWorkspaceAllowed,
        );
        if (
          upsertCernoRecord(this.jobs, {
            id,
            snap,
            startTicks,
            fullCommand,
            canonicalLogPath,
            threadId,
            rssBytes,
            tailLines,
            localHostname: this.localHostname,
            fleetHosts,
            platform: this.platform,
            now,
            cancelTimeoutMs: this.cancelTimeoutMs,
          })
        ) {
          changedIds.push(id);
        }
      }
    }

    for (const rec of this.jobs.values()) {
      if (seenIds.has(rec.id) || isTerminalJobState(rec.state)) continue;
      finalizeCernoRecord(rec, now);
      changedIds.push(rec.id);
    }
    const removedIds = this.pruneCompleted();
    this.observedTicks = observedTicks;
    this.lastRefreshAtMs = now;
    if (!this.disposed && (changedIds.length > 0 || removedIds.length > 0)) {
      this.onChanged?.(changedIds, removedIds);
    }
  }

  private async lookupThreadId(
    pid: number,
    startTicks: number | null,
  ): Promise<string | undefined> {
    const cacheKey = `${pid}:${startTicks ?? 0}`;
    const cached = this.threadIdCache.get(cacheKey);
    if (cached !== undefined) return cached ?? undefined;
    const resolved = (await this.resolveThreadIdFn(pid)) ?? null;
    this.threadIdCache.set(cacheKey, resolved);
    if (this.threadIdCache.size > 256) {
      const first = this.threadIdCache.keys().next().value;
      if (first !== undefined) this.threadIdCache.delete(first);
    }
    return resolved ?? undefined;
  }

  private pruneCompleted(): string[] {
    const completed = [...this.jobs.values()]
      .filter((j) => isTerminalJobState(j.state))
      .sort((a, b) => Date.parse(a.endedAt ?? a.startedAt) - Date.parse(b.endedAt ?? b.startedAt));
    if (completed.length <= MAX_COMPLETED_JOBS) return [];
    const removed: string[] = [];
    for (let i = 0; i < completed.length - MAX_COMPLETED_JOBS; i += 1) {
      const victim = completed[i]!;
      this.jobs.delete(victim.id);
      removed.push(victim.id);
    }
    return removed;
  }
}
