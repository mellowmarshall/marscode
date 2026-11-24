// @effect-diagnostics globalDate:off globalTimers:off - Record model and summary/detail projection for T3-tracked background jobs.
import {
  buildJobKpis,
  buildPrimarySparkline,
  buildRecentTail,
  formatRedactedCommand,
  resolveJobLogState,
} from "./jobMetricFilter.ts";
import { redactLogLine } from "./logFileGuard.ts";
import type { AdaptiveLogTailer } from "./LogTailer.ts";
import type {
  JobDetail,
  JobLogSourceConfig,
  JobLogState,
  JobMetricPoint,
  JobMetricSeries,
  JobProgress,
  JobSummary,
  TrackedJobState,
} from "./types.ts";

export const DEFAULT_STALL_MINUTES = 15;

/** Monotonic millisecond clock immune to wall-clock adjustments (L9). */
export function nowMonotonicMs(): number {
  return performance.now();
}

export interface RateSample {
  readonly t: number;
  readonly current: number;
}

export interface ManagedJobSeriesState {
  readonly key: string;
  readonly label: string;
  readonly unit?: string | undefined;
  readonly higherIsBetter?: boolean | undefined;
  readonly points: JobMetricPoint[];
  latestValue: number | null;
  latestAnomaly?: "nan" | "inf" | undefined;
}

export interface ManagedJobRecord {
  readonly id: string;
  revision: number;
  kind: string;
  title: string;
  subtitle?: string | undefined;
  phaseLabel?: string | undefined;
  state: TrackedJobState;
  binding: JobSummary["binding"];
  startedAt: string;
  endedAt?: string | undefined;
  etaSeconds?: number | undefined;
  progress?: JobProgress | undefined;
  lastGenericOuter?: number | undefined;
  lastGenericInner?: number | undefined;
  genericStepPerEpoch?: boolean | undefined;
  summaryText?: string | undefined;
  anomalyText?: string | undefined;
  cancellable: boolean;
  readonly series: Map<string, ManagedJobSeriesState>;
  readonly rateSamples: RateSample[];
  lastActivityAtMs: number;
  lastConfirmedLiveAtMs: number;
  lastStallReconcileActivityMs?: number | undefined;
  lastTailEmitAtMs?: number | undefined;
  logSource?: JobLogSourceConfig | undefined;
  tailer?: AdaptiveLogTailer | undefined;
  streamTailLines: string[];
  streamTailBytes: number;
  streamPendingLine: string;
  persistedTailLines: ReadonlyArray<string>;
  persistedLogPath?: string | undefined;
  persistedLinesParsed: number;
  readonly threadId: string;
  controlThreadId: string;
  backing: "pending-task" | "command-item";
  unverifiedShellShadow?: boolean | undefined;
  providerOmittedWhileShadow?: boolean | undefined;
  providerThreadId?: string | undefined;
  runId?: string | undefined;
  taskId?: string | undefined;
  itemId?: string | undefined;
  nativeItemId?: string | undefined;
  command: string;
  logAttachPath?: string | undefined;
  logState?: JobLogState | undefined;
  logStateReason?: string | undefined;
  logAttachTimer?: ReturnType<typeof setTimeout> | null | undefined;
  stopOutputStream?: (() => void) | null | undefined;
}

export function isStallAnomalyText(text: string | undefined): boolean {
  return Boolean(text && text.startsWith("No output for "));
}

export function defaultPhaseLabel(kind: string, state: TrackedJobState): string {
  if (state === "queued") return "Queued";
  if (state === "waiting") return "Waiting";
  if (state === "cancelling") return "Cancelling";
  if (state === "done") return "Done";
  if (state === "failed") return "Failed";
  if (state === "cancelled") return "Cancelled";
  if (state === "exited") return "Exited";
  switch (kind) {
    case "render":
      return "Rendering";
    case "train":
      return "Training";
    case "eval":
      return "Evaluating";
    case "bench":
    case "benchmark":
      return "Benchmarking";
    case "build":
      return "Building";
    case "migrate":
    case "migration":
      return "Migrating";
    case "test":
      return "Testing";
    case "ship":
      return "Shipping";
    case "command":
      return "Running";
    default:
      return kind ? `${kind.charAt(0).toUpperCase()}${kind.slice(1)}` : "Running";
  }
}

