// @effect-diagnostics globalDate:off globalTimers:off - Authoritative snapshot, terminal-run, and provider-thread reconciliation for background jobs.
import {
  ThreadId,
  type OrchestrationV2PendingBackgroundTask,
  type OrchestrationV2ThreadShellSnapshot,
} from "@t3tools/contracts";

import type { SnapshotReconcileResult } from "./BackgroundReconcileScheduler.ts";
import {
  finishBackgroundJob,
  formatUtcIso,
  isActiveShellStatus,
  isTrackablePendingTask,
  type BackgroundLifecycleContext,
  type CommandExecutionTurnItem,
} from "./BackgroundTaskLifecycle.ts";
import {
  compositeJobKey,
  nowMonotonicMs,
  toThreadBindingMeta,
  type ThreadBindingMeta,
} from "./managedJobHelpers.ts";
import { isTerminalJobState, type TrackedJobState } from "./types.ts";

const TERMINAL_RUN_STATUSES = new Set([
  "completed",
  "failed",
  "interrupted",
  "cancelled",
  "rolled_back",
]);

const UNSETTLED_SHELL_RUN_STATUSES = new Set(["preparing", "queued", "starting", "running"]);
const AUTHORITATIVE_PROVIDER_THREAD_STATUSES = new Set(["active", "idle"]);

function terminalStateForRunStatus(
  runStatus: string,
  wasCancelling: boolean,
): Extract<TrackedJobState, "exited" | "failed" | "cancelled"> {
  if (wasCancelling || runStatus === "cancelled" || runStatus === "interrupted") {
    return "cancelled";
  }
  if (runStatus === "failed" || runStatus === "rolled_back") {
    return "failed";
  }
  // Completed run without an explicit command exit event: avoid claiming exit 0 ("done").
  return "exited";
}

function isShellPendingListAuthoritative(shell: {
  readonly status: string;
  readonly activityRunStatus?: string | null | undefined;
  readonly activeRunId?: string | null | undefined;
}): boolean {
  // Mirrors `derivePendingBackgroundWork`: shell.pendingBackgroundTasks returns `[]`
  // whenever a run is active or unsettled.
  if (shell.activeRunId != null) return false;
  if (UNSETTLED_SHELL_RUN_STATUSES.has(shell.status)) return false;
  if (
    shell.activityRunStatus != null &&
    UNSETTLED_SHELL_RUN_STATUSES.has(shell.activityRunStatus)
  ) {
    return false;
  }
  return true;
}

export interface PendingDebounceEntry {
  readonly threadId: string;
  readonly itemId: string;
  readonly runId: string;
  verifiedLiveAfterRunEnd: boolean;
  deferredBySettledRun: boolean;
}

/**
 * Reconciles lingering `command-item` jobs and pending debounced items bound to a terminal run.
 * Verifies against `getRunningCommandsForThread` before closing so persistent monitors that
 * legally outlive their launch run stay open and debounced live monitors still promote.
 */
