/**
 * Fleet-wide background watcher for thread-attributed DevTools approvals (Host Guard overrides
 * and blocking Ship Queue dependency holds). Streams guard SSE events into `devtoolsStore`,
 * refreshes shared dependency holds when live ship jobs change, and emits native T3 thread
 * notifications (sound, in-app toast with "Open thread", desktop notification) — zero modals.
 */
import { useEffect, useRef, useState } from "react";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { msg } from "gt-react";
import { ShieldQuestionIcon } from "lucide-react";

import { toastManager } from "../components/ui/toast";
import { getClientSettings } from "../hooks/useSettings";
import { m } from "~/i18n/messages";
import { useQuietThreadShells } from "../state/entities";
import { useConnectedEnvironmentIds, useEnvironments } from "../state/environments";
import {
  hasDesktopNotifications,
  hasNotificationSound,
  playNotificationSound,
  threadNotificationTag,
} from "../threadNotifications";
import {
  buildDevtoolsStreamUrl,
  fetchDevtoolsJson,
  refreshDevtoolsStreamAccess,
  useDevtoolsStreamAccess,
  type PendingGuardRequest,
  type ShipQueueJob,
} from "./devtoolsClient";
import { refreshSharedShipQueueDeps, useSharedShipQueueDeps } from "./devtoolsDepsStore";
import { warmFleetConfigInBackground } from "./devtoolsFleetConfigStore";
import { subscribeMuxTopic } from "./devtoolsEventMux";
import { readGuardNotificationMode } from "./devtoolsPreferences";
import {
  applyGuardBrokerEvent,
  clearPendingGuardsForEnv,
  pruneExpiredGuards,
  useDevtoolsSelector,
  type GuardBrokerEvent,
} from "./devtoolsStore";
import { ensureCapabilities, useSharedCapabilities } from "./devtoolsStreams";
import { useSharedJobs } from "./jobs/jobsStore";
import { isShipQueueJobLive } from "./ShipQueueSteps";
import {
  findActionableDepHoldForJob,
  formatSafeCommandArgv,
  sanitizeApprovalDisplayText,
} from "./threadApprovals";

const alertedKeys = new Set<string>();
const MAX_ALERTED_KEYS = 250;

function markAlerted(key: string): boolean {
  if (alertedKeys.has(key)) return false;
  alertedKeys.add(key);
  while (alertedKeys.size > MAX_ALERTED_KEYS) {
    const first = alertedKeys.values().next().value;
    if (first === undefined) break;
    alertedKeys.delete(first);
  }
  return true;
}

function notifyThreadApproval(input: {
  readonly alertKey: string;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly threadTitle: string;
  readonly title: string;
  readonly body: string;
  readonly isGuard: boolean;
  readonly isViewingThread: boolean;
  readonly onOpenThread: (envId: EnvironmentId, tid: ThreadId) => void;
}): void {
  if (!markAlerted(input.alertKey)) return;

  const { notificationMode, inAppNotificationsEnabled } = getClientSettings();
  const guardPref = input.isGuard ? readGuardNotificationMode() : "follow";
  if (guardPref === "off") return;

  const shouldPlaySound =
    guardPref === "always"
      ? true
      : guardPref === "silent"
        ? false
        : hasNotificationSound(notificationMode);
  if (shouldPlaySound) {
    void playNotificationSound("input", () => {
      const currentMode = getClientSettings().notificationMode;
      const currentGuard = input.isGuard ? readGuardNotificationMode() : "follow";
      return currentGuard === "always"
        ? true
        : currentGuard === "follow" && hasNotificationSound(currentMode);
    });
  }

  const visibleAndFocused =
    typeof document !== "undefined" &&
    document.visibilityState === "visible" &&
    document.hasFocus();

  if (visibleAndFocused) {
    if (inAppNotificationsEnabled && !input.isViewingThread) {
      const toastId = toastManager.add({
        type: "warning",
        title: input.title,
        description: input.threadTitle || input.body,
        data: {
          hideCopyButton: true,
          leadingIcon: (
            <ShieldQuestionIcon aria-hidden className="size-4 text-warning-foreground" />
          ),
        },
        actionProps: {
          children: m(msg("Open thread")),
          onClick: () => {
            toastManager.close(toastId);
            input.onOpenThread(input.environmentId, input.threadId);
          },
        },
      });
    }
    return;
  }

  const shouldShowDesktop =
    guardPref === "always" || guardPref === "silent"
      ? true
      : hasDesktopNotifications(notificationMode);

  if (
    shouldShowDesktop &&
    typeof Notification !== "undefined" &&
    Notification.permission === "granted"
  ) {
    try {
      const notice = new Notification(input.title, {
        body: input.threadTitle ? `${input.threadTitle}: ${input.body}` : input.body,
        tag: threadNotificationTag(input.environmentId, input.threadId),
        silent: true,
      });
      notice.addEventListener("click", () => {
        notice.close();
        window.focus();
        void window.desktopBridge?.revealWindow().catch(() => undefined);
        input.onOpenThread(input.environmentId, input.threadId);
      });
    } catch {
      // ignore browser notification failures
    }
  }
}

