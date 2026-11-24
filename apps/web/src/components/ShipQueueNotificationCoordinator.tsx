import { threadKey } from "@t3tools/client-runtime/state/entities";
import type { EnvironmentId, ShipQueueSnapshot, ThreadId } from "@t3tools/contracts";
import type { AnyRouter } from "@tanstack/react-router";
import type { AtomRegistry } from "effect/reactivity";
import { msg } from "gt-react";
import { ShieldQuestionIcon } from "lucide-react";

import { getClientSettings } from "../hooks/useSettings";
import { m } from "../i18n/messages";
import { resolveNavigationThreadId, sanitizeApprovalDisplayText } from "../lib/hostGuardApprovals";
import { depHoldReportKey, findActionableDepHoldForJob } from "../lib/shipQueueApprovals";
import { matchThreadShipJobs, normalizeDirectoryPath } from "../lib/threadShipStatus";
import { environmentSummaries } from "../state/presentation";
import {
  canDecideShipQueueDepsAtom,
  EMPTY_SHIP_QUEUE_SNAPSHOT,
  shipQueueSnapshotAtom,
} from "../state/shipQueue";
import { environmentThreadShells } from "../state/threads";
import {
  hasDesktopNotifications,
  hasNotificationSound,
  playNotificationSound,
  threadNotificationTag,
} from "../threadNotifications";
import { toastManager } from "./ui/toast";

const MAX_ALERTED_KEYS = 250;
type ToastId = ReturnType<typeof toastManager.add>;

/**
 * Watches connected environments' `shipQueueSnapshotAtom` streams and emits native T3 thread
 * notifications (sound, warning toast with "Open thread", desktop notifications) when an
 * actionable dependency hold blocks a live ship job on a visible thread outside the current view.
 */