export async function reconcileTerminalRunCommands(input: {
  readonly ctx: BackgroundLifecycleContext;
  readonly run: { readonly id: string; readonly threadId: string; readonly status: string };
  readonly debounceRunIds: Map<string, PendingDebounceEntry>;
  readonly getRunningCommandsForThread: (
    threadId: ThreadId,
  ) => Promise<ReadonlyArray<CommandExecutionTurnItem>>;
  readonly onVerifiedLiveCommand: (item: CommandExecutionTurnItem) => void;
  readonly onCommandCheckFailed?: (() => void) | undefined;
}): Promise<void> {
  const {
    ctx,
    run,
    debounceRunIds,
    getRunningCommandsForThread,
    onVerifiedLiveCommand,
    onCommandCheckFailed,
  } = input;
  if (!TERMINAL_RUN_STATUSES.has(run.status)) return;
  ctx.hydrationFence.recordSettledRun(run.threadId, run.id);

  let hasMatchingJob = false;
  for (const job of ctx.store.jobs.values()) {
    if (
      !isTerminalJobState(job.state) &&
      job.backing === "command-item" &&
      job.runId === run.id &&
      job.threadId === run.threadId
    ) {
      hasMatchingJob = true;
      break;
    }
  }
  let hasMatchingDebounce = false;
  for (const entry of debounceRunIds.values()) {
    if (entry.threadId === run.threadId && entry.runId === run.id) {
      hasMatchingDebounce = true;
      break;
    }
  }
  if (!hasMatchingJob && !hasMatchingDebounce) return;

  const checkStartMs = nowMonotonicMs();
  let runningItems: ReadonlyArray<CommandExecutionTurnItem>;
  try {
    runningItems = await getRunningCommandsForThread(ThreadId.make(run.threadId));
  } catch {
    // Never close live jobs on a transient RPC error; schedule a retry reconcile to resolve state.
    onCommandCheckFailed?.();
    return;
  }
  if (ctx.isDisposed()) return;

  const liveItemsById = new Map<string, CommandExecutionTurnItem>(
    runningItems.map((it) => [it.id, it]),
  );
  for (const [key, entry] of debounceRunIds) {
    if (entry.threadId !== run.threadId || entry.runId !== run.id) continue;
    const liveItem = liveItemsById.get(entry.itemId);
    if (liveItem) {
      entry.verifiedLiveAfterRunEnd = true;
      if (entry.deferredBySettledRun) {
        debounceRunIds.delete(key);
        onVerifiedLiveCommand(liveItem);
      }
    } else {
      ctx.debounceTimers.clear(key);
      debounceRunIds.delete(key);
      ctx.hydrationFence.recordSettledKey(entry.threadId, entry.itemId);
    }
  }

  const finishes: Array<Promise<void>> = [];
  for (const job of ctx.store.jobs.values()) {
    if (isTerminalJobState(job.state)) continue;
    if (job.backing !== "command-item") continue;
    if (job.runId !== run.id || job.threadId !== run.threadId) continue;
    if (job.itemId && liveItemsById.has(job.itemId)) {
      job.lastConfirmedLiveAtMs = nowMonotonicMs();
      continue;
    }
    if (job.lastConfirmedLiveAtMs >= checkStartMs) continue;
    if (job.itemId) {
      const key = compositeJobKey(job.threadId, job.itemId);
      ctx.debounceTimers.clear(key);
      debounceRunIds.delete(key);
      ctx.hydrationFence.recordSettledKey(job.threadId, job.itemId);
    }
    const nextState = terminalStateForRunStatus(run.status, job.state === "cancelling");
    finishes.push(finishBackgroundJob(ctx, job, nextState));
  }
  if (finishes.length > 0) {
    await Promise.all(finishes);
  }
}

