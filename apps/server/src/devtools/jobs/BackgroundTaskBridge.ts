// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - Reactive bridge projecting T3 native background commands into JobRegistry.
import {
  ThreadId,
  TurnItemId,
  type OrchestrationV2CommandOutputFrame,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2PendingBackgroundTask,
  type OrchestrationV2ThreadShellSnapshot,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type * as Stream from "effect/Stream";

import {
  attachJobStreamsIfNeeded,
  cleanupJobStreams,
  type JobStreamAttachmentHooks,
} from "./BackgroundJobOutput.ts";
import {
  BackgroundReconcileScheduler,
  forkDomainEventReconnectLoop,
} from "./BackgroundReconcileScheduler.ts";
import {
  applyRunningCommandUpdateToExisting,
  applyThreadLifecycleEvent,
  BackgroundHydrationFence,
  cancelBackgroundJobViaThreadStop,
  cancelThreadBackgroundJobs,
  finalizeTerminalCommandTurnItem,
  formatUtcIso,
  isTrackablePendingTask,
  JobStallMonitor,
  syncBackgroundStallTimer,
  updateActiveProviderThreadStatus,
  type BackgroundLifecycleContext,
  type CommandExecutionTurnItem,
} from "./BackgroundTaskLifecycle.ts";
import {
  hydrateAndReconcileSnapshot,
  reconcileMissingProviderTasks,
  reconcileTerminalRunCommands,
  type PendingDebounceEntry,
} from "./BackgroundTaskReconciler.ts";
import {
  classifyCommandTracking,
  deriveCommandTitle,
  inferCommandJobKind,
  makeBackgroundJobId,
} from "./commandJobParser.ts";
import { inferTargetHost, loadFleetHosts } from "./fleetHostInference.ts";
import {
  BackgroundJobIndex,
  buildJobDetail,
  buildJobSummary,
  compositeJobKey,
  createManagedJobRecord,
  DEFAULT_STALL_MINUTES,
  mergePendingTaskMetadata,
  nowMonotonicMs,
  ThreadScopedTimers,
  type ManagedJobRecord,
  type ThreadBindingMeta,
} from "./managedJobHelpers.ts";
import { isTerminalJobState, type JobDetail, type JobSummary } from "./types.ts";

export interface BackgroundTaskBridgeOptions {
  readonly localHostname: string;
  readonly ciHostsPath?: string | null | undefined;
  readonly commandDebounceMs?: number | undefined;
  readonly pendingFinishGraceMs?: number | undefined;
  readonly cancelTimeoutMs?: number | undefined;
  readonly streamReconnectDelayMs?: number | undefined;
  readonly stallCheckIntervalMs?: number | undefined;
  readonly stallReconcileCooldownMs?: number | undefined;
  readonly reconcileRetryBaseMs?: number | undefined;
  readonly getShellSnapshot: () => Promise<OrchestrationV2ThreadShellSnapshot>;
  readonly getRunningCommandsForThread: (
    threadId: ThreadId,
  ) => Promise<ReadonlyArray<CommandExecutionTurnItem>>;
  readonly streamDomainEvents: Stream.Stream<OrchestrationV2DomainEvent, unknown>;
  readonly subscribeCommandOutput: (target: {
    readonly threadId: ThreadId;
    readonly itemId: TurnItemId;
  }) => Stream.Stream<OrchestrationV2CommandOutputFrame, unknown>;
  readonly stopThread: (
    threadId: ThreadId,
    reason: string,
  ) => Promise<{ readonly ok: boolean; readonly error?: string | undefined }>;
  readonly isWorkspaceAllowed: (realPath: string) => Promise<boolean>;
  readonly hasShipJobId?: ((jobId: string) => boolean) | undefined;
  readonly onMutated: (jobId: string, urgent: boolean) => void;
  readonly onRemoved: (jobId: string) => void;
}

const DEFAULT_COMMAND_DEBOUNCE_MS = 8_000;
const DEFAULT_PENDING_FINISH_GRACE_MS = 250;
const DEFAULT_CANCEL_TIMEOUT_MS = 15_000;
const DEFAULT_STREAM_RECONNECT_MS = 2_000;
const DEFAULT_STALL_RECONCILE_COOLDOWN_MS = 60_000;
const DEFAULT_RECONCILE_RETRY_BASE_MS = 5_000;

export class BackgroundTaskBridge {
  private readonly opts: BackgroundTaskBridgeOptions;
  private readonly debounceMs: number;
  private readonly pendingFinishGraceMs: number;
  private readonly streamReconnectDelayMs: number;
  private readonly streamHooks: JobStreamAttachmentHooks;
  private readonly lifecycle: BackgroundLifecycleContext;
  private readonly reconciler: BackgroundReconcileScheduler;
  private readonly store = new BackgroundJobIndex();
  private readonly hydrationFence = new BackgroundHydrationFence();
  private readonly threadMeta = new Map<string, ThreadBindingMeta>();
  private readonly activeProviderThreads = new Map<string, string>();
  private readonly debounceTimers = new ThreadScopedTimers();
  private readonly debounceRunIds = new Map<string, PendingDebounceEntry>();
  private readonly pendingFinishTimers = new ThreadScopedTimers();
  private readonly cancelTimers = new ThreadScopedTimers();
  private readonly stallMonitor: JobStallMonitor;
  private eventFiber: Fiber.Fiber<void, unknown> | null = null;
  private defaultStallMinutes = DEFAULT_STALL_MINUTES;
  private started = false;
  private disposed = false;

  constructor(opts: BackgroundTaskBridgeOptions) {
    this.opts = opts;
    this.debounceMs = opts.commandDebounceMs ?? DEFAULT_COMMAND_DEBOUNCE_MS;
    this.pendingFinishGraceMs = opts.pendingFinishGraceMs ?? DEFAULT_PENDING_FINISH_GRACE_MS;
    this.streamReconnectDelayMs = opts.streamReconnectDelayMs ?? DEFAULT_STREAM_RECONNECT_MS;
    this.stallMonitor = new JobStallMonitor(opts.stallCheckIntervalMs);
    this.streamHooks = {
      localHostname: opts.localHostname,
      isDisposed: () => this.disposed,
      isWorkspaceAllowed: opts.isWorkspaceAllowed,
      subscribeCommandOutput: opts.subscribeCommandOutput,
      onJobUpdated: opts.onMutated,
    };
    this.lifecycle = {
      store: this.store,
      hydrationFence: this.hydrationFence,
      debounceTimers: this.debounceTimers,
      pendingFinishTimers: this.pendingFinishTimers,
      cancelTimers: this.cancelTimers,
      stallMonitor: this.stallMonitor,
      cancelTimeoutMs: opts.cancelTimeoutMs ?? DEFAULT_CANCEL_TIMEOUT_MS,
      isDisposed: () => this.disposed,
      getDefaultStallMinutes: () => this.defaultStallMinutes,
      stopThread: opts.stopThread,
      onMutated: opts.onMutated,
      onRemoved: opts.onRemoved,
      onStallDetected: () => this.reconciler.triggerStallReconcile(),
    };
    this.reconciler = new BackgroundReconcileScheduler({
      stallCooldownMs: opts.stallReconcileCooldownMs ?? DEFAULT_STALL_RECONCILE_COOLDOWN_MS,
      retryBaseMs: opts.reconcileRetryBaseMs ?? DEFAULT_RECONCILE_RETRY_BASE_MS,
      isDisposed: () => this.disposed,
      hydrationFence: this.hydrationFence,
      runSnapshot: (reconcile) =>
        hydrateAndReconcileSnapshot({
          ctx: this.lifecycle,
          threadMeta: this.threadMeta,
          activeProviderThreads: this.activeProviderThreads,
          debounceRunIds: this.debounceRunIds,
          reconcile,
          getShellSnapshot: this.opts.getShellSnapshot,
          getRunningCommandsForThread: this.opts.getRunningCommandsForThread,
          upsertPendingTask: (ownerId, ctrlId, ptId, task, iso, fromShell, cmdCheckFailed) =>
            this.upsertPendingTask(ownerId, ctrlId, ptId, task, iso, fromShell, cmdCheckFailed),
          handleCommandTurnItem: (item, isHydration) =>
            this.handleCommandTurnItem(item, isHydration),
        }),
    });
  }

  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    void this.ensureHydrated();
    this.eventFiber = forkDomainEventReconnectLoop({
      streamDomainEvents: this.opts.streamDomainEvents,
      reconnectDelayMs: this.streamReconnectDelayMs,
      isDisposed: () => this.disposed,
      onReconnect: () => this.reconciler.requestReconcile(),
      onEvent: (event) => this.handleDomainEvent(event),
    });
  }

  ensureHydrated(): Promise<void> {
    return this.reconciler.ensureHydrated();
  }

  listSummaries(): ReadonlyArray<JobSummary> {
    return [...this.store.jobs.values()].map(buildJobSummary);
  }
  getSummary(id: string): JobSummary | undefined {
    const rec = this.store.jobs.get(id);
    return rec ? buildJobSummary(rec) : undefined;
  }
  getDetail(id: string): JobDetail | null {
    const rec = this.store.jobs.get(id);
    return rec ? buildJobDetail(rec) : null;
  }
  setDefaultStallMinutes(minutes: number): void {
    if (Number.isFinite(minutes) && minutes >= 1 && minutes <= 240) {
      this.defaultStallMinutes = Math.round(minutes);
    }
  }

  cancelJob(id: string): Promise<{ readonly ok: boolean; readonly error?: string | undefined }> {
    return cancelBackgroundJobViaThreadStop(this.lifecycle, id);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.stallMonitor.stop();
    this.reconciler.dispose();
    this.debounceTimers.clearAll();
    this.debounceRunIds.clear();
    this.pendingFinishTimers.clearAll();
    this.cancelTimers.clearAll();
    const f = this.eventFiber;
    this.eventFiber = null;
    if (f) await Effect.runPromise(Fiber.interrupt(f)).catch(() => undefined);
    await Promise.all([...this.store.jobs.values()].map(cleanupJobStreams));
  }

  private handleDomainEvent(event: OrchestrationV2DomainEvent): void {
    switch (event.type) {
      case "thread.created":
      case "thread.metadata-updated":
      case "thread.archived":
      case "thread.deleted":
        applyThreadLifecycleEvent(
          this.lifecycle,
          this.threadMeta,
          this.activeProviderThreads,
          event.payload,
        );
        return;
      case "provider-thread.updated": {
        const pt = event.payload;
        this.syncProviderThreadTasks(
          pt.appThreadId ?? event.threadId,
          pt.id,
          pt.status,
          pt.pendingBackgroundTasks ?? [],
          formatUtcIso(event.occurredAt),
        );
        return;
      }
      case "run.updated":
        void reconcileTerminalRunCommands({
          ctx: this.lifecycle,
          run: event.payload,
          debounceRunIds: this.debounceRunIds,
          getRunningCommandsForThread: this.opts.getRunningCommandsForThread,
          onVerifiedLiveCommand: (item) => this.handleCommandTurnItem(item, true),
          onCommandCheckFailed: () => this.reconciler.scheduleRetryForPartial(),
        });
        return;
      case "run.background-work-cancelled":
        cancelThreadBackgroundJobs(this.lifecycle, event.threadId, "Background work stopped", true);
        return;
      case "turn-item.updated":
        if (event.payload.type === "command_execution") {
          this.handleCommandTurnItem(event.payload, false);
        }
        return;
      default:
        return;
    }
  }

  private syncProviderThreadTasks(
    appThreadId: string,
    providerThreadId: string,
    providerThreadStatus: string,
    tasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>,
    occurredAtIso: string,
  ): void {
    updateActiveProviderThreadStatus(
      this.activeProviderThreads,
      appThreadId,
      providerThreadId,
      providerThreadStatus,
    );
    const activeKeys = new Set<string>();
    for (const task of tasks) {
      if (!isTrackablePendingTask(task)) continue;
      const ownerThreadId = task.sourceThreadId ?? appThreadId;
      activeKeys.add(compositeJobKey(ownerThreadId, task.taskId));
      this.upsertPendingTask(ownerThreadId, appThreadId, providerThreadId, task, occurredAtIso);
    }
    this.hydrationFence.recordLiveProviderTasks(appThreadId, providerThreadId, activeKeys);
    reconcileMissingProviderTasks({
      ctx: this.lifecycle,
      appThreadId,
      providerThreadId,
      providerThreadStatus,
      activeProviderThreadId: this.activeProviderThreads.get(appThreadId),
      activeKeys,
      pendingFinishGraceMs: this.pendingFinishGraceMs,
    });
  }

  private resolveHost(command: string, description?: string): string {
    const hosts = loadFleetHosts(this.opts.localHostname, this.opts.ciHostsPath);
    return inferTargetHost(command, description, this.opts.localHostname, hosts);
  }

  private registerJob(record: ManagedJobRecord): void {
    this.store.put(record);
    attachJobStreamsIfNeeded(record, this.streamHooks);
    syncBackgroundStallTimer(this.lifecycle);
    this.opts.onMutated(record.id, true);
  }

  private upsertPendingTask(
    ownerThreadId: string,
    controlThreadId: string,
    providerThreadId: string | undefined,
    task: OrchestrationV2PendingBackgroundTask,
    startedAtIso: string,
    fromShellSnapshot = false,
    commandCheckFailed = false,
  ): void {
    const command = task.command ?? "";
    if (classifyCommandTracking(command, task.description, this.opts.hasShipJobId) === "skip") {
      return;
    }
    if (task.itemId) {
      const k = compositeJobKey(ownerThreadId, task.itemId);
      this.debounceTimers.clear(k);
      this.debounceRunIds.delete(k);
    }

    const existing = this.store.find(ownerThreadId, {
      taskId: task.taskId,
      itemId: task.itemId,
      nativeItemId: task.nativeItemId,
    });
    const host = this.resolveHost(command, task.description);
    const kind = inferCommandJobKind(command, task.description);
    const title = deriveCommandTitle(task.description, command);
    const isUnverifiedShadow =
      fromShellSnapshot && commandCheckFailed && !command && !task.itemId && !task.nativeItemId;

    if (existing && !isTerminalJobState(existing.state)) {
      this.pendingFinishTimers.clear(existing.id);
      if (!isUnverifiedShadow) {
        existing.unverifiedShellShadow = undefined;
        existing.providerOmittedWhileShadow = undefined;
      }
      const preserveCommandBacking =
        fromShellSnapshot &&
        existing.backing === "command-item" &&
        !command &&
        (task.taskId === existing.itemId ||
          (existing.nativeItemId !== undefined && task.taskId === existing.nativeItemId));
      const changed = mergePendingTaskMetadata(existing, {
        controlThreadId,
        providerThreadId,
        taskId: task.taskId,
        itemId: task.itemId,
        nativeItemId: task.nativeItemId,
        command,
        title,
        kind,
        host,
        localHostname: this.opts.localHostname,
        preserveCommandBacking,
      });
      this.store.reindex(existing);
      attachJobStreamsIfNeeded(existing, this.streamHooks);
      if (changed) {
        existing.revision += 1;
        this.opts.onMutated(existing.id, true);
      }
      return;
    }

    if (existing && existing.backing === "pending-task" && isTerminalJobState(existing.state)) {
      return;
    }

    let effectiveStartedAt = startedAtIso;
    if (existing && existing.backing === "command-item" && isTerminalJobState(existing.state)) {
      effectiveStartedAt = existing.startedAt;
      this.store.delete(existing);
      this.opts.onRemoved(existing.id);
    }

    this.registerJob(
      createManagedJobRecord({
        id: makeBackgroundJobId(ownerThreadId, task.taskId),
        threadId: ownerThreadId,
        controlThreadId,
        backing: "pending-task",
        providerThreadId,
        taskId: task.taskId,
        itemId: task.itemId,
        nativeItemId: task.nativeItemId,
        command,
        kind,
        title,
        host,
        startedAtIso: effectiveStartedAt,
        unverifiedShellShadow: isUnverifiedShadow,
        meta: this.threadMeta.get(ownerThreadId) ?? this.threadMeta.get(controlThreadId),
      }),
    );
  }

  private handleCommandTurnItem(item: CommandExecutionTurnItem, isHydration: boolean): void {
    const command = item.input ?? "";
    const description = item.title?.trim() || undefined;
    if (classifyCommandTracking(command, description, this.opts.hasShipJobId) === "skip") return;
    const iKey = compositeJobKey(item.threadId, item.id);
    const nativeId = item.nativeItemRef?.nativeId ?? undefined;
    const existing = this.store.find(item.threadId, { itemId: item.id, nativeItemId: nativeId });

    if (item.status === "running" || item.status === "waiting") {
      const observedAtMs = nowMonotonicMs();
      const startedAtIso = formatUtcIso(item.startedAt);
      const itemRunId = item.runId ?? undefined;
      if (existing) {
        if (!isTerminalJobState(existing.state)) {
          applyRunningCommandUpdateToExisting(existing, item, observedAtMs, startedAtIso);
          this.store.reindex(existing);
          attachJobStreamsIfNeeded(existing, this.streamHooks);
        }
        return;
      }
      const startedMs = Date.parse(startedAtIso);
      const existingDebounce = this.debounceRunIds.get(iKey);
      const runAlreadySettled = this.hydrationFence.isRunSettled(item.threadId, itemRunId);
      const promoteNow =
        isHydration ||
        runAlreadySettled ||
        classifyCommandTracking(command, description, this.opts.hasShipJobId) === "immediate" ||
        (Number.isFinite(startedMs) && Date.now() - startedMs >= this.debounceMs);
      const createNow = () => {
        this.registerJob(
          createManagedJobRecord({
            id: makeBackgroundJobId(item.threadId, item.id),
            threadId: item.threadId,
            backing: "command-item",
            runId: itemRunId,
            itemId: item.id,
            nativeItemId: nativeId,
            command,
            kind: inferCommandJobKind(command, description),
            title: deriveCommandTitle(description, command),
            host: this.resolveHost(command, description),
            startedAtIso,
            confirmedAtMs: observedAtMs,
            meta: this.threadMeta.get(item.threadId),
          }),
        );
      };
      if (promoteNow) {
        this.debounceTimers.clear(iKey);
        this.debounceRunIds.delete(iKey);
        createNow();
      } else {
        if (itemRunId) {
          this.debounceRunIds.set(iKey, {
            threadId: item.threadId,
            itemId: item.id,
            runId: itemRunId,
            verifiedLiveAfterRunEnd: existingDebounce?.verifiedLiveAfterRunEnd ?? false,
            deferredBySettledRun: existingDebounce?.deferredBySettledRun ?? false,
          });
        }
        this.debounceTimers.schedule(iKey, this.debounceMs, () => {
          const entry = this.debounceRunIds.get(iKey);
          if (
            this.hydrationFence.isRunSettled(item.threadId, itemRunId) &&
            !entry?.verifiedLiveAfterRunEnd
          ) {
            if (entry) entry.deferredBySettledRun = true;
            return;
          }
          this.debounceRunIds.delete(iKey);
          if (
            !this.disposed &&
            !this.store.find(item.threadId, { itemId: item.id, nativeItemId: nativeId })
          ) {
            createNow();
          }
        });
      }
      return;
    }

    this.debounceTimers.clear(iKey);
    this.debounceRunIds.delete(iKey);
    this.hydrationFence.recordSettledKey(item.threadId, item.id);
    finalizeTerminalCommandTurnItem(this.lifecycle, existing, item, nativeId);
  }
}
