/**
 * Ref-counted SSE store for Bounded Jobs (`/api/devtools/jobs/events`) with O(1) per-thread
 * subscriptions, legacy `/ship-queue/events` fallback, and throttled detail fetching.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import { msg } from "gt-react";

import { getClientSettings } from "../../hooks/useSettings";
import { m } from "~/i18n/messages";
import {
  hasDesktopNotifications,
  hasNotificationSound,
  playNotificationSound,
} from "../../threadNotifications";
import {
  buildDevtoolsStreamUrl,
  fetchDevtoolsJson,
  hasConnectedEnvironment,
  refreshDevtoolsStreamAccess,
  resolveDevtoolsStreamAccessAsync,
  subscribeEnvironmentConnected,
  type ShipQueueStatusPayload,
} from "../devtoolsClient";
import { forceReconnectMux, subscribeMuxTopic } from "../devtoolsEventMux";
import {
  deriveFetchResourceStatus,
  deriveStreamResourceStatus,
  type DevtoolsResourceStatus,
} from "../devtoolsState";
import { ensureCapabilities } from "../devtoolsStreams";
import {
  adaptLegacyShipQueuePayload,
  isJobLive,
  sidebarJobStatusLabel,
  type JobDetail,
  type JobSummary,
  type JobsQueueMeta,
} from "./jobTypes";

export interface SharedJobsSnapshot {
  readonly jobs: ReadonlyArray<JobSummary>;
  readonly jobsById: ReadonlyMap<string, JobSummary>;
  readonly queueMeta: JobsQueueMeta;
  readonly live: boolean;
  readonly error: string | null;
  readonly unsupported: boolean;
  readonly legacyFallback: boolean;
  readonly status: DevtoolsResourceStatus;
}

export type ThreadJobPhase = "deploying" | "hold" | "shipping" | "job";

export interface ThreadJobStatus {
  readonly jobId: string;
  readonly source: "ship-queue" | "background";
  readonly kind: string;
  readonly phase: ThreadJobPhase;
  readonly label: string;
  readonly startedAt: string | null;
  readonly hasProgress: boolean;
}

const EMPTY_SNAPSHOT: SharedJobsSnapshot = {
  jobs: [],
  jobsById: new Map(),
  queueMeta: {},
  live: false,
  error: null,
  unsupported: false,
  legacyFallback: false,
  status: "connecting",
};

const DEFAULT_BRANCHES = new Set(["main", "master", "develop", "HEAD"]);
const NOOP_SUBSCRIBE = () => () => {};
const EMPTY_GET = () => EMPTY_SNAPSHOT;
const NULL_GET = () => null;
const TEARDOWN_GRACE_MS = 2_000;
const DETAIL_THROTTLE_MS = 1_000;

function normPath(p: string | null | undefined): string {
  return p ? p.replace(/\/+$/, "") : "";
}

function baseName(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx === -1 ? p : p.slice(idx + 1);
}

export function matchJobToThread(
  job: JobSummary,
  threadId: string,
  branch: string | null,
  dedicatedWorktree: string,
  gitCwd: string,
): boolean {
  if (job.binding.threadId) return job.binding.threadId === threadId;
  if (
    dedicatedWorktree &&
    job.binding.worktreePath &&
    normPath(job.binding.worktreePath) === dedicatedWorktree
  ) {
    return true;
  }
  if (branch && !DEFAULT_BRANCHES.has(branch) && job.binding.branch === branch) {
    const jobPrimary = normPath(job.shipJob?.primary);
    if (jobPrimary && gitCwd) return jobPrimary === gitCwd;
    const hint = gitCwd
      ? baseName(gitCwd).toLowerCase()
      : dedicatedWorktree
        ? baseName(dedicatedWorktree).toLowerCase()
        : "";
    if (!hint) return true;
    const repo = (job.binding.repo ?? job.binding.project ?? "").toLowerCase();
    return repo === hint || repo.endsWith(`/${hint}`);
  }
  return false;
}

function resolveThreadJobStatusFromList(input: {
  readonly jobs: ReadonlyArray<JobSummary>;
  readonly threadId: string;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly gitCwd: string | null;
}): ThreadJobStatus | null {
  const wt = normPath(input.worktreePath);
  const cwd = normPath(input.gitCwd);
  let hold: JobSummary | null = null;
  let shipping: JobSummary | null = null;
  let managedBest: JobSummary | null = null;

  for (const job of input.jobs) {
    if (!isJobLive(job)) continue;
    if (!matchJobToThread(job, input.threadId, input.branch, wt, cwd)) continue;
    if (job.source === "ship-queue") {
      const phaseLower = job.phaseLabel.toLowerCase();
      const waitingFor = (job.shipJob?.waiting_for ?? "").trim().toLowerCase();
      if (phaseLower === "deploying") {
        return {
          jobId: job.id,
          source: "ship-queue",
          kind: job.kind,
          phase: "deploying",
          label: m(msg("Deploying")),
          startedAt: job.timing.startedAt || null,
          hasProgress: false,
        };
      }
      if (phaseLower === "on hold" || waitingFor === "challenge") {
        if (!hold) hold = job;
        continue;
      }
      if (!shipping) shipping = job;
    } else if (!managedBest || (job.anomaly && !managedBest.anomaly)) {
      managedBest = job;
    }
  }

  if (hold) {
    return {
      jobId: hold.id,
      source: "ship-queue",
      kind: hold.kind,
      phase: "hold",
      label: m(msg("On hold")),
      startedAt: hold.timing.startedAt || null,
      hasProgress: false,
    };
  }
  if (shipping) {
    return {
      jobId: shipping.id,
      source: "ship-queue",
      kind: shipping.kind,
      phase: "shipping",
      label: m(msg("Shipping")),
      startedAt: shipping.timing.startedAt || null,
      hasProgress: false,
    };
  }
  if (managedBest) {
    return {
      jobId: managedBest.id,
      source: managedBest.source,
      kind: managedBest.kind,
      phase: "job",
      label: sidebarJobStatusLabel(managedBest),
      startedAt: managedBest.timing.startedAt || null,
      hasProgress: Boolean(managedBest.progress),
    };
  }
  return null;
}

function encodeThreadJobStatus(status: ThreadJobStatus | null): string | null {
  if (!status) return null;
  return [
    status.jobId,
    status.source,
    status.kind,
    status.phase,
    status.label.replace(/\|/g, " "),
    status.startedAt ?? "",
    status.hasProgress ? "1" : "0",
  ].join("|");
}

function decodeThreadJobStatus(encoded: string | null): ThreadJobStatus | null {
  if (!encoded) return null;
  const parts = encoded.split("|");
  if (parts.length < 7) return null;
  return {
    jobId: parts[0]!,
    source: parts[1] === "ship-queue" ? "ship-queue" : "background",
    kind: parts[2]!,
    phase: parts[3] as ThreadJobPhase,
    label: parts[4]!,
    startedAt: parts[5] || null,
    hasProgress: parts[6] === "1",
  };
}

interface JobsChannel {
  readonly envId: EnvironmentId;
  readonly subscribeGlobal: (listener: () => void) => () => void;
  readonly getSnapshot: () => SharedJobsSnapshot;
  readonly jobsById: Map<string, JobSummary>;
  readonly globalListeners: Set<() => void>;
  readonly threadListeners: Map<string, Set<() => void>>;
  readonly worktreeListeners: Map<string, Set<() => void>>;
  readonly branchListeners: Map<string, Set<() => void>>;
  readonly jobIdListeners: Map<string, Set<() => void>>;
  readonly threadSubscribeCache: Map<
    string,
    { count: number; readonly subscribe: (listener: () => void) => () => void }
  >;
  readonly jobIdSubscribeCache: Map<
    string,
    { count: number; readonly subscribe: (listener: () => void) => () => void }
  >;
  snapshot: SharedJobsSnapshot;
  es: EventSource | null;
  muxUnsub: (() => void) | null;
  connecting: boolean;
  hasConnectedOnce: boolean;
  legacyFallback: boolean;
  retryTimer: ReturnType<typeof setTimeout> | null;
  teardownTimer: ReturnType<typeof setTimeout> | null;
  backoffMs: number;
  generation: number;
  unsubConn: (() => void) | null;
}

const channels = new Map<EnvironmentId, JobsChannel>();
const notifiedTransitions = new Set<string>();

function addIndexListener(map: Map<string, Set<() => void>>, key: string, fn: () => void): void {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  set.add(fn);
}

function removeIndexListener(map: Map<string, Set<() => void>>, key: string, fn: () => void): void {
  const set = map.get(key);
  if (!set) return;
  set.delete(fn);
  if (set.size === 0) map.delete(key);
}

function totalListeners(ch: JobsChannel): number {
  let n = ch.globalListeners.size;
  for (const s of ch.threadListeners.values()) n += s.size;
  for (const s of ch.worktreeListeners.values()) n += s.size;
  for (const s of ch.branchListeners.values()) n += s.size;
  for (const s of ch.jobIdListeners.values()) n += s.size;
  return n;
}

const STALL_ALERT_JOB_KINDS = new Set(["train", "render", "eval"]);
const METRIC_ALERT_JOB_KINDS = new Set(["train", "eval"]);

function hasObservableJobSignal(job: JobSummary): boolean {
  return job.logState === "attached" || job.hasMetrics === true || job.progress !== undefined;
}

function classifyJobAnomaly(
  anomaly: string | undefined,
): { readonly category: "stall" | "metric" | "other"; readonly tagSuffix: string } | null {
  if (!anomaly) return null;
  if (anomaly.startsWith("No output for ")) {
    return { category: "stall", tagSuffix: "stall" };
  }
  if (/=(?:nan|inf)$/i.test(anomaly)) {
    return { category: "metric", tagSuffix: "metric-anomaly" };
  }
  return { category: "other", tagSuffix: `anomaly:${anomaly}` };
}

function maybeNotifyUnfocusedJobEvent(prev: JobSummary | undefined, next: JobSummary): void {
  if (next.source === "ship-queue" || !isJobLive(next)) return;
  if (typeof document === "undefined" || (!document.hidden && document.hasFocus())) return;

  // Routine background commands (command/build/test/migrate) belong to the owning agent
  // thread, not directly to the user. Only alert unfocused users for long-running compute
  // jobs (train/render/eval) with an observable output signal, at most once per job per category.
  const nextKind = next.kind.toLowerCase();
  const nextAnomaly = classifyJobAnomaly(next.anomaly);
  if (!nextAnomaly) return;
  if (nextAnomaly.category === "metric") {
    if (!METRIC_ALERT_JOB_KINDS.has(nextKind) || next.hasMetrics !== true) return;
  } else if (!STALL_ALERT_JOB_KINDS.has(nextKind) || !hasObservableJobSignal(next)) {
    return;
  }

  const prevAnomaly = classifyJobAnomaly(prev?.anomaly);
  if (prevAnomaly?.tagSuffix === nextAnomaly.tagSuffix) return;

  const eventTag = `${next.id}:${nextAnomaly.tagSuffix}`;
  const body = `${next.title}: ${next.anomaly}`;
  if (notifiedTransitions.has(eventTag)) return;
  notifiedTransitions.add(eventTag);
  while (notifiedTransitions.size > 200) {
    const first = notifiedTransitions.values().next().value;
    if (first === undefined) break;
    notifiedTransitions.delete(first);
  }

  const { notificationMode } = getClientSettings();
  if (hasNotificationSound(notificationMode)) {
    void playNotificationSound("input", () =>
      hasNotificationSound(getClientSettings().notificationMode),
    );
  }
  if (
    hasDesktopNotifications(notificationMode) &&
    typeof Notification !== "undefined" &&
    Notification.permission === "granted"
  ) {
    try {
      const notification = new Notification(next.title, {
        body,
        tag: eventTag,
        silent: true,
      });
      void notification;
    } catch {
      // ignore desktop notification failure
    }
  }
}

function collectTargetedListeners(
  ch: JobsChannel,
  jobs: ReadonlyArray<JobSummary | undefined>,
): Set<() => void> {
  const targets = new Set<() => void>();
  for (const job of jobs) {
    if (!job) continue;
    const byId = ch.jobIdListeners.get(job.id);
    if (byId) for (const fn of byId) targets.add(fn);
    if (job.binding.threadId) {
      const s = ch.threadListeners.get(job.binding.threadId);
      if (s) for (const fn of s) targets.add(fn);
    }
    const wt = normPath(job.binding.worktreePath);
    if (wt) {
      const s = ch.worktreeListeners.get(wt);
      if (s) for (const fn of s) targets.add(fn);
    }
    if (job.binding.branch && !DEFAULT_BRANCHES.has(job.binding.branch)) {
      const s = ch.branchListeners.get(job.binding.branch);
      if (s) for (const fn of s) targets.add(fn);
    }
  }
  return targets;
}

function withJobsStatus(
  snap: Omit<SharedJobsSnapshot, "status">,
  hasConnectedOnce: boolean,
): SharedJobsSnapshot {
  return {
    ...snap,
    status: deriveStreamResourceStatus({
      unsupported: snap.unsupported,
      live: snap.live,
      hasData: hasConnectedOnce || snap.jobs.length > 0,
      error: snap.error,
    }),
  };
}

function patchGlobalSnapshot(
  ch: JobsChannel,
  patch: Partial<Omit<SharedJobsSnapshot, "status">>,
): void {
  ch.snapshot = withJobsStatus({ ...ch.snapshot, ...patch }, ch.hasConnectedOnce);
  for (const fn of ch.globalListeners) fn();
}

function rebuildSnapshot(
  ch: JobsChannel,
  patch?: Partial<Omit<SharedJobsSnapshot, "status">>,
): void {
  ch.snapshot = withJobsStatus(
    {
      ...ch.snapshot,
      ...patch,
      jobs: [...ch.jobsById.values()],
      jobsById: new Map(ch.jobsById),
    },
    ch.hasConnectedOnce || ch.jobsById.size > 0,
  );
}

function notifyAllListeners(ch: JobsChannel): void {
  const all = new Set<() => void>(ch.globalListeners);
  for (const s of ch.threadListeners.values()) for (const fn of s) all.add(fn);
  for (const s of ch.worktreeListeners.values()) for (const fn of s) all.add(fn);
  for (const s of ch.branchListeners.values()) for (const fn of s) all.add(fn);
  for (const s of ch.jobIdListeners.values()) for (const fn of s) all.add(fn);
  for (const fn of all) fn();
}

function notifyScoped(ch: JobsChannel, affected: ReadonlyArray<JobSummary | undefined>): void {
  for (const fn of ch.globalListeners) fn();
  for (const fn of collectTargetedListeners(ch, affected)) fn();
}

export function applyJobsStreamEvent(
  envId: EnvironmentId,
  eventType: "snapshot" | "upsert" | "remove" | "meta",
  payload: unknown,
  options?: { readonly markLive?: boolean },
): void {
  const ch = getOrCreateChannel(envId);
  const markLive = options?.markLive !== false;
  if (eventType === "snapshot" && payload && typeof payload === "object") {
    const data = payload as {
      readonly jobs?: ReadonlyArray<JobSummary>;
      readonly queueMeta?: JobsQueueMeta;
    };
    const prevById = ch.snapshot.live && !markLive ? new Map(ch.jobsById) : null;
    ch.jobsById.clear();
    for (const j of data.jobs ?? []) {
      if (j && typeof j.id === "string") {
        const existing = prevById?.get(j.id);
        ch.jobsById.set(j.id, existing && existing.revision > j.revision ? existing : j);
      }
    }
    if (markLive) ch.hasConnectedOnce = true;
    rebuildSnapshot(ch, {
      queueMeta: data.queueMeta ?? ch.snapshot.queueMeta,
      ...(markLive ? { live: true, error: null } : {}),
      unsupported: false,
      legacyFallback: ch.legacyFallback,
    });
    notifyAllListeners(ch);
    return;
  }
  if (eventType === "upsert" && payload && typeof payload === "object") {
    const next = payload as JobSummary;
    if (!next.id) return;
    const prev = ch.jobsById.get(next.id);
    ch.jobsById.set(next.id, next);
    rebuildSnapshot(ch, { live: true, error: null });
    notifyScoped(ch, [prev, next]);
    maybeNotifyUnfocusedJobEvent(prev, next);
    return;
  }
  if (eventType === "remove" && payload && typeof payload === "object") {
    const id = (payload as { readonly id?: unknown }).id;
    if (typeof id !== "string") return;
    const prev = ch.jobsById.get(id);
    if (!prev) return;
    ch.jobsById.delete(id);
    rebuildSnapshot(ch);
    notifyScoped(ch, [prev]);
    return;
  }
  if (eventType === "meta" && payload && typeof payload === "object") {
    patchGlobalSnapshot(ch, { queueMeta: payload as JobsQueueMeta });
  }
}

function closeConn(ch: JobsChannel): void {
  ch.generation += 1;
  ch.connecting = false;
  if (ch.retryTimer !== null) {
    clearTimeout(ch.retryTimer);
    ch.retryTimer = null;
  }
  if (ch.es) {
    ch.es.close();
    ch.es = null;
  }
  if (ch.muxUnsub) {
    ch.muxUnsub();
    ch.muxUnsub = null;
  }
}

function connectChannel(ch: JobsChannel): void {
  if (totalListeners(ch) === 0) return;
  if (!ch.unsubConn) {
    ch.unsubConn = subscribeEnvironmentConnected(ch.envId, (connected) => {
      if (connected) {
        if (!ch.es && !ch.muxUnsub && !ch.connecting && totalListeners(ch) > 0) {
          ch.backoffMs = 1_500;
          connectChannel(ch);
        }
      } else {
        closeConn(ch);
        const offlineMsg = ch.hasConnectedOnce
          ? m(msg("Environment is offline or disconnected"))
          : null;
        if (ch.snapshot.live || ch.snapshot.error !== offlineMsg) {
          patchGlobalSnapshot(ch, { live: false, error: offlineMsg });
        }
      }
    });
  }
  if (!hasConnectedEnvironment(ch.envId)) {
    const offlineMsg = ch.hasConnectedOnce
      ? m(msg("Environment is offline or disconnected"))
      : null;
    if (ch.snapshot.live || ch.snapshot.error !== offlineMsg) {
      patchGlobalSnapshot(ch, { live: false, error: offlineMsg });
    }
    return;
  }
  closeConn(ch);
  ch.connecting = true;
  const gen = ch.generation;

  void ensureCapabilities(ch.envId).then((caps) => {
    if (ch.generation !== gen || totalListeners(ch) === 0) {
      ch.connecting = false;
      return;
    }
    if (caps.unsupported) {
      ch.connecting = false;
      patchGlobalSnapshot(ch, { live: false, unsupported: true });
      return;
    }

    if (!ch.legacyFallback && caps.capabilities?.multiplexedEvents === true) {
      ch.connecting = false;
      ch.muxUnsub = subscribeMuxTopic(ch.envId, "jobs", {
        onOpen: () => {
          if (ch.generation !== gen) return;
          ch.hasConnectedOnce = true;
          ch.backoffMs = 1_500;
          if (ch.retryTimer !== null) {
            clearTimeout(ch.retryTimer);
            ch.retryTimer = null;
          }
          if (!ch.snapshot.live || ch.snapshot.error !== null) {
            patchGlobalSnapshot(ch, { live: true, error: null, legacyFallback: false });
          }
        },
        onEvent: (eventName, rawData) => {
          if (ch.generation !== gen) return;
          if (eventName === "unavailable") {
            patchGlobalSnapshot(ch, {
              live: false,
              error: m(msg("Jobs stream disconnected")),
            });
            if (ch.retryTimer === null) {
              ch.retryTimer = setTimeout(() => {
                ch.retryTimer = null;
                if (ch.generation === gen && totalListeners(ch) > 0) {
                  forceReconnectMux(ch.envId);
                }
              }, 5_000);
            }
            return;
          }
          if (
            eventName !== "snapshot" &&
            eventName !== "upsert" &&
            eventName !== "remove" &&
            eventName !== "meta"
          ) {
            return;
          }
          try {
            applyJobsStreamEvent(ch.envId, eventName, JSON.parse(rawData) as unknown);
          } catch {
            // ignore malformed frame
          }
        },
        onError: () => {
          if (ch.generation !== gen) return;
          if (ch.snapshot.live) {
            patchGlobalSnapshot(ch, { live: false });
          }
        },
        onFallbackNeeded: () => {
          if (ch.generation !== gen) return;
          closeConn(ch);
          void ensureCapabilities(ch.envId, true).then((probe) => {
            if (totalListeners(ch) === 0) return;
            if (probe.unsupported) {
              patchGlobalSnapshot(ch, { live: false, unsupported: true });
              return;
            }
            connectChannel(ch);
          });
        },
      });
      return;
    }

    void resolveDevtoolsStreamAccessAsync(ch.envId).then((access) => {
      if (ch.generation !== gen || totalListeners(ch) === 0) {
        ch.connecting = false;
        return;
      }
      if (!access) {
        ch.connecting = false;
        refreshDevtoolsStreamAccess(ch.envId);
        ch.retryTimer = setTimeout(() => {
          ch.retryTimer = null;
          ch.backoffMs = Math.min(30_000, Math.round(ch.backoffMs * 1.8));
          connectChannel(ch);
        }, ch.backoffMs);
        return;
      }

      const streamPath = ch.legacyFallback ? "/ship-queue/events" : "/jobs/events";
      const es = new EventSource(buildDevtoolsStreamUrl(access, streamPath), {
        withCredentials: access.credentials,
      });
      ch.es = es;
      ch.connecting = false;

      es.onopen = () => {
        if (ch.generation !== gen) return;
        ch.hasConnectedOnce = true;
        ch.backoffMs = 1_500;
        if (!ch.snapshot.live || ch.snapshot.error !== null) {
          patchGlobalSnapshot(ch, {
            live: true,
            error: null,
            legacyFallback: ch.legacyFallback,
          });
        }
      };

      const bindJson = (event: "snapshot" | "upsert" | "remove" | "meta") => {
        es.addEventListener(event, ((ev: MessageEvent<string>) => {
          if (ch.generation !== gen) return;
          try {
            const parsed = JSON.parse(ev.data) as unknown;
            if (ch.legacyFallback && event === "snapshot") {
              const adapted = adaptLegacyShipQueuePayload(parsed as ShipQueueStatusPayload);
              applyJobsStreamEvent(ch.envId, "snapshot", adapted);
            } else {
              applyJobsStreamEvent(ch.envId, event, parsed);
            }
          } catch {
            // ignore malformed frame
          }
        }) as EventListener);
      };

      bindJson("snapshot");
      if (!ch.legacyFallback) {
        bindJson("upsert");
        bindJson("remove");
        bindJson("meta");
      } else {
        es.addEventListener("unavailable", ((ev: MessageEvent<string>) => {
          if (ch.generation !== gen) return;
          closeConn(ch);
          let errMsg = m(msg("ship-queue unavailable"));
          try {
            const parsed = JSON.parse(ev.data) as { error?: string };
            if (parsed.error) errMsg = parsed.error;
          } catch {
            // use default message
          }
          patchGlobalSnapshot(ch, { live: false, error: errMsg });
          ch.retryTimer = setTimeout(() => {
            ch.retryTimer = null;
            connectChannel(ch);
          }, 30_000);
        }) as EventListener);
      }

      es.onerror = () => {
        if (ch.generation !== gen) return;
        closeConn(ch);
        const errGen = ch.generation;
        if (ch.snapshot.live) {
          patchGlobalSnapshot(ch, { live: false });
        }

        const scheduleRetry = () => {
          if (ch.generation !== errGen || totalListeners(ch) === 0) return;
          if (!access.credentials) refreshDevtoolsStreamAccess(ch.envId);
          ch.retryTimer = setTimeout(() => {
            ch.retryTimer = null;
            ch.backoffMs = Math.min(30_000, Math.round(ch.backoffMs * 1.8));
            connectChannel(ch);
          }, ch.backoffMs);
        };

        if (!ch.legacyFallback && !ch.hasConnectedOnce) {
          // Probe /jobs once to detect older linked peers that only serve /ship-queue/events.
          void fetchDevtoolsJson<{ jobs?: unknown }>(ch.envId, "/jobs").then((res) => {
            if (ch.generation !== errGen || totalListeners(ch) === 0) return;
            if (res.status === 404) {
              ch.legacyFallback = true;
              ch.backoffMs = 1_500;
              connectChannel(ch);
              return;
            }
            scheduleRetry();
          });
          return;
        }
        scheduleRetry();
      };
    });
  });
}

function getOrCreateChannel(envId: EnvironmentId): JobsChannel {
  let ch = channels.get(envId);
  if (!ch) {
    const channel: JobsChannel = {
      envId,
      jobsById: new Map(),
      globalListeners: new Set(),
      threadListeners: new Map(),
      worktreeListeners: new Map(),
      branchListeners: new Map(),
      jobIdListeners: new Map(),
      threadSubscribeCache: new Map(),
      jobIdSubscribeCache: new Map(),
      snapshot: EMPTY_SNAPSHOT,
      es: null,
      muxUnsub: null,
      connecting: false,
      hasConnectedOnce: false,
      legacyFallback: false,
      retryTimer: null,
      teardownTimer: null,
      backoffMs: 1_500,
      generation: 0,
      unsubConn: null,
      getSnapshot: () => channel.snapshot,
      subscribeGlobal: (listener) => {
        channel.globalListeners.add(listener);
        retainChannel(channel);
        return () => {
          channel.globalListeners.delete(listener);
          releaseChannel(channel);
        };
      },
    };
    ch = channel;
    channels.set(envId, ch);
  }
  return ch;
}

function retainChannel(ch: JobsChannel): void {
  if (ch.teardownTimer !== null) {
    clearTimeout(ch.teardownTimer);
    ch.teardownTimer = null;
  }
  if (!ch.es && !ch.muxUnsub && !ch.connecting && ch.retryTimer === null) {
    connectChannel(ch);
  }
}

function releaseChannel(ch: JobsChannel): void {
  if (totalListeners(ch) > 0) return;
  if (ch.teardownTimer !== null) return;
  ch.teardownTimer = setTimeout(() => {
    ch.teardownTimer = null;
    if (totalListeners(ch) === 0) {
      closeConn(ch);
      if (ch.unsubConn) {
        ch.unsubConn();
        ch.unsubConn = null;
      }
    }
  }, TEARDOWN_GRACE_MS);
}

export function useSharedJobs(environmentId: EnvironmentId | null): SharedJobsSnapshot {
  const ch = environmentId ? getOrCreateChannel(environmentId) : null;
  return useSyncExternalStore(
    ch ? ch.subscribeGlobal : NOOP_SUBSCRIBE,
    ch ? ch.getSnapshot : EMPTY_GET,
    EMPTY_GET,
  );
}

export async function refreshSharedJobs(
  envId: EnvironmentId,
): Promise<{ readonly ok: boolean; readonly error?: string | undefined }> {
  const ch = getOrCreateChannel(envId);
  if (ch.legacyFallback) {
    const res = await fetchDevtoolsJson<{
      readonly ok?: boolean;
      readonly data?: ShipQueueStatusPayload | null;
      readonly error?: string;
    }>(envId, "/ship-queue/status");
    if (res.ok && res.data?.data) {
      applyJobsStreamEvent(envId, "snapshot", adaptLegacyShipQueuePayload(res.data.data), {
        markLive: false,
      });
      return { ok: true };
    }
    const errMsg = res.data?.error ?? res.error ?? m(msg("ship-queue unavailable"));
    patchGlobalSnapshot(ch, { error: errMsg });
    return { ok: false, error: errMsg };
  }
  const res = await fetchDevtoolsJson<{
    readonly jobs?: ReadonlyArray<JobSummary>;
    readonly queueMeta?: JobsQueueMeta;
    readonly error?: string;
  }>(envId, "/jobs?refresh=1");
  if (res.ok && res.data?.jobs) {
    applyJobsStreamEvent(
      envId,
      "snapshot",
      { jobs: res.data.jobs, ...(res.data.queueMeta ? { queueMeta: res.data.queueMeta } : {}) },
      { markLive: false },
    );
    if (res.data.queueMeta?.error) {
      return { ok: false, error: res.data.queueMeta.error };
    }
    return { ok: true };
  }
  if (res.status === 404) {
    ch.legacyFallback = true;
    return refreshSharedJobs(envId);
  }
  const errMsg = res.data?.error ?? res.error ?? m(msg("Failed to refresh jobs"));
  return { ok: false, error: errMsg };
}

export async function cancelTrackedJob(
  envId: EnvironmentId,
  jobId: string,
): Promise<{ readonly ok: boolean; readonly error?: string | undefined }> {
  const ch = channels.get(envId);
  if (ch?.legacyFallback && jobId.startsWith("ship:")) {
    const num = jobId.slice("ship:".length);
    const res = await fetchDevtoolsJson<{ ok: boolean; error?: string }>(
      envId,
      `/ship-queue/jobs/${encodeURIComponent(num)}/cancel`,
      { method: "POST" },
    );
    const err = res.data?.error ?? res.error;
    return { ok: res.ok, ...(err ? { error: err } : {}) };
  }
  const res = await fetchDevtoolsJson<{ ok: boolean; error?: string }>(
    envId,
    `/jobs/${encodeURIComponent(jobId)}/cancel`,
    { method: "POST" },
  );
  const err = res.data?.error ?? res.error;
  return { ok: res.ok, ...(err ? { error: err } : {}) };
}

function getCachedThreadSubscribe(
  ch: JobsChannel,
  threadId: string,
  wt: string,
  branchKey: string,
): (listener: () => void) => () => void {
  const cacheKey = `${threadId}\0${wt}\0${branchKey}`;
  const existing = ch.threadSubscribeCache.get(cacheKey);
  if (existing) return existing.subscribe;
  const entry = {
    count: 0,
    subscribe: (listener: () => void) => {
      entry.count += 1;
      if (ch.threadSubscribeCache.get(cacheKey) !== entry) {
        ch.threadSubscribeCache.set(cacheKey, entry);
      }
      addIndexListener(ch.threadListeners, threadId, listener);
      if (wt) addIndexListener(ch.worktreeListeners, wt, listener);
      if (branchKey) addIndexListener(ch.branchListeners, branchKey, listener);
      retainChannel(ch);
      return () => {
        removeIndexListener(ch.threadListeners, threadId, listener);
        if (wt) removeIndexListener(ch.worktreeListeners, wt, listener);
        if (branchKey) removeIndexListener(ch.branchListeners, branchKey, listener);
        entry.count = Math.max(0, entry.count - 1);
        if (entry.count === 0 && ch.threadSubscribeCache.get(cacheKey) === entry) {
          ch.threadSubscribeCache.delete(cacheKey);
        }
        releaseChannel(ch);
      };
    },
  };
  ch.threadSubscribeCache.set(cacheKey, entry);
  return entry.subscribe;
}

function getCachedJobIdSubscribe(
  ch: JobsChannel,
  jobId: string,
): (listener: () => void) => () => void {
  const existing = ch.jobIdSubscribeCache.get(jobId);
  if (existing) return existing.subscribe;
  const entry = {
    count: 0,
    subscribe: (listener: () => void) => {
      entry.count += 1;
      if (ch.jobIdSubscribeCache.get(jobId) !== entry) {
        ch.jobIdSubscribeCache.set(jobId, entry);
      }
      addIndexListener(ch.jobIdListeners, jobId, listener);
      retainChannel(ch);
      return () => {
        removeIndexListener(ch.jobIdListeners, jobId, listener);
        entry.count = Math.max(0, entry.count - 1);
        if (entry.count === 0 && ch.jobIdSubscribeCache.get(jobId) === entry) {
          ch.jobIdSubscribeCache.delete(jobId);
        }
        releaseChannel(ch);
      };
    },
  };
  ch.jobIdSubscribeCache.set(jobId, entry);
  return entry.subscribe;
}

/** O(1) targeted subscription for a single sidebar thread row. */
export function useThreadJobStatus(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: string;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly gitCwd: string | null;
  readonly enabled?: boolean;
}): ThreadJobStatus | null {
  const ch = input.enabled === false ? null : getOrCreateChannel(input.environmentId);
  const wt = normPath(input.worktreePath);
  const branchKey = input.branch && !DEFAULT_BRANCHES.has(input.branch) ? input.branch : "";

  const encoded = useSyncExternalStore(
    ch ? getCachedThreadSubscribe(ch, input.threadId, wt, branchKey) : NOOP_SUBSCRIBE,
    ch
      ? () =>
          encodeThreadJobStatus(
            resolveThreadJobStatusFromList({
              jobs: ch.snapshot.jobs,
              threadId: input.threadId,
              branch: input.branch,
              worktreePath: input.worktreePath,
              gitCwd: input.gitCwd,
            }),
          )
      : NULL_GET,
    NULL_GET,
  );
  return decodeThreadJobStatus(encoded);
}