async function reconcileStaleJobsAfterSnapshot(input: {
  readonly ctx: BackgroundLifecycleContext;
  readonly snapshotStartMs: number;
  readonly livePendingTaskKeys: ReadonlySet<string>;
  readonly knownShellThreadIds: ReadonlySet<string>;
  readonly authoritativePendingShellThreadIds: ReadonlySet<string>;
  readonly succeededCommandChecks: ReadonlyMap<string, ReadonlySet<string>>;
}): Promise<void> {
  const {
    ctx,
    snapshotStartMs,
    livePendingTaskKeys,
    knownShellThreadIds,
    authoritativePendingShellThreadIds,
    succeededCommandChecks,
  } = input;
  const finishes: Array<Promise<void>> = [];

  for (const job of ctx.store.jobs.values()) {
    if (isTerminalJobState(job.state)) continue;
    // Monotonic race guard: any job created or confirmed live after the snapshot started stays open.
    if (job.lastConfirmedLiveAtMs >= snapshotStartMs) continue;

    if (job.backing === "pending-task") {
      const key = job.taskId ? compositeJobKey(job.threadId, job.taskId) : null;
      if (key && livePendingTaskKeys.has(key)) continue;
      // If a degraded-startup shadow was omitted by an authoritative provider-thread.updated AND
      // command lookup now succeeded without finding a matching command-item, close it immediately.
      const resolvedOmittedShadow =
        job.unverifiedShellShadow === true &&
        job.providerOmittedWhileShadow === true &&
        succeededCommandChecks.has(job.controlThreadId);
      if (!resolvedOmittedShadow && knownShellThreadIds.has(job.controlThreadId)) {
        // Treat shell.pendingBackgroundTasks absence as authoritative only when the shell has no
        // active/unsettled run; supersedes tasks from retired/non-active provider threads too.
        if (!authoritativePendingShellThreadIds.has(job.controlThreadId)) continue;
      }
      if (job.taskId) ctx.hydrationFence.recordSettledKey(job.threadId, job.taskId);
      finishes.push(
        finishBackgroundJob(ctx, job, job.state === "cancelling" ? "cancelled" : "exited"),
      );
      continue;
    }

    if (!knownShellThreadIds.has(job.threadId)) {
      if (job.itemId) ctx.hydrationFence.recordSettledKey(job.threadId, job.itemId);
      finishes.push(
        finishBackgroundJob(ctx, job, job.state === "cancelling" ? "cancelled" : "exited"),
      );
      continue;
    }

    const liveCommandIds = succeededCommandChecks.get(job.threadId);
    // Never treat a failed getRunningCommandsForThread call as an empty running set.
    if (liveCommandIds === undefined) continue;
    if (job.itemId && liveCommandIds.has(job.itemId)) continue;
    if (job.itemId) ctx.hydrationFence.recordSettledKey(job.threadId, job.itemId);
    finishes.push(
      finishBackgroundJob(ctx, job, job.state === "cancelling" ? "cancelled" : "exited"),
    );
  }

  if (finishes.length > 0) {
    await Promise.all(finishes);
  }
}

/**
 * Hydrates live pending tasks and running commands from an authoritative shell snapshot, then
 * reconciles and closes any pre-existing jobs that vanished without racing concurrent live events.
 */
