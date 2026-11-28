// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - Unified in-process Jobs registry bridging Ship Queue, T3 native background commands, and live cerno processes.
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";

import { CommandId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as GitWorkflowService from "../../git/GitWorkflowService.ts";
import * as CommandOutputHub from "../../orchestration-v2/CommandOutputHub.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as KnownWorkspaces from "../../workspace/KnownWorkspaces.ts";
import { findBranchRestoreSource } from "../../workspace/restoreMissingWorktree.ts";
import { cancelShipQueueJob } from "../ShipQueueEventStream.ts";
import { BackgroundTaskBridge, type BackgroundTaskBridgeOptions } from "./BackgroundTaskBridge.ts";
import type { CommandExecutionTurnItem } from "./BackgroundTaskLifecycle.ts";
import { CernoVisibilityCoordinator, indexCernoCandidates } from "./cernoJobMatcher.ts";
import { CernoProcessBridge, type CernoProcessBridgeOptions } from "./CernoProcessBridge.ts";
import { JobEventBroadcaster } from "./JobEventStream.ts";
import {
  collectJobLoadTargets,
  JobProcessLoadTracker,
  keepUnreusedRoots,
  type ProcessTableRow,
} from "./jobProcessLoad.ts";
import { stripJobSummaryCmdline } from "./managedJobHelpers.ts";
import { ShipQueueBridge } from "./ShipQueueBridge.ts";
import {
  ShipQueueWorktreeDetacher,
  type ShipQueueWorktreeDetacherOptions,
} from "./ShipQueueWorktreeDetach.ts";
import type { JobDetail, JobSummary, JobsQueueMeta } from "./types.ts";

const SHIP_UNSUBSCRIBED_REFRESH_TTL_MS = 1_500;

export type BackgroundBridgeConfig = Omit<
  BackgroundTaskBridgeOptions,
  "localHostname" | "onMutated" | "onRemoved"
> & {
  readonly localHostname?: string | undefined;
};

export interface JobRegistryOptions {
  readonly enableShipBridge?: boolean | undefined;
  readonly enableCernoBridge?: boolean | undefined;
  readonly cernoBridge?: CernoProcessBridgeOptions | null | undefined;
  readonly backgroundBridge?: BackgroundBridgeConfig | null | undefined;
  readonly shipWorktreeDetacher?: ShipQueueWorktreeDetacherOptions | null | undefined;
}

export interface JobRegistryService {
  listJobs(filter?: {
    readonly threadId?: string | undefined;
    readonly includeShipJobs?: boolean | undefined;
    readonly state?: string | undefined;
    readonly kind?: string | undefined;
    readonly refresh?: boolean | undefined;
    readonly includeCmdline?: boolean | undefined;
  }): Promise<ReadonlyArray<JobSummary>>;
  getQueueMeta(): JobsQueueMeta;
  getJobDetail(id: string): Promise<JobDetail | null>;
  cancelJob(
    id: string,
    signal?: AbortSignal,
  ): Promise<{ readonly ok: boolean; readonly error?: string | undefined }>;
  createEventsStream(
    signal: AbortSignal,
    options?: { readonly includeCmdline?: boolean | undefined },
  ): ReadableStream<Uint8Array>;
  setDefaultStallMinutes(minutes: number): void;
  /** Feeds the host process table sampled by the Fleet sessions scan into live job loads. */
  /** Settles once the table's loads are applied; callers may ignore it. */
  applyProcessTable(rows: ReadonlyArray<ProcessTableRow>): Promise<void>;
  dispose(): Promise<void>;
}

export class JobRegistry extends Context.Service<JobRegistry, JobRegistryService>()(
  "t3/devtools/jobs/JobRegistry",
) {}

export function makeJobRegistry(options: JobRegistryOptions = {}): JobRegistryService {
  const loads = new JobProcessLoadTracker(() => Date.now());
  let processTableSeq = 0;
  const formatSummaryForScope = (summary: JobSummary, includeCmdline: boolean): JobSummary => {
    const withLoad = loads.attach(summary);
    return includeCmdline ? withLoad : stripJobSummaryCmdline(withLoad);
  };
  const shipJobs = new Map<string, JobSummary>();
  let queueMeta: JobsQueueMeta = {};
  let lastShipRefreshAtMs = 0;

  const worktreeDetacher = options.shipWorktreeDetacher
    ? new ShipQueueWorktreeDetacher(options.shipWorktreeDetacher)
    : null;

  const shipBridge =
    options.enableShipBridge === false
      ? null
      : new ShipQueueBridge((update) => {
          shipJobs.clear();
          for (const [id, summary] of update.jobs) shipJobs.set(id, summary);
          queueMeta = update.queueMeta;
          lastShipRefreshAtMs = Date.now();
          for (const id of update.changedIds) broadcaster.markDirty(id, true);
          for (const id of update.removedIds) broadcaster.markRemoved(id);
          if (update.queueMetaChanged) broadcaster.markMetaDirty();
          void worktreeDetacher?.handleUpdate(update);
        });

  const backgroundBridge = options.backgroundBridge
    ? new BackgroundTaskBridge({
        ...options.backgroundBridge,
        localHostname: options.backgroundBridge.localHostname ?? NodeOS.hostname(),
        hasShipJobId: (id) =>
          shipJobs.has(`ship:${id}`) || (options.backgroundBridge?.hasShipJobId?.(id) ?? false),
        onMutated: (jobId, urgent) => {
          const matchChanged =
            visibility !== null && (urgent || !visibility.hasBgCached(jobId))
              ? visibility.refreshBgEntry(jobId)
              : false;
          if (matchChanged) {
            visibility?.sync();
          }
          if (!visibility?.suppressedBgIds.has(jobId)) {
            broadcaster.markDirty(jobId, urgent);
          }
        },
        onRemoved: (jobId) => {
          visibility?.removeBgEntry(jobId);
          broadcaster.markRemoved(jobId);
          visibility?.sync();
        },
      })
    : null;

  const cernoHostname =
    options.cernoBridge?.localHostname ??
    options.backgroundBridge?.localHostname ??
    NodeOS.hostname();
  const cernoBridge =
    options.cernoBridge != null || options.enableCernoBridge === true
      ? new CernoProcessBridge({
          ...options.cernoBridge,
          localHostname: cernoHostname,
          isWorkspaceAllowed:
            options.cernoBridge?.isWorkspaceAllowed ?? options.backgroundBridge?.isWorkspaceAllowed,
          hasShipJobId: (id) =>
            shipJobs.has(`ship:${id}`) ||
            (options.cernoBridge?.hasShipJobId?.(id) ??
              options.backgroundBridge?.hasShipJobId?.(id) ??
              false),
          onChanged: (changedIds, removedIds) => {
            visibility?.sync(new Set(changedIds), removedIds);
          },
        })
      : null;

  const visibility = cernoBridge
    ? new CernoVisibilityCoordinator({
        listBgSummaries: () => backgroundBridge?.listSummaries() ?? [],
        getBgSummary: (id) => backgroundBridge?.getSummary(id),
        getBgDetail: (id) => backgroundBridge?.getDetail(id) ?? null,
        listCernoCandidates: () => cernoBridge.listMatchCandidates(),
        markDirty: (id, urgent) => broadcaster.markDirty(id, urgent),
        markRemoved: (id) => broadcaster.markRemoved(id),
      })
    : null;

  const readVisibleCernoSummaries = (includeCmdline: boolean): JobSummary[] => {
    if (!cernoBridge || !visibility) return [];
    const out: JobSummary[] = [];
    for (const id of visibility.visibleCernoIds) {
      const summary = cernoBridge.getSummary(id);
      if (summary) out.push(formatSummaryForScope(summary, includeCmdline));
    }
    return out;
  };

  const ensureLoaded = async (): Promise<void> => {
    if (backgroundBridge) {
      backgroundBridge.start();
      await backgroundBridge.ensureHydrated();
    }
    if (cernoBridge) {
      await cernoBridge.ensureFresh();
      visibility?.sync();
    }
  };

  const broadcaster = new JobEventBroadcaster({
    ensureLoaded,
    getInitialSnapshot: (includeCmdline) => {
      visibility?.sync();
      return {
        jobs: [
          ...(backgroundBridge
            ? backgroundBridge
                .listSummaries()
                .filter((s) => !visibility?.suppressedBgIds.has(s.id))
                .map((s) => formatSummaryForScope(s, includeCmdline))
            : []),
          ...readVisibleCernoSummaries(includeCmdline),
          ...shipJobs.values(),
        ],
        queueMeta,
      };
    },
    getSummaryById: (id, includeCmdline) => {
      if (visibility?.suppressedBgIds.has(id)) return undefined;
      const bg = backgroundBridge?.getSummary(id);
      if (bg) return formatSummaryForScope(bg, includeCmdline);
      if (id.startsWith("cerno:") && cernoBridge && visibility?.visibleCernoIds.has(id)) {
        const cerno = cernoBridge.getSummary(id);
        return cerno ? formatSummaryForScope(cerno, includeCmdline) : undefined;
      }
      return shipJobs.get(id);
    },
    getQueueMeta: () => queueMeta,
    onFirstSubscriber: () => {
      shipBridge?.start();
      backgroundBridge?.start();
      cernoBridge?.start();
    },
    onLastSubscriberGone: () => {
      shipBridge?.stop();
      cernoBridge?.stop();
      shipJobs.clear();
      queueMeta = {};
      lastShipRefreshAtMs = 0;
    },
  });

  if (backgroundBridge) {
    backgroundBridge.start();
  }

  return {
    async listJobs(filter) {
      await ensureLoaded();
      const now = Date.now();
      if (
        shipBridge &&
        (filter?.refresh ||
          (broadcaster.subscriberCount === 0 &&
            (shipJobs.size === 0 || now - lastShipRefreshAtMs >= SHIP_UNSUBSCRIBED_REFRESH_TTL_MS)))
      ) {
        await shipBridge.refresh(true);
        lastShipRefreshAtMs = Date.now();
      }
      if (cernoBridge && filter?.refresh) {
        await cernoBridge.refresh();
      }
      visibility?.sync();
      const includeCmdline = filter?.includeCmdline !== false;
      const out: JobSummary[] = [];
      if (backgroundBridge) {
        for (const summary of backgroundBridge.listSummaries()) {
          if (visibility?.suppressedBgIds.has(summary.id)) continue;
          if (filter?.threadId && summary.binding.threadId !== filter.threadId) continue;
          out.push(formatSummaryForScope(summary, includeCmdline));
        }
      }
      for (const summary of readVisibleCernoSummaries(includeCmdline)) {
        if (filter?.threadId && summary.binding.threadId !== filter.threadId) continue;
        out.push(summary);
      }
      for (const job of shipJobs.values()) {
        if (
          filter?.threadId &&
          !filter.includeShipJobs &&
          job.binding.threadId !== filter.threadId
        ) {
          continue;
        }
        out.push(job);
      }
      return out.filter((j) => {
        if (filter?.state && j.state !== filter.state) return false;
        if (filter?.kind && j.kind !== filter.kind) return false;
        return true;
      });
    },

    getQueueMeta() {
      return queueMeta;
    },

    async getJobDetail(id) {
      await ensureLoaded();
      if (id.startsWith("cerno:") && cernoBridge) {
        return visibility?.visibleCernoIds.has(id) ? cernoBridge.getDetail(id) : null;
      }
      if (visibility?.suppressedBgIds.has(id)) return null;
      const bgDetail = backgroundBridge?.getDetail(id) ?? null;
      if (bgDetail) {
        if (visibility && backgroundBridge) {
          const bgSummary = backgroundBridge.getSummary(id);
          const matched = bgSummary
            ? visibility.findLiveCernoForBg(bgSummary, bgDetail)
            : undefined;
          if (matched) {
            return {
              ...bgDetail,
              ...(matched.cerno ? { cerno: matched.cerno } : {}),
              ...(!bgDetail.pidStats && matched.pidStats ? { pidStats: matched.pidStats } : {}),
            };
          }
        }
        return bgDetail;
      }
      const ship = shipJobs.get(id);
      if (!ship) return null;
      return (
        shipBridge?.getDetail(ship) ?? {
          id: ship.id,
          revision: ship.revision,
          series: [],
          logTail: [],
        }
      );
    },

    async cancelJob(id, signal) {
      await ensureLoaded();
      if (id.startsWith("ship:")) {
        const num = id.slice("ship:".length);
        if (!/^[0-9]{1,16}$/.test(num)) return { ok: false, error: "Invalid Ship Queue job id" };
        const res = await cancelShipQueueJob(num, signal);
        return { ok: res.ok, ...(res.error ? { error: res.error } : {}) };
      }
      if (id.startsWith("cerno:")) {
        return cernoBridge && visibility?.visibleCernoIds.has(id)
          ? cernoBridge.cancelJob(id)
          : { ok: false, error: `Unknown job id "${id}"` };
      }
      if (backgroundBridge) {
        return backgroundBridge.cancelJob(id);
      }
      return { ok: false, error: `Unknown job id "${id}"` };
    },

    createEventsStream(signal, streamOptions) {
      return broadcaster.createStream(signal, streamOptions);
    },

    setDefaultStallMinutes(minutes: number) {
      backgroundBridge?.setDefaultStallMinutes(minutes);
    },

    async applyProcessTable(rows) {
      if (!cernoBridge) return;
      const seq = ++processTableSeq;
      await cernoBridge.ensureObservedTicksFresh();
      // A newer table supersedes this one while the cerno scan ran.
      if (seq !== processTableSeq) return;
      const candidates = indexCernoCandidates(cernoBridge.listMatchCandidates());
      const targets = collectJobLoadTargets({
        localHostname: cernoHostname,
        cernoSummaries: readVisibleCernoSummaries(true),
        backgroundSummaries: (backgroundBridge?.listSummaries() ?? []).filter(
          (s) => !visibility?.suppressedBgIds.has(s.id),
        ),
        rootForBackgroundJob: (id) => visibility?.liveCernoRootForBg(id, candidates),
      });
      const live = await keepUnreusedRoots(targets, (pid) => cernoBridge.observedStartTicks(pid));
      if (seq !== processTableSeq) return;
      // Non-urgent: load deltas ride the broadcaster's 1 s coalescing window.
      for (const id of loads.apply(rows, live)) broadcaster.markDirty(id, false);
    },

    async dispose() {
      shipBridge?.stop();
      worktreeDetacher?.dispose();
      cernoBridge?.dispose();
      broadcaster.closeAll();
      await backgroundBridge?.dispose();
    },
  };
}

export const layer = Layer.effect(
  JobRegistry,
  Effect.gen(function* () {
    const context = yield* Effect.context<never>();
    const runPromise = Effect.runPromiseWith(context);
    const knownWorkspaces = yield* KnownWorkspaces.KnownWorkspaces;
    const threadMgmt = yield* ThreadManagementService.ThreadManagementService;
    const commandOutputHub = yield* CommandOutputHub.CommandOutputHub;
    const projects = yield* ProjectService.ProjectService;
    const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
    const platform = yield* HostProcess.Platform;

    const isWorkspaceAllowed = (realPath: string) =>
      runPromise(knownWorkspaces.contains(realPath).pipe(Effect.orElseSucceed(() => false)));

    const registry = makeJobRegistry({
      enableShipBridge: true,
      cernoBridge: { platform, isWorkspaceAllowed },
      shipWorktreeDetacher: {
        findThreadsByWorktreePath: (worktreePath) =>
          runPromise(
            threadMgmt.getShellSnapshot({ worktreePath }).pipe(
              Effect.map((snapshot) => snapshot.threads),
              Effect.orElseSucceed(() => []),
            ),
          ),
        getThreadById: (threadId) =>
          runPromise(
            threadMgmt
              .getThreadShell(ThreadId.make(threadId))
              .pipe(Effect.orElseSucceed(() => null)),
          ),
        isBranchRemoved: ({ projectId, branch }) =>
          projectId
            ? runPromise(
                Effect.gen(function* () {
                  const project = Option.getOrUndefined(
                    yield* projects.getById(ProjectId.make(projectId)),
                  );
                  if (project === undefined) return false;
                  const source = yield* findBranchRestoreSource(
                    gitWorkflow,
                    project.workspaceRoot,
                    branch,
                  );
                  return source.kind === "missing";
                }).pipe(Effect.orElseSucceed(() => false)),
              )
            : Promise.resolve(false),
        detachThread: async ({ threadId, expectedWorktreePath, expectedBranch }) => {
          await runPromise(
            threadMgmt
              .dispatch({
                type: "thread.metadata.update",
                commandId: CommandId.make(`ship-queue-worktree-detach:${NodeCrypto.randomUUID()}`),
                threadId: ThreadId.make(threadId),
                worktreePath: null,
                branch: null,
                expectedWorktreePath,
                expectedBranch,
              })
              .pipe(Effect.ignore),
          );
        },
      },
      backgroundBridge: {
        isWorkspaceAllowed,
        getShellSnapshot: () => runPromise(threadMgmt.getShellSnapshot({ location: "active" })),
        getRunningCommandsForThread: (threadId) =>
          runPromise(
            threadMgmt
              .getThreadRecords(threadId, ["turnItems"], {
                turnItemTypes: ["command_execution"],
                turnItemStatuses: ["running", "waiting"],
              })
              .pipe(
                Effect.map((records) =>
                  records.turnItems.filter(
                    (item): item is CommandExecutionTurnItem => item.type === "command_execution",
                  ),
                ),
              ),
          ),
        streamDomainEvents: threadMgmt.streamDomainEvents,
        subscribeCommandOutput: (target) =>
          commandOutputHub.subscribe(target).pipe(Stream.catch(() => Stream.empty)),
        stopThread: async (threadId, reason) => {
          try {
            await runPromise(
              threadMgmt.dispatch({
                type: "thread.stop",
                commandId: CommandId.make(`devtools-job-stop:${NodeCrypto.randomUUID()}`),
                threadId: ThreadId.make(threadId),
                stopDelegatedTasks: false,
                reason,
              }),
            );
            return { ok: true };
          } catch (err) {
            return {
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            };
          }
        },
      },
    });
    yield* Effect.addFinalizer(() => Effect.promise(() => registry.dispose()));
    return registry;
  }),
);