function resolveRawTailLines(job: ManagedJobRecord): ReadonlyArray<string> {
  if (job.tailer) {
    const fileLines = job.tailer.getTailLines();
    if (fileLines.length > 0) return fileLines;
  }
  if (job.persistedTailLines.length > 0) return job.persistedTailLines;
  return job.streamTailLines;
}

export function buildJobSummary(job: ManagedJobRecord): JobSummary {
  const kpis = buildJobKpis(job.series);
  const sparkline = buildPrimarySparkline(job.series, kpis);
  const tailLines = resolveRawTailLines(job);
  const recentTail = buildRecentTail(tailLines);
  const { logState, logStateReason } = resolveJobLogState({
    hasAttachedTailer: Boolean(job.tailer),
    hasPersistedLogPath: Boolean(job.persistedLogPath),
    hasTailLines: tailLines.length > 0,
    explicitState: job.logState,
    explicitReason: job.logStateReason,
  });
  return {
    id: job.id,
    revision: job.revision,
    source: "background",
    kind: job.kind,
    title: job.title,
    ...(job.subtitle ? { subtitle: job.subtitle } : {}),
    phaseLabel: job.phaseLabel || defaultPhaseLabel(job.kind, job.state),
    state: job.state,
    binding: job.binding,
    timing: {
      startedAt: job.startedAt,
      ...(job.endedAt ? { endedAt: job.endedAt } : {}),
      ...(job.etaSeconds !== undefined ? { etaSeconds: job.etaSeconds } : {}),
    },
    ...(job.progress ? { progress: job.progress } : {}),
    ...(kpis && kpis.length > 0 ? { kpis } : {}),
    ...(sparkline ? { sparkline } : {}),
    ...(job.series.size > 0 ? { hasMetrics: true } : {}),
    ...(tailLines.length > 0 || job.logSource ? { hasLog: true } : {}),
    logState,
    ...(logStateReason ? { logStateReason } : {}),
    ...(recentTail ? { recentTail } : {}),
    cancellable: job.cancellable,
    ...(job.summaryText ? { summary: job.summaryText } : {}),
    ...(job.anomalyText ? { anomaly: job.anomalyText } : {}),
  };
}

export function buildJobDetail(job: ManagedJobRecord): JobDetail {
  const series: JobMetricSeries[] = [];
  for (const s of job.series.values()) {
    series.push({
      key: s.key,
      label: s.label,
      ...(s.unit ? { unit: s.unit } : {}),
      ...(s.higherIsBetter !== undefined ? { higherIsBetter: s.higherIsBetter } : {}),
      points: [...s.points],
    });
  }
  const cursor = job.tailer?.getCursor();
  const tail = resolveRawTailLines(job).map((line) => redactLogLine(line));
  const { logState, logStateReason } = resolveJobLogState({
    hasAttachedTailer: Boolean(job.tailer),
    hasPersistedLogPath: Boolean(job.persistedLogPath),
    hasTailLines: tail.length > 0,
    explicitState: job.logState,
    explicitReason: job.logStateReason,
  });
  const command = formatRedactedCommand(job.command);
  return {
    id: job.id,
    revision: job.revision,
    ...(command ? { command } : {}),
    logState,
    ...(logStateReason ? { logStateReason } : {}),
    series,
    logTail: tail,
    ...(cursor?.realPath
      ? { logPath: cursor.realPath }
      : job.persistedLogPath
        ? { logPath: job.persistedLogPath }
        : {}),
    linesParsed:
      cursor?.linesParsed ?? Math.max(job.persistedLinesParsed, job.streamTailLines.length),
  };
}

export interface ThreadBindingMeta {
  readonly projectId?: string | undefined;
  readonly branch?: string | undefined;
  readonly worktreePath?: string | undefined;
}

export function toThreadBindingMeta(t: {
  readonly projectId: string;
  readonly branch?: string | null | undefined;
  readonly worktreePath?: string | null | undefined;
}): ThreadBindingMeta {
  return {
    projectId: t.projectId,
    branch: t.branch ?? undefined,
    worktreePath: t.worktreePath ?? undefined,
  };
}