export async function hydrateAndReconcileSnapshot(input: {
  readonly ctx: BackgroundLifecycleContext;
  readonly threadMeta: Map<string, ThreadBindingMeta>;
  readonly activeProviderThreads: Map<string, string>;
  readonly debounceRunIds: Map<string, PendingDebounceEntry>;
  readonly reconcile: boolean;
  readonly getShellSnapshot: () => Promise<OrchestrationV2ThreadShellSnapshot>;
  readonly getRunningCommandsForThread: (
    threadId: ThreadId,
  ) => Promise<ReadonlyArray<CommandExecutionTurnItem>>;
  readonly upsertPendingTask: (
    ownerThreadId: string,
    controlThreadId: string,
    providerThreadId: string | undefined,
    task: OrchestrationV2PendingBackgroundTask,
    startedAtIso: string,
    fromShellSnapshot: boolean,
    commandCheckFailed: boolean,
  ) => void;
  readonly handleCommandTurnItem: (item: CommandExecutionTurnItem, isHydration: boolean) => void;
}): Promise<SnapshotReconcileResult> {
  const snapshotStartMs = nowMonotonicMs();
  const snapshot = await input.getShellSnapshot();
  if (input.ctx.isDisposed()) return { partial: false };

  const commandCheckThreadIds = new Set<ThreadId>();
  const knownShellThreadIds = new Set<string>();
  const authoritativePendingShellThreadIds = new Set<string>();
  const livePendingTaskKeys = new Set<string>();
  const shellPendingTasks: Array<{
    readonly shellId: ThreadId;
    readonly ptId: string | undefined;
    readonly shellStartIso: string;
    readonly tasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>;
  }> = [];

  for (const shell of snapshot.threads) {
    knownShellThreadIds.add(shell.id);
    input.threadMeta.set(shell.id, toThreadBindingMeta(shell));
    const shellStartIso = formatUtcIso(shell.latestRunStartedAt ?? shell.updatedAt);
    const ptId = shell.activeProviderThreadId ?? undefined;
    if (ptId) {
      input.activeProviderThreads.set(shell.id, ptId);
    } else {
      input.activeProviderThreads.delete(shell.id);
    }
    if (isShellPendingListAuthoritative(shell)) {
      authoritativePendingShellThreadIds.add(shell.id);
    }
    const trackable = (shell.pendingBackgroundTasks ?? []).filter(isTrackablePendingTask);
    if (trackable.length > 0) {
      shellPendingTasks.push({ shellId: shell.id, ptId, shellStartIso, tasks: trackable });
      // Settled threads with persistent monitors carry them in shell.pendingBackgroundTasks;
      // fetch running command items first so monitors hydrate as command-items without duplicates.
      commandCheckThreadIds.add(shell.id);
    }
    if (isActiveShellStatus(shell.status, shell.activityRunStatus, shell.activeRunId)) {
      commandCheckThreadIds.add(shell.id);
    }
  }

  for (const job of input.ctx.store.jobs.values()) {
    if (isTerminalJobState(job.state)) continue;
    if (job.backing === "command-item" && knownShellThreadIds.has(job.threadId)) {
      commandCheckThreadIds.add(ThreadId.make(job.threadId));
    } else if (job.unverifiedShellShadow) {
      commandCheckThreadIds.add(ThreadId.make(job.controlThreadId));
    }
  }
  for (const entry of input.debounceRunIds.values()) {
    if (
      entry.deferredBySettledRun ||
      (!entry.verifiedLiveAfterRunEnd &&
        input.ctx.hydrationFence.isRunSettled(entry.threadId, entry.runId))
    ) {
      commandCheckThreadIds.add(ThreadId.make(entry.threadId));
    }
  }

  let commandCheckFailures = 0;
  const succeededCommandChecks = new Map<string, Set<string>>();
  const liveTurnItemMatchKeys = new Set<string>();
  await Promise.all(
    [...commandCheckThreadIds].map(async (tid) => {
      let items: ReadonlyArray<CommandExecutionTurnItem>;
      try {
        items = await input.getRunningCommandsForThread(tid);
      } catch {
        // Leave tid absent from succeededCommandChecks so failed RPCs never close live jobs,
        // and mark this pass partial so the scheduler retries with backoff.
        commandCheckFailures += 1;
        return;
      }
      if (input.ctx.isDisposed()) return;
      const liveItemIds = new Set<string>();
      for (const item of items) {
        liveItemIds.add(item.id);
        liveTurnItemMatchKeys.add(compositeJobKey(item.threadId, item.id));
        const nativeId = item.nativeItemRef?.nativeId;
        if (nativeId) liveTurnItemMatchKeys.add(compositeJobKey(item.threadId, nativeId));
        if (!input.ctx.hydrationFence.shouldSkipHydratedCommand(item.threadId, item.id)) {
          input.handleCommandTurnItem(item, true);
        }
      }
      succeededCommandChecks.set(tid, liveItemIds);
    }),
  );
  if (input.ctx.isDisposed()) return { partial: false };

  // Resolve any unverified/deferred settled-run debounce entries whose command lookup just succeeded.
  for (const [key, entry] of input.debounceRunIds) {
    const needsCheck =
      entry.deferredBySettledRun ||
      (!entry.verifiedLiveAfterRunEnd &&
        input.ctx.hydrationFence.isRunSettled(entry.threadId, entry.runId));
    if (!needsCheck) continue;
    const liveIds = succeededCommandChecks.get(entry.threadId);
    if (liveIds === undefined) continue;
    input.debounceRunIds.delete(key);
    input.ctx.debounceTimers.clear(key);
    if (!liveIds.has(entry.itemId)) {
      input.ctx.hydrationFence.recordSettledKey(entry.threadId, entry.itemId);
    }
  }

  for (const entry of shellPendingTasks) {
    for (const task of entry.tasks) {
      const ownerThreadId = task.sourceThreadId ?? entry.shellId;
      const key = compositeJobKey(ownerThreadId, task.taskId);
      // Skip turn-item-derived mirror tasks (derivePendingBackgroundWork) already tracked as command-items.
      if (liveTurnItemMatchKeys.has(key)) continue;
      livePendingTaskKeys.add(key);
      if (
        !input.ctx.hydrationFence.shouldSkipHydratedTask(
          entry.shellId,
          entry.ptId,
          ownerThreadId,
          task.taskId,
        )
      ) {
        input.upsertPendingTask(
          ownerThreadId,
          entry.shellId,
          entry.ptId,
          task,
          entry.shellStartIso,
          true,
          !succeededCommandChecks.has(entry.shellId),
        );
      }
    }
  }

  if (input.reconcile) {
    await reconcileStaleJobsAfterSnapshot({
      ctx: input.ctx,
      snapshotStartMs,
      livePendingTaskKeys,
      knownShellThreadIds,
      authoritativePendingShellThreadIds,
      succeededCommandChecks,
    });
  }
  input.ctx.hydrationFence.completeHydration();
  return { partial: commandCheckFailures > 0 };
}