/** Leaf-level subscription to a single job's integer percentage so the sidebar row never re-renders on ticks. */
export function useJobProgressPercent(
  environmentId: EnvironmentId | null,
  jobId: string | null,
): number | null {
  const ch = environmentId && jobId ? getOrCreateChannel(environmentId) : null;
  return useSyncExternalStore(
    ch && jobId ? getCachedJobIdSubscribe(ch, jobId) : NOOP_SUBSCRIBE,
    ch && jobId
      ? () => {
          const p = ch.jobsById.get(jobId)?.progress;
          return p ? Math.round(p.fraction * 100) : null;
        }
      : NULL_GET,
    NULL_GET,
  );
}

/** Fetches full job detail on selection & revision bumps without aborting/starving slow in-flight requests. */
export function useJobDetail(
  environmentId: EnvironmentId | null,
  jobId: string | null,
  revision: number,
): {
  readonly detail: JobDetail | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly status: DevtoolsResourceStatus;
  readonly retry: () => void;
} {
  const [retryTick, setRetryTick] = useState(0);
  const [state, setState] = useState<{
    readonly key: string;
    readonly detail: JobDetail | null;
    readonly loading: boolean;
    readonly error: string | null;
  }>({ key: "", detail: null, loading: false, error: null });
  const key = environmentId && jobId ? `${environmentId}:${jobId}` : "";
  const reqStateRef = useRef<{
    key: string;
    inFlight: boolean;
    pending: boolean;
    lastRetryTick: number;
    lastStartedAt: number;
    controller: AbortController | null;
    timer: ReturnType<typeof setTimeout> | null;
  }>({
    key: "",
    inFlight: false,
    pending: false,
    lastRetryTick: 0,
    lastStartedAt: 0,
    controller: null,
    timer: null,
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- aborts in-flight detail request on unmount
  useEffect(() => {
    const rs = reqStateRef.current;
    return () => {
      if (rs.timer !== null) {
        clearTimeout(rs.timer);
        rs.timer = null;
      }
      if (rs.controller) {
        rs.controller.abort();
        rs.controller = null;
      }
      rs.inFlight = false;
      rs.pending = false;
    };
  }, []);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- schedules throttled detail fetches without discarding slow in-flight responses
  useEffect(() => {
    if (!environmentId || !jobId || revision < 0) return;
    const rs = reqStateRef.current;

    const triggerFetch = () => {
      if (rs.inFlight) {
        rs.pending = true;
        return;
      }
      rs.inFlight = true;
      rs.pending = false;
      rs.lastStartedAt = Date.now();
      const controller = new AbortController();
      rs.controller = controller;
      const targetKey = key;

      void fetchDevtoolsJson<JobDetail>(environmentId, `/jobs/${encodeURIComponent(jobId)}`, {
        signal: controller.signal,
      }).then((res) => {
        if (controller.signal.aborted || rs.key !== targetKey) return;
        rs.inFlight = false;
        rs.controller = null;
        if (res.ok && res.data) {
          setState({ key: targetKey, detail: res.data, loading: false, error: null });
        } else {
          setState((prev) => ({
            key: targetKey,
            detail: prev.key === targetKey ? prev.detail : null,
            loading: false,
            error: res.error ?? m(msg("Unable to load job details")),
          }));
        }
        if (rs.pending) {
          rs.pending = false;
          const waitMs = Math.max(0, DETAIL_THROTTLE_MS - (Date.now() - rs.lastStartedAt));
          if (waitMs === 0) {
            triggerFetch();
          } else if (rs.timer === null) {
            rs.timer = setTimeout(() => {
              rs.timer = null;
              if (rs.key === targetKey) triggerFetch();
            }, waitMs);
          }
        }
      });
    };

    const isNewKey = rs.key !== key;
    if (isNewKey) {
      if (rs.timer !== null) {
        clearTimeout(rs.timer);
        rs.timer = null;
      }
      if (rs.controller) {
        rs.controller.abort();
        rs.controller = null;
      }
      rs.key = key;
      rs.inFlight = false;
      rs.pending = false;
      setState({ key, detail: null, loading: true, error: null });
      triggerFetch();
      return;
    }

    const forceNext = rs.lastRetryTick !== retryTick;
    rs.lastRetryTick = retryTick;
    if (rs.inFlight) {
      rs.pending = true;
      return;
    }
    const elapsed = Date.now() - rs.lastStartedAt;
    if (elapsed >= DETAIL_THROTTLE_MS || forceNext) {
      triggerFetch();
    } else if (rs.timer === null) {
      rs.timer = setTimeout(() => {
        rs.timer = null;
        if (rs.key === key) triggerFetch();
      }, DETAIL_THROTTLE_MS - elapsed);
    }
  }, [environmentId, jobId, key, revision, retryTick]);

  const retry = () => {
    setState((prev) => ({ ...prev, loading: true, error: null }));
    setRetryTick((t) => t + 1);
  };

  if (!key || state.key !== key) {
    const loading = Boolean(key);
    return {
      detail: null,
      loading,
      error: null,
      status: deriveFetchResourceStatus({ loading, hasData: false, error: null }),
      retry,
    };
  }
  return {
    detail: state.detail,
    loading: state.loading,
    error: state.error,
    status: deriveFetchResourceStatus({
      loading: state.loading,
      hasData: state.detail !== null,
      error: state.error,
    }),
    retry,
  };
}

export function _resetJobsStoreForTests(): void {
  for (const ch of channels.values()) {
    closeConn(ch);
    if (ch.teardownTimer !== null) clearTimeout(ch.teardownTimer);
    if (ch.unsubConn) ch.unsubConn();
  }
  channels.clear();
  notifiedTransitions.clear();
}