function resolveNavigationThreadId(
  threadList: ReadonlyArray<{
    readonly id: ThreadId;
    readonly lineage: {
      readonly parentThreadId: ThreadId | null;
      readonly relationshipToParent: string | null;
    };
  }>,
  thread: {
    readonly id: ThreadId;
    readonly lineage: {
      readonly parentThreadId: ThreadId | null;
      readonly relationshipToParent: string | null;
    };
  },
): ThreadId {
  let cur = thread;
  const seen = new Set<ThreadId>([cur.id]);
  while (cur.lineage.relationshipToParent === "subagent" && cur.lineage.parentThreadId !== null) {
    const parent = threadList.find((t) => t.id === cur.lineage.parentThreadId);
    if (!parent || seen.has(parent.id)) break;
    seen.add(parent.id);
    cur = parent;
  }
  return cur.id;
}

function SingleEnvApprovalWatcher({
  environmentId,
  label,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const caps = useSharedCapabilities(environmentId);
  const hasDevtools = !caps.unsupported && caps.capabilities !== null;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- warms fleet host-config cache once per environment at startup so Settings opens instantaneously
  useEffect(() => {
    if (!hasDevtools) return;
    warmFleetConfigInBackground(environmentId);
  }, [environmentId, hasDevtools]);
  const canStreamGuards =
    !caps.unsupported &&
    caps.capabilities?.guardBrokerListening === true &&
    caps.capabilities?.canApproveGuards !== false;
  const [muxDisabled, setMuxDisabled] = useState(false);
  const useMux = canStreamGuards && !muxDisabled && caps.capabilities?.multiplexedEvents === true;
  const access = useDevtoolsStreamAccess(canStreamGuards && !useMux ? environmentId : null);
  const labelRef = useRef(label);
  const backoffRef = useRef(1500);
  const locationPathRef = useRef(location.pathname);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tracks latest environment label and pathname for SSE callbacks
  useEffect(() => {
    labelRef.current = label;
    locationPathRef.current = location.pathname;
  }, [label, location.pathname]);

  const threads = useQuietThreadShells();
  const envThreads = threads.filter(
    (t) => t.environmentId === environmentId && t.deletedAt === null && t.archivedAt === null,
  );
  const envThreadsRef = useRef(envThreads);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- exposes latest thread shells to SSE guard callbacks
  useEffect(() => {
    envThreadsRef.current = envThreads;
  }, [envThreads]);

  const openThread = (envId: EnvironmentId, tid: ThreadId) => {
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: envId, threadId: tid },
    });
  };
  const openThreadRef = useRef(openThread);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps latest router navigate callback for async SSE handlers
  useEffect(() => {
    openThreadRef.current = openThread;
  });

  const handleIncomingGuards = (added: ReadonlyArray<PendingGuardRequest>) => {
    const currentThreads = envThreadsRef.current;
    for (const req of added) {
      if (!req.threadId) continue;
      const thread = currentThreads.find((t) => t.id === req.threadId);
      if (!thread) continue;
      const navThreadId = resolveNavigationThreadId(currentThreads, thread);
      const isViewingThread =
        locationPathRef.current.includes(`/${thread.id}`) ||
        locationPathRef.current.includes(`/${navThreadId}`);
      notifyThreadApproval({
        alertKey: `guard:${environmentId}:${req.requestId}`,
        environmentId,
        threadId: navThreadId,
        threadTitle: sanitizeApprovalDisplayText(thread.title, 100),
        title: m(msg("Approval needed ({guard})"), {
          guard: sanitizeApprovalDisplayText(req.guard, 64) || "host-guard",
        }),
        body: formatSafeCommandArgv(req.command).slice(0, 140),
        isGuard: true,
        isViewingThread,
        onOpenThread: (e, t) => openThreadRef.current(e, t),
      });
    }
  };
  const handleIncomingGuardsRef = useRef(handleIncomingGuards);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps guard notification handler fresh inside SSE listener
  useEffect(() => {
    handleIncomingGuardsRef.current = handleIncomingGuards;
  });

  // 1. Multiplexed guards SSE stream
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to multiplexed /api/devtools/events?topics=guards
  useEffect(() => {
    if (!useMux) return;
    return subscribeMuxTopic(environmentId, "guards", {
      onEvent: (eventName, rawData) => {
        if (eventName !== "event") return;
        try {
          const ev = JSON.parse(rawData) as GuardBrokerEvent;
          applyGuardBrokerEvent(environmentId, labelRef.current, ev);
          if (ev.type === "pending_added") {
            handleIncomingGuardsRef.current([ev.request]);
          } else if (ev.type === "snapshot" && ev.pending.length > 0) {
            handleIncomingGuardsRef.current(ev.pending);
          }
        } catch {
          // ignore malformed event
        }
      },
      onFallbackNeeded: () => setMuxDisabled(true),
    });
  }, [environmentId, useMux]);

  // 2. Legacy standalone /guards/events SSE fallback
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- maintains fallback SSE connection to /api/devtools/guards/events
  useEffect(() => {
    if (!canStreamGuards || useMux || !access) {
      if (!canStreamGuards) clearPendingGuardsForEnv(environmentId);
      return;
    }

    let cancelled = false;
    let source: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (cancelled) return;
      const url = buildDevtoolsStreamUrl(access, "/guards/events");
      const es = new EventSource(url);
      source = es;

      es.onopen = () => {
        backoffRef.current = 1500;
      };

      es.onmessage = (msgEvent) => {
        try {
          const ev = JSON.parse(msgEvent.data) as GuardBrokerEvent;
          applyGuardBrokerEvent(environmentId, labelRef.current, ev);
          if (ev.type === "pending_added") {
            handleIncomingGuardsRef.current([ev.request]);
          } else if (ev.type === "snapshot" && ev.pending.length > 0) {
            handleIncomingGuardsRef.current(ev.pending);
          }
        } catch {
          // ignore malformed SSE payload
        }
      };

      es.onerror = () => {
        es.close();
        source = null;
        if (cancelled) return;
        const delay = backoffRef.current;
        backoffRef.current = Math.min(30_000, Math.round(delay * 1.8));
        reconnectTimer = setTimeout(() => {
          if (cancelled) return;
          void fetchDevtoolsJson<{ readonly pending?: ReadonlyArray<PendingGuardRequest> }>(
            environmentId,
            "/guards/pending",
          ).then((probe) => {
            if (cancelled) return;
            if (probe.status === 401) {
              refreshDevtoolsStreamAccess(environmentId);
              // Fallback reconnect with backoff if refreshed stream access keeps the same object (L2).
              const retryDelay = backoffRef.current;
              backoffRef.current = Math.min(30_000, Math.round(retryDelay * 1.8));
              reconnectTimer = setTimeout(() => {
                if (!cancelled) connect();
              }, retryDelay);
              return;
            }
            if (probe.status === 404 || probe.status === 403) {
              clearPendingGuardsForEnv(environmentId);
              return;
            }
            if (probe.ok && Array.isArray(probe.data?.pending)) {
              applyGuardBrokerEvent(environmentId, labelRef.current, {
                type: "snapshot",
                pending: probe.data.pending,
              });
            }
            connect();
          });
        }, delay);
      };
    };

    connect();
    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      source?.close();
    };
  }, [environmentId, canStreamGuards, useMux, access]);

  // 3. Watch live ship-queue jobs -> refresh shared deps and notify attributed threads on holds
  const jobsState = useSharedJobs(caps.unsupported ? null : environmentId);
  const shipJobs: ReadonlyArray<ShipQueueJob> = jobsState.jobs.flatMap((j) =>
    j.source === "ship-queue" && j.shipJob ? [j.shipJob] : [],
  );
  const liveShipJobs = shipJobs.filter(isShipQueueJobLive);
  const liveShipSig = liveShipJobs
    .map((j) => `${j.id ?? j.key ?? ""}:${j.state ?? ""}:${j.waiting ?? ""}`)
    .join("|");
  const depsState = useSharedShipQueueDeps(environmentId, liveShipJobs.length > 0);
  const depsRepos = depsState.payload?.repos ?? [];

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- revalidates /ship-queue/deps when live ship-queue jobs change
  useEffect(() => {
    if (!liveShipSig) return;
    refreshSharedShipQueueDeps(environmentId);
  }, [environmentId, liveShipSig]);

  const depHoldSig = depsRepos
    .filter((r) => r.holding)
    .map((r) => `${r.repo}:${r.reportId ?? ""}:${r.status}:${r.attemptStatus ?? ""}`)
    .join("|");
  const depAlerts: Array<{
    readonly alertKey: string;
    readonly threadId: ThreadId;
    readonly navThreadId: ThreadId;
    readonly threadTitle: string;
    readonly repoLabel: string;
    readonly body: string;
  }> = [];
  if (liveShipSig && depHoldSig) {
    for (const thread of envThreads) {
      // Strict thread_id attribution only: never attribute outside CLI runs by branch/worktree.
      const matched = liveShipJobs.filter((job) => job.thread_id === thread.id);
      if (matched.length === 0) continue;
      const navThreadId = resolveNavigationThreadId(envThreads, thread);
      for (const job of matched) {
        const hold = findActionableDepHoldForJob(job, depsRepos);
        if (!hold) continue;
        depAlerts.push({
          alertKey: `dep:${environmentId}:${thread.id}:${hold.repo}:${hold.reportId ?? hold.status}`,
          threadId: thread.id,
          navThreadId,
          threadTitle: sanitizeApprovalDisplayText(thread.title, 100),
          repoLabel: sanitizeApprovalDisplayText(hold.repo, 80),
          body: sanitizeApprovalDisplayText(hold.reportId ?? hold.repo, 120),
        });
      }
    }
  }
  const depAlertsJson = depAlerts.length > 0 ? JSON.stringify(depAlerts) : "";

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- emits native T3 thread alerts only when the attributed dep-hold alert set changes
  useEffect(() => {
    if (!depAlertsJson) return;
    const alerts = JSON.parse(depAlertsJson) as ReadonlyArray<{
      readonly alertKey: string;
      readonly threadId: ThreadId;
      readonly navThreadId: ThreadId;
      readonly threadTitle: string;
      readonly repoLabel: string;
      readonly body: string;
    }>;
    for (const alert of alerts) {
      const isViewingThread =
        locationPathRef.current.includes(`/${alert.threadId}`) ||
        locationPathRef.current.includes(`/${alert.navThreadId}`);
      notifyThreadApproval({
        alertKey: alert.alertKey,
        environmentId,
        threadId: alert.navThreadId,
        threadTitle: alert.threadTitle,
        title: m(msg("Dependency approval needed ({repo})"), { repo: alert.repoLabel }),
        body: alert.body,
        isGuard: false,
        isViewingThread,
        onOpenThread: (e, t) => openThreadRef.current(e, t),
      });
    }
  }, [environmentId, depAlertsJson]);

  return null;
}

export function DevtoolsApprovalWatcher() {
  const { environments } = useEnvironments();
  const connectedIds = useConnectedEnvironmentIds();
  const connectedSet = new Set(connectedIds);
  const activeEnvs = environments.filter((env) => connectedSet.has(env.environmentId));
  const envKey = activeEnvs.map((e) => e.environmentId).join(",");
  const hasAnyPendingGuards = useDevtoolsSelector((s) => s.totalPendingCount > 0);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- probes /capabilities once per connected environment
  useEffect(() => {
    if (!envKey) return;
    for (const id of envKey.split(",")) {
      void ensureCapabilities(id as EnvironmentId);
    }
  }, [envKey]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- prunes expired guard entries only while pending guards exist
  useEffect(() => {
    if (!hasAnyPendingGuards) return;
    const timer = setInterval(() => {
      pruneExpiredGuards();
    }, 15_000);
    return () => clearInterval(timer);
  }, [hasAnyPendingGuards]);

  return (
    <>
      {activeEnvs.map((env) => (
        <SingleEnvApprovalWatcher
          key={env.environmentId}
          environmentId={env.environmentId}
          label={env.label}
        />
      ))}
    </>
  );
}