export function createManagedJobRecord(input: {
  readonly id: string;
  readonly threadId: string;
  readonly controlThreadId?: string | undefined;
  readonly backing: "pending-task" | "command-item";
  readonly providerThreadId?: string | undefined;
  readonly runId?: string | undefined;
  readonly taskId?: string | undefined;
  readonly itemId?: string | undefined;
  readonly nativeItemId?: string | undefined;
  readonly command: string;
  readonly kind: string;
  readonly title: string;
  readonly host: string;
  readonly startedAtIso: string;
  readonly confirmedAtMs?: number | undefined;
  readonly unverifiedShellShadow?: boolean | undefined;
  readonly meta?: ThreadBindingMeta | undefined;
}): ManagedJobRecord {
  const nowWallMs = Date.now();
  const confirmedMonoMs = input.confirmedAtMs ?? nowMonotonicMs();
  return {
    id: input.id,
    revision: 1,
    kind: input.kind,
    title: input.title,
    phaseLabel: defaultPhaseLabel(input.kind, "running"),
    state: "running",
    binding: {
      threadId: input.threadId,
      ...(input.meta?.projectId ? { projectId: input.meta.projectId } : {}),
      ...(input.meta?.branch ? { branch: input.meta.branch } : {}),
      ...(input.meta?.worktreePath ? { worktreePath: input.meta.worktreePath } : {}),
      host: input.host,
    },
    startedAt: input.startedAtIso,
    cancellable: true,
    series: new Map(),
    rateSamples: [],
    lastActivityAtMs: nowWallMs,
    lastConfirmedLiveAtMs: confirmedMonoMs,
    ...(input.unverifiedShellShadow ? { unverifiedShellShadow: true } : {}),
    streamTailLines: [],
    streamTailBytes: 0,
    streamPendingLine: "",
    persistedTailLines: [],
    persistedLinesParsed: 0,
    threadId: input.threadId,
    controlThreadId: input.controlThreadId ?? input.threadId,
    backing: input.backing,
    providerThreadId: input.providerThreadId,
    runId: input.runId,
    taskId: input.taskId,
    itemId: input.itemId,
    nativeItemId: input.nativeItemId,
    command: input.command,
  };
}

export function mergePendingTaskMetadata(
  existing: ManagedJobRecord,
  patch: {
    readonly controlThreadId?: string | undefined;
    readonly providerThreadId?: string | undefined;
    readonly taskId: string;
    readonly itemId?: string | undefined;
    readonly nativeItemId?: string | undefined;
    readonly command: string;
    readonly title: string;
    readonly kind: string;
    readonly host: string;
    readonly localHostname: string;
    readonly preserveCommandBacking?: boolean | undefined;
  },
): boolean {
  if (!patch.preserveCommandBacking) {
    existing.backing = "pending-task";
  }
  existing.taskId = patch.taskId;
  existing.lastConfirmedLiveAtMs = nowMonotonicMs();
  if (patch.controlThreadId) existing.controlThreadId = patch.controlThreadId;
  if (patch.providerThreadId) existing.providerThreadId = patch.providerThreadId;
  if (patch.itemId) existing.itemId = patch.itemId;
  if (patch.nativeItemId) existing.nativeItemId = patch.nativeItemId;
  if (patch.command && !existing.command) existing.command = patch.command;
  let changed = false;
  if (!patch.preserveCommandBacking && patch.title && existing.title !== patch.title) {
    existing.title = patch.title;
    changed = true;
  }
  if (patch.kind !== "command" && existing.kind === "command") {
    existing.kind = patch.kind;
    existing.phaseLabel = defaultPhaseLabel(patch.kind, existing.state);
    changed = true;
  }
  if (patch.host !== existing.binding.host && patch.host !== patch.localHostname) {
    existing.binding = { ...existing.binding, host: patch.host };
    changed = true;
  }
  return changed;
}

export function compositeJobKey(threadId: string, id: string): string {
  return `${threadId}\0${id}`;
}

export class BackgroundJobIndex {
  readonly jobs = new Map<string, ManagedJobRecord>();
  private readonly byTaskKey = new Map<string, string>();
  private readonly byItemKey = new Map<string, string>();
  private readonly byNativeKey = new Map<string, string>();