export function startShipQueueNotifications(
  registry: AtomRegistry.AtomRegistry,
  router: AnyRouter,
): () => void {
  const alertedKeys = new Set<string>();
  const openToasts = new Map<
    string,
    { readonly threadKeys: ReadonlySet<string>; readonly id: ToastId }
  >();
  const openNotifications = new Map<
    string,
    { readonly threadKeys: ReadonlySet<string>; readonly notification: Notification }
  >();
  const watchers = new Map<
    EnvironmentId,
    { readonly stop: () => void; snapshot: ShipQueueSnapshot }
  >();

  const markAlerted = (key: string): boolean => {
    if (alertedKeys.has(key)) return false;
    alertedKeys.add(key);
    while (alertedKeys.size > MAX_ALERTED_KEYS) {
      const oldest = alertedKeys.values().next().value;
      if (oldest === undefined) break;
      alertedKeys.delete(oldest);
    }
    return true;
  };

  const closeAlert = (alertKey: string) => {
    const toastEntry = openToasts.get(alertKey);
    if (toastEntry) {
      openToasts.delete(alertKey);
      toastManager.close(toastEntry.id);
    }
    const notifEntry = openNotifications.get(alertKey);
    if (notifEntry) {
      openNotifications.delete(alertKey);
      notifEntry.notification.close();
    }
  };

  const closeAlertsForEnvironment = (environmentId: EnvironmentId) => {
    const prefix = `${environmentId}:`;
    for (const key of openToasts.keys()) {
      if (key.startsWith(prefix)) closeAlert(key);
    }
    for (const key of openNotifications.keys()) {
      if (key.startsWith(prefix)) closeAlert(key);
    }
  };

  const closeAlertsForThreadKey = (targetThreadKey: string) => {
    for (const [key, entry] of openToasts) {
      if (entry.threadKeys.has(targetThreadKey)) closeAlert(key);
    }
    for (const [key, entry] of openNotifications) {
      if (entry.threadKeys.has(targetThreadKey)) closeAlert(key);
    }
  };

  const activeRouteThread = () =>
    (router.state.matches.at(-1)?.params ?? {}) as {
      environmentId?: EnvironmentId;
      threadId?: ThreadId;
    };

  const evaluate = (environmentId: EnvironmentId, snapshot: ShipQueueSnapshot) => {
    const canDecide = registry.get(canDecideShipQueueDepsAtom(environmentId));
    if (
      !canDecide ||
      !snapshot.available ||
      snapshot.jobs.length === 0 ||
      snapshot.deps.length === 0
    ) {
      closeAlertsForEnvironment(environmentId);
      return;
    }

    const threads = registry.get(environmentThreadShells.environmentThreadsAtom(environmentId));
    const hidden = registry.get(environmentThreadShells.hiddenThreadKeysAtom);
    const active = activeRouteThread();

    const activeAlerts: Array<{
      readonly alertKey: string;
      readonly navThreadId: ThreadId;
      readonly threadKeys: ReadonlySet<string>;
      readonly threadTitle: string;
      readonly repoLabel: string;
      readonly updateCount: number;
    }> = [];
    const seenAlertKeys = new Set<string>();

    for (const thread of threads) {
      if (thread.deletedAt !== null || thread.archivedAt !== null) continue;
      const matchedJobs = matchThreadShipJobs(
        snapshot.jobs,
        thread.id,
        thread.branch ?? null,
        normalizeDirectoryPath(thread.worktreePath),
        "",
      );
      if (matchedJobs.length === 0) continue;

      const navThreadId = resolveNavigationThreadId(threads, thread);
      const rawKey = threadKey({ environmentId, threadId: thread.id });
      const navKey = threadKey({ environmentId, threadId: navThreadId });
      if (hidden.has(rawKey) || hidden.has(navKey)) continue;

      for (const job of matchedJobs) {
        const hold = findActionableDepHoldForJob(job, snapshot.deps);
        if (!hold) continue;
        const alertKey = `${environmentId}:${hold.repo}:${depHoldReportKey(hold)}:${navThreadId}`;
        if (seenAlertKeys.has(alertKey)) continue;
        seenAlertKeys.add(alertKey);
        activeAlerts.push({
          alertKey,
          navThreadId,
          threadKeys: new Set([rawKey, navKey]),
          threadTitle: sanitizeApprovalDisplayText(thread.title, 100),
          repoLabel: sanitizeApprovalDisplayText(hold.repo, 64) || "ship-queue",
          updateCount: hold.updates.length,
        });
      }
    }

    const envPrefix = `${environmentId}:`;
    for (const key of openToasts.keys()) {
      if (key.startsWith(envPrefix) && !seenAlertKeys.has(key)) closeAlert(key);
    }
    for (const key of openNotifications.keys()) {
      if (key.startsWith(envPrefix) && !seenAlertKeys.has(key)) closeAlert(key);
    }

    for (const item of activeAlerts) {
      if (!markAlerted(item.alertKey)) continue;

      const { notificationMode, inAppNotificationsEnabled } = getClientSettings();
      if (hasNotificationSound(notificationMode)) {
        void playNotificationSound("input", () =>
          hasNotificationSound(getClientSettings().notificationMode),
        );
      }

      const title = m(msg("Dependency approval needed ({repo})", { repo: item.repoLabel }));
      const description =
        item.threadTitle ||
        (item.updateCount > 0
          ? m(msg("{count} updates blocking ship", { count: item.updateCount }))
          : m(msg("Dependency hold blocking ship")));
      const isViewingThread =
        active.environmentId === environmentId &&
        active.threadId !== undefined &&
        item.threadKeys.has(threadKey({ environmentId, threadId: active.threadId }));
      const visibleAndFocused =
        typeof document !== "undefined" &&
        document.visibilityState === "visible" &&
        document.hasFocus();

      const openTargetThread = () => {
        void router.navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId, threadId: item.navThreadId },
        });
      };

      if (visibleAndFocused) {
        if (inAppNotificationsEnabled && !isViewingThread) {
          const toastId = toastManager.add({
            onRemove: () => openToasts.delete(item.alertKey),
            type: "warning",
            title,
            description,
            data: {
              hideCopyButton: true,
              leadingIcon: (
                <ShieldQuestionIcon aria-hidden className="size-4 text-warning-foreground" />
              ),
            },
            actionProps: {
              children: m(msg("Open thread")),
              onClick: () => {
                closeAlert(item.alertKey);
                openTargetThread();
              },
            },
          });
          openToasts.set(item.alertKey, { threadKeys: item.threadKeys, id: toastId });
        }
        continue;
      }

      if (
        hasDesktopNotifications(notificationMode) &&
        typeof Notification !== "undefined" &&
        Notification.permission === "granted"
      ) {
        try {
          const notification = new Notification(title, {
            body: item.threadTitle ? `${item.threadTitle}: ${description}` : description,
            tag: `sq:${threadNotificationTag(environmentId, item.navThreadId)}`,
            silent: true,
          });
          openNotifications.set(item.alertKey, { threadKeys: item.threadKeys, notification });
          notification.addEventListener("close", () => openNotifications.delete(item.alertKey));
          notification.addEventListener("click", () => {
            closeAlert(item.alertKey);
            window.focus();
            void window.desktopBridge?.revealWindow().catch(() => undefined);
            openTargetThread();
          });
        } catch {
          // Some browsers expose Notification but reject desktop presentation.
        }
      }
    }
  };

  const watchEnvironment = (environmentId: EnvironmentId) => {
    const entry = {
      snapshot: EMPTY_SHIP_QUEUE_SNAPSHOT,
      stop: () => {},
    };
    const unsubscribeSnapshot = registry.subscribe(
      shipQueueSnapshotAtom(environmentId),
      (snapshot) => {
        entry.snapshot = snapshot;
        evaluate(environmentId, snapshot);
      },
      { immediate: true },
    );
    const unsubscribeCanDecide = registry.subscribe(
      canDecideShipQueueDepsAtom(environmentId),
      () => {
        if (entry.snapshot.available) evaluate(environmentId, entry.snapshot);
      },
    );
    const unsubscribeThreads = registry.subscribe(
      environmentThreadShells.environmentThreadsAtom(environmentId),
      () => {
        if (entry.snapshot.available && entry.snapshot.deps.length > 0) {
          evaluate(environmentId, entry.snapshot);
        }
      },
    );
    entry.stop = () => {
      unsubscribeSnapshot();
      unsubscribeCanDecide();
      unsubscribeThreads();
      closeAlertsForEnvironment(environmentId);
    };
    return entry;
  };

  const syncEnvironments = () => {
    const environmentIds = registry.get(environmentSummaries.environmentIdsAtom);
    const activeIds = new Set(environmentIds);
    for (const [environmentId, watcher] of watchers) {
      if (activeIds.has(environmentId)) continue;
      watcher.stop();
      watchers.delete(environmentId);
    }
    for (const environmentId of environmentIds) {
      if (!watchers.has(environmentId)) {
        watchers.set(environmentId, watchEnvironment(environmentId));
      }
    }
  };

  const unsubscribeEnvironments = registry.subscribe(
    environmentSummaries.environmentIdsAtom,
    syncEnvironments,
    { immediate: true },
  );
  const unsubscribeHidden = registry.subscribe(
    environmentThreadShells.hiddenThreadKeysAtom,
    (hidden) => {
      for (const targetKey of hidden) {
        closeAlertsForThreadKey(targetKey);
      }
    },
  );
  const unsubscribeRoute = router.subscribe("onResolved", () => {
    const { environmentId, threadId } = activeRouteThread();
    if (environmentId !== undefined && threadId !== undefined) {
      closeAlertsForThreadKey(threadKey({ environmentId, threadId }));
    }
  });

  return () => {
    unsubscribeEnvironments();
    unsubscribeHidden();
    unsubscribeRoute();
    for (const watcher of watchers.values()) watcher.stop();
    watchers.clear();
  };
}
