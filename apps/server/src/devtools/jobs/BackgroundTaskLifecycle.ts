// @effect-diagnostics globalTimers:off globalDate:off - Hydration race fence, thread-stop cancellation, and terminalization lifecycle for native background jobs.
import {
  ThreadId,
  type OrchestrationV2PendingBackgroundTask,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { isPullRequestWatchTask } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as DateTime from "effect/DateTime";

import { cleanupJobStreams, ingestCommandOutputFrame } from "./BackgroundJobOutput.ts";
import { resolveCommandTerminalOutcome } from "./commandJobParser.ts";
import {
  BackgroundJobIndex,
  compositeJobKey,
  defaultPhaseLabel,
  ThreadScopedTimers,
  toThreadBindingMeta,
  type ManagedJobRecord,
  type ThreadBindingMeta,
} from "./managedJobHelpers.ts";
import { isTerminalJobState, sanitizeJobText, type TrackedJobState } from "./types.ts";

export type CommandExecutionTurnItem = Extract<
  OrchestrationV2TurnItem,
  { readonly type: "command_execution" }
>;

const ACTIVE_STATUSES = new Set(["running", "waiting"]);

export const formatUtcIso = (dt: DateTime.Utc | null | undefined): string =>
  dt ? DateTime.formatIso(dt) : new Date().toISOString();

export const isActiveShellStatus = (
  status: string,
  runStatus: string | null | undefined,
  activeRunId?: string | null | undefined,
): boolean =>
  activeRunId != null ||
  ACTIVE_STATUSES.has(status) ||
  (runStatus != null && ACTIVE_STATUSES.has(runStatus));

export const isTrackablePendingTask = (task: OrchestrationV2PendingBackgroundTask): boolean =>
  task.kind !== "subagent" && !isPullRequestWatchTask(task);

const MAX_SETTLED_KEYS = 5_000;
const MAX_SETTLED_RUNS = 512;
const HYDRATE_FAILURE_COOLDOWN_MS = 5_000;
const MAX_COMPLETED_JOBS = 30;

export class BackgroundHydrationFence {
  private active = true;
  private settledKeys = new Set<string>();
  private settledThreads = new Set<string>();
  private settledRuns = new Set<string>();
  private liveProviderTasks = new Map<string, ReadonlySet<string>>();
  private retryAfterMs = 0;

  canAttemptHydration(nowMs: number): boolean {
    return nowMs >= this.retryAfterMs;
  }

  markHydrationFailed(nowMs: number): void {
    this.retryAfterMs = nowMs + HYDRATE_FAILURE_COOLDOWN_MS;
  }

  completeHydration(): void {
    this.active = false;
    this.retryAfterMs = 0;
    this.settledKeys.clear();
    this.settledThreads.clear();
    this.liveProviderTasks.clear();
  }

  resetForReconnect(): void {
    this.active = true;
    this.retryAfterMs = 0;
    this.settledKeys.clear();
    this.settledThreads.clear();
    this.liveProviderTasks.clear();
  }

  recordSettledRun(threadId: string, runId: string): void {
    if (!runId) return;
    const key = compositeJobKey(threadId, runId);
    if (this.settledRuns.has(key)) return;
    if (this.settledRuns.size >= MAX_SETTLED_RUNS) {
      const oldest = this.settledRuns.values().next().value;
      if (oldest !== undefined) this.settledRuns.delete(oldest);
    }
    this.settledRuns.add(key);
  }

  isRunSettled(threadId: string, runId: string | null | undefined): boolean {
    if (!runId) return false;
    return this.settledRuns.has(compositeJobKey(threadId, runId));
  }

  recordSettledKey(threadId: string, key: string): void {
    if (!this.active || this.settledKeys.size >= MAX_SETTLED_KEYS) return;
    this.settledKeys.add(compositeJobKey(threadId, key));
  }

  recordSettledThread(threadId: string): void {
    if (!this.active || this.settledThreads.size >= MAX_SETTLED_KEYS) return;
    this.settledThreads.add(threadId);
  }

  recordLiveProviderTasks(
    appThreadId: string,
    providerThreadId: string,
    activeKeys: ReadonlySet<string>,
  ): void {
    if (!this.active) return;
    this.liveProviderTasks.set(`pt:${providerThreadId}`, activeKeys);
    this.liveProviderTasks.set(`th:${appThreadId}`, activeKeys);
  }

  shouldSkipHydratedTask(
    appThreadId: string,
    providerThreadId: string | undefined,
    ownerThreadId: string,
    taskId: string,
  ): boolean {
    if (this.settledThreads.has(appThreadId) || this.settledThreads.has(ownerThreadId)) {
      return true;
    }
    const key = compositeJobKey(ownerThreadId, taskId);
    if (this.settledKeys.has(key)) return true;
    const liveSet =
      (providerThreadId ? this.liveProviderTasks.get(`pt:${providerThreadId}`) : undefined) ??
      this.liveProviderTasks.get(`th:${appThreadId}`);
    return liveSet !== undefined && !liveSet.has(key);
  }

  shouldSkipHydratedCommand(threadId: string, itemId: string): boolean {
    return (
      this.settledThreads.has(threadId) || this.settledKeys.has(compositeJobKey(threadId, itemId))
    );
  }
}

export interface BackgroundLifecycleContext {
  readonly store: BackgroundJobIndex;
  readonly hydrationFence: BackgroundHydrationFence;
  readonly debounceTimers: ThreadScopedTimers;
  readonly pendingFinishTimers: ThreadScopedTimers;
  readonly cancelTimers: ThreadScopedTimers;
  readonly stallMonitor: JobStallMonitor;
  readonly cancelTimeoutMs: number;
  readonly isDisposed: () => boolean;
  readonly getDefaultStallMinutes: () => number;
  readonly stopThread: (
    threadId: ThreadId,
    reason: string,
  ) => Promise<{ readonly ok: boolean; readonly error?: string | undefined }>;
  readonly onMutated: (jobId: string, urgent: boolean) => void;
  readonly onRemoved: (jobId: string) => void;
  readonly onStallDetected?: (() => boolean) | undefined;
}

export function syncBackgroundStallTimer(ctx: BackgroundLifecycleContext): void {
  if (ctx.isDisposed()) return;
  const hasActive = [...ctx.store.jobs.values()].some((j) => !isTerminalJobState(j.state));
  ctx.stallMonitor.sync(
    hasActive,
    () => ctx.store.jobs.values(),
    ctx.getDefaultStallMinutes,
    ctx.onMutated,
    ctx.onStallDetected,
  );
}

export async function finishBackgroundJob(
  ctx: BackgroundLifecycleContext,
  job: ManagedJobRecord,
  state: Extract<TrackedJobState, "done" | "failed" | "cancelled" | "exited">,
  summaryText?: string,
): Promise<void> {
  if (isTerminalJobState(job.state)) return;
  ctx.pendingFinishTimers.clear(job.id);
  ctx.cancelTimers.clear(job.id);
  job.state = state;
  job.phaseLabel = defaultPhaseLabel(job.kind, state);
  job.endedAt = new Date().toISOString();
  job.etaSeconds = undefined;
  job.cancellable = false;
  if (summaryText) job.summaryText = sanitizeJobText(summaryText, 240);
  await cleanupJobStreams(job);
  job.revision += 1;
  ctx.onMutated(job.id, true);
  for (const id of ctx.store.pruneCompleted(MAX_COMPLETED_JOBS, isTerminalJobState)) {
    ctx.onRemoved(id);
  }
  syncBackgroundStallTimer(ctx);
}

function isTurnItemShadowPendingTask(
  job: ManagedJobRecord | undefined,
  itemId: string,
  nativeId?: string,
): boolean {
  return (
    job !== undefined &&
    job.backing === "pending-task" &&
    (job.taskId === itemId || (nativeId !== undefined && job.taskId === nativeId))
  );
}

export function applyRunningCommandUpdateToExisting(
  existing: ManagedJobRecord,
  item: CommandExecutionTurnItem,
  observedAtMs: number,
  startedAtIso: string,
): void {
  const nativeId = item.nativeItemRef?.nativeId ?? undefined;
  const itemRunId = item.runId ?? undefined;
  const command = item.input ?? "";
  if (isTurnItemShadowPendingTask(existing, item.id, nativeId)) {
    existing.backing = "command-item";
  }
  existing.unverifiedShellShadow = undefined;
  existing.providerOmittedWhileShadow = undefined;
  existing.lastConfirmedLiveAtMs = observedAtMs;
  existing.itemId ??= item.id;
  if (itemRunId) existing.runId ??= itemRunId;
  if (nativeId) existing.nativeItemId ??= nativeId;
  if (command && !existing.command) existing.command = command;
  const existingMs = Date.parse(existing.startedAt);
  const itemMs = Date.parse(startedAtIso);
  if (Number.isFinite(itemMs) && (!Number.isFinite(existingMs) || itemMs < existingMs)) {
    existing.startedAt = startedAtIso;
  }
}

export function finalizeTerminalCommandTurnItem(
  ctx: BackgroundLifecycleContext,
  existing: ManagedJobRecord | undefined,
  item: CommandExecutionTurnItem,
  nativeId?: string,
): void {
  if (
    !existing ||
    isTerminalJobState(existing.state) ||
    (existing.backing === "pending-task" &&
      !isTurnItemShadowPendingTask(existing, item.id, nativeId))
  ) {
    return;
  }
  if (item.output && existing.streamTailLines.length === 0) {
    ingestCommandOutputFrame(existing, { kind: "replace", text: item.output }, Date.now());
  }
  const { state, summary } = resolveCommandTerminalOutcome({
    status: item.status,
    exitCode: item.exitCode,
    outputIndicatesFailure: item.outputIndicatesFailure,
    output: item.output ?? undefined,
    wasCancelling: existing.state === "cancelling",
  });
  void finishBackgroundJob(ctx, existing, state, summary);
}

export function updateActiveProviderThreadStatus(
  activeProviderThreads: Map<string, string>,
  appThreadId: string,
  providerThreadId: string,
  status: string,
): void {
  if (status === "active") {
    activeProviderThreads.set(appThreadId, providerThreadId);
  } else if (
    (status === "archived" || status === "closed" || status === "error") &&
    activeProviderThreads.get(appThreadId) === providerThreadId
  ) {
    activeProviderThreads.delete(appThreadId);
  }
}

export function applyThreadLifecycleEvent(
  ctx: BackgroundLifecycleContext,
  threadMeta: Map<string, ThreadBindingMeta>,
  activeProviderThreads: Map<string, string>,
  thread: {
    readonly id: string;
    readonly projectId: string;
    readonly branch?: string | null | undefined;
    readonly worktreePath?: string | null | undefined;
    readonly activeProviderThreadId?: string | null | undefined;
    readonly deletedAt: unknown;
    readonly archivedAt: unknown;
  },
): void {
  if (thread.deletedAt !== null) {
    activeProviderThreads.delete(thread.id);
    ctx.hydrationFence.recordSettledThread(thread.id);
    cancelThreadBackgroundJobs(ctx, thread.id, "Thread deleted");
    threadMeta.delete(thread.id);
    return;
  }
  threadMeta.set(thread.id, toThreadBindingMeta(thread));
  if (thread.archivedAt !== null) {
    activeProviderThreads.delete(thread.id);
    ctx.hydrationFence.recordSettledThread(thread.id);
    cancelThreadBackgroundJobs(ctx, thread.id, "Thread archived");
    return;
  }
  if ("activeProviderThreadId" in thread) {
    if (thread.activeProviderThreadId) {
      activeProviderThreads.set(thread.id, thread.activeProviderThreadId);
    } else {
      activeProviderThreads.delete(thread.id);
    }
  }
}

export function cancelThreadBackgroundJobs(
  ctx: BackgroundLifecycleContext,
  threadId: string,
  summary: string,
  pendingOnly = false,
): void {
  ctx.debounceTimers.clearThread(threadId);
  for (const job of ctx.store.jobs.values()) {
    if (isTerminalJobState(job.state)) continue;
    if (job.threadId !== threadId && job.controlThreadId !== threadId) continue;
    if (pendingOnly && job.backing !== "pending-task") continue;
    if (job.taskId) ctx.hydrationFence.recordSettledKey(job.threadId, job.taskId);
    if (job.itemId) ctx.hydrationFence.recordSettledKey(job.threadId, job.itemId);
    void finishBackgroundJob(ctx, job, "cancelled", summary);
  }
}

export async function cancelBackgroundJobViaThreadStop(
  ctx: BackgroundLifecycleContext,
  id: string,
): Promise<{ readonly ok: boolean; readonly error?: string | undefined }> {
  const job = ctx.store.jobs.get(id);
  if (!job) return { ok: false, error: `Unknown job id "${id}"` };
  if (isTerminalJobState(job.state)) return { ok: false, error: `Job is already ${job.state}` };
  if (job.state === "cancelling") return { ok: true };

  const controlThreadId = job.controlThreadId;
  const affected = [...ctx.store.jobs.values()].filter(
    (j) =>
      !isTerminalJobState(j.state) &&
      j.controlThreadId === controlThreadId &&
      j.state !== "cancelling",
  );
  const snapshot = affected.map((j) => ({
    job: j,
    state: j.state,
    phaseLabel: j.phaseLabel,
    cancellable: j.cancellable,
  }));
  for (const j of affected) {
    ctx.pendingFinishTimers.clear(j.id);
    j.state = "cancelling";
    j.phaseLabel = "Cancelling";
    j.cancellable = false;
    j.revision += 1;
    ctx.onMutated(j.id, true);
  }

  const res = await ctx.stopThread(
    ThreadId.make(controlThreadId),
    `Stopped thread work for "${job.title}" from Fleet Console`,
  );
  if (!res.ok) {
    for (const prev of snapshot) {
      if (prev.job.state !== "cancelling") continue;
      Object.assign(prev.job, {
        state: prev.state,
        phaseLabel: prev.phaseLabel ?? defaultPhaseLabel(prev.job.kind, prev.state),
        cancellable: prev.cancellable,
        revision: prev.job.revision + 1,
      });
      ctx.onMutated(prev.job.id, true);
    }
    return res;
  }

  if (!ctx.isDisposed()) {
    for (const j of affected) {
      if (j.state !== "cancelling") continue;
      ctx.cancelTimers.schedule(j.id, ctx.cancelTimeoutMs, () => {
        if (!ctx.isDisposed() && j.state === "cancelling") {
          void finishBackgroundJob(
            ctx,
            j,
            "cancelled",
            "Stop requested (provider confirmation timed out)",
          );
        }
      });
    }
  }
  return res;
}

const STALL_CHECK_INTERVAL_MS = 30_000;

export class JobStallMonitor {
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(intervalMs = STALL_CHECK_INTERVAL_MS) {
    this.intervalMs = intervalMs;
  }

  sync(
    hasActive: boolean,
    jobs: () => Iterable<ManagedJobRecord>,
    stallMinutes: () => number,
    onMutated: (jobId: string, urgent: boolean) => void,
    onStallDetected?: () => boolean,
  ): void {
    if (hasActive && this.timer === null) {
      this.timer = setInterval(() => {
        const thresholdMs = stallMinutes() * 60_000;
        const nowMs = Date.now();
        const newlyStalled: Array<{ readonly job: ManagedJobRecord; readonly activityMs: number }> =
          [];
        for (const job of jobs()) {
          if (isTerminalJobState(job.state) || job.state === "cancelling") continue;
          const idleMs = nowMs - job.lastActivityAtMs;
          if (idleMs < thresholdMs) continue;
          if (job.lastStallReconcileActivityMs !== job.lastActivityAtMs) {
            newlyStalled.push({ job, activityMs: job.lastActivityAtMs });
          }
          const nextText = `No output for ${Math.floor(idleMs / 60_000)}m`;
          if (job.anomalyText !== nextText) {
            job.anomalyText = nextText;
            job.revision += 1;
            onMutated(job.id, false);
          }
        }
        // Mark stall episodes consumed ONLY when the reconcile scheduler accepts/schedules the trigger (M1).
        if (newlyStalled.length > 0 && onStallDetected?.() === true) {
          for (const entry of newlyStalled) {
            entry.job.lastStallReconcileActivityMs = entry.activityMs;
          }
        }
      }, this.intervalMs);
      this.timer.unref();
    } else if (!hasActive) {
      this.stop();
    }
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