  find(
    threadId: string,
    keys: {
      readonly taskId?: string | undefined;
      readonly itemId?: string | undefined;
      readonly nativeItemId?: string | undefined;
    },
  ): ManagedJobRecord | undefined {
    const lookup = (val: string | undefined): string | undefined => {
      if (!val) return undefined;
      const k = compositeJobKey(threadId, val);
      return this.byTaskKey.get(k) ?? this.byItemKey.get(k) ?? this.byNativeKey.get(k);
    };
    const id = lookup(keys.taskId) ?? lookup(keys.itemId) ?? lookup(keys.nativeItemId);
    return id ? this.jobs.get(id) : undefined;
  }

  hasItem(threadId: string, itemId: string): boolean {
    return this.byItemKey.has(compositeJobKey(threadId, itemId));
  }

  put(job: ManagedJobRecord): void {
    this.jobs.set(job.id, job);
    this.reindex(job);
  }

  reindex(job: ManagedJobRecord): void {
    if (job.taskId) this.byTaskKey.set(compositeJobKey(job.threadId, job.taskId), job.id);
    if (job.itemId) this.byItemKey.set(compositeJobKey(job.threadId, job.itemId), job.id);
    if (job.nativeItemId) {
      this.byNativeKey.set(compositeJobKey(job.threadId, job.nativeItemId), job.id);
    }
  }

  delete(job: ManagedJobRecord): void {
    this.jobs.delete(job.id);
    if (job.taskId && this.byTaskKey.get(compositeJobKey(job.threadId, job.taskId)) === job.id) {
      this.byTaskKey.delete(compositeJobKey(job.threadId, job.taskId));
    }
    if (job.itemId && this.byItemKey.get(compositeJobKey(job.threadId, job.itemId)) === job.id) {
      this.byItemKey.delete(compositeJobKey(job.threadId, job.itemId));
    }
    if (
      job.nativeItemId &&
      this.byNativeKey.get(compositeJobKey(job.threadId, job.nativeItemId)) === job.id
    ) {
      this.byNativeKey.delete(compositeJobKey(job.threadId, job.nativeItemId));
    }
  }

  pruneCompleted(maxCompleted: number, isTerminal: (state: TrackedJobState) => boolean): string[] {
    const completed = [...this.jobs.values()]
      .filter((j) => isTerminal(j.state))
      .sort((a, b) => Date.parse(a.endedAt ?? a.startedAt) - Date.parse(b.endedAt ?? b.startedAt));
    if (completed.length <= maxCompleted) return [];
    const removed: string[] = [];
    for (let i = 0; i < completed.length - maxCompleted; i += 1) {
      const victim = completed[i]!;
      this.delete(victim);
      removed.push(victim.id);
    }
    return removed;
  }
}

export class ThreadScopedTimers {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  schedule(key: string, delayMs: number, fn: () => void): void {
    if (this.timers.has(key)) return;
    const timer = setTimeout(() => {
      this.timers.delete(key);
      fn();
    }, delayMs);
    timer.unref();
    this.timers.set(key, timer);
  }

  clear(key: string): void {
    const timer = this.timers.get(key);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(key);
    }
  }

  clearThread(threadId: string): void {
    const prefix = `${threadId}\0`;
    for (const [key, timer] of this.timers) {
      if (key.startsWith(prefix)) {
        clearTimeout(timer);
        this.timers.delete(key);
      }
    }
  }

  clearAll(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}

export function stripJobSummaryCmdline(summary: JobSummary): JobSummary {
  const hasCmdline = Boolean(summary.pidStats?.cmdline);
  const hasRecentTail = summary.recentTail !== undefined;
  const hasLogStateReason = summary.logStateReason !== undefined;
  if (!hasCmdline && !hasRecentTail && !hasLogStateReason) return summary;
  const { recentTail: _omitTail, logStateReason: _omitLogReason, ...rest } = summary;
  if (!hasCmdline || !summary.pidStats) return rest;
  const { cmdline: _omitCmdline, ...restPidStats } = summary.pidStats;
  return { ...rest, pidStats: restPidStats };
}