/**
 * Reconciles `pending-task` jobs missing from a `provider-thread.updated` event.
 * Permits cross-provider-thread closure (`controlThreadId === appThreadId`) ONLY when the event
 * has an authoritative status (`active` or `idle`) AND matches the thread's active provider thread.
 */
export function reconcileMissingProviderTasks(input: {
  readonly ctx: BackgroundLifecycleContext;
  readonly appThreadId: string;
  readonly providerThreadId: string;
  readonly providerThreadStatus: string;
  readonly activeProviderThreadId?: string | undefined;
  readonly activeKeys: ReadonlySet<string>;
  readonly pendingFinishGraceMs: number;
}): void {
  const {
    ctx,
    appThreadId,
    providerThreadId,
    providerThreadStatus,
    activeProviderThreadId,
    activeKeys,
    pendingFinishGraceMs,
  } = input;
  const isAuthoritativeForControlThread =
    AUTHORITATIVE_PROVIDER_THREAD_STATUSES.has(providerThreadStatus) &&
    (activeProviderThreadId === undefined || activeProviderThreadId === providerThreadId);

  for (const job of ctx.store.jobs.values()) {
    if (job.backing !== "pending-task" || isTerminalJobState(job.state)) continue;
    const belongs = isAuthoritativeForControlThread
      ? job.controlThreadId === appThreadId ||
        (job.providerThreadId !== undefined && job.providerThreadId === providerThreadId)
      : job.providerThreadId !== undefined
        ? job.providerThreadId === providerThreadId
        : job.controlThreadId === appThreadId;
    if (!belongs || !job.taskId) continue;

    const key = compositeJobKey(job.threadId, job.taskId);
    if (activeKeys.has(key)) {
      job.unverifiedShellShadow = undefined;
      job.providerOmittedWhileShadow = undefined;
      ctx.pendingFinishTimers.clear(job.id);
      continue;
    }
    // Defer closing an unverified degraded-startup shadow until the partial-hydration retry resolves it.
    if (job.unverifiedShellShadow) {
      job.providerOmittedWhileShadow = true;
      continue;
    }

    ctx.hydrationFence.recordSettledKey(job.threadId, job.taskId);
    if (job.state === "cancelling") {
      void finishBackgroundJob(ctx, job, "cancelled");
      continue;
    }
    ctx.pendingFinishTimers.schedule(job.id, pendingFinishGraceMs, () => {
      if (!ctx.isDisposed() && !isTerminalJobState(job.state)) {
        void finishBackgroundJob(ctx, job, job.state === "cancelling" ? "cancelled" : "exited");
      }
    });
  }
}
