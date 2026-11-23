import { threadKey } from "@t3tools/client-runtime/state/entities";
import type { EnvironmentId, PendingHostGuardRequest, ThreadId } from "@t3tools/contracts";
import type { AnyRouter } from "@tanstack/react-router";
import type { AtomRegistry } from "effect/reactivity";
import { msg } from "gt-react";
import { ShieldQuestionIcon } from "lucide-react";

import { getClientSettings } from "../hooks/useSettings";
import { m } from "../i18n/messages";
import {
  formatSafeCommandArgv,
  isPendingHostGuardActive,
  resolveNavigationThreadId,
  sanitizeApprovalDisplayText,
} from "../lib/hostGuardApprovals";
import { hostGuardPendingAtom } from "../state/hostGuard";
import { environmentSummaries } from "../state/presentation";
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
 * Watches connected environments' `hostGuardPendingAtom` streams and emits native T3 thread
 * notifications (sound, warning toast with "Open thread", desktop notifications) when new requests
 * arrive outside the active thread view.
 */
export function startHostGuardNotifications(
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
    { readonly stop: () => void; pending: ReadonlyArray<PendingHostGuardRequest> }
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

  const evaluate = (
    environmentId: EnvironmentId,
    pending: ReadonlyArray<PendingHostGuardRequest>,
  ) => {
    const activeKeys = new Set(pending.map((req) => `${environmentId}:${req.requestId}`));
    const envPrefix = `${environmentId}:`;
    for (const key of openToasts.keys()) {
      if (key.startsWith(envPrefix) && !activeKeys.has(key)) closeAlert(key);
    }
    for (const key of openNotifications.keys()) {
      if (key.startsWith(envPrefix) && !activeKeys.has(key)) closeAlert(key);
    }
    if (pending.length === 0) return;

    const threads = registry.get(environmentThreadShells.environmentThreadsAtom(environmentId));
    const hidden = registry.get(environmentThreadShells.hiddenThreadKeysAtom);
    const active = activeRouteThread();
    const nowMs = Date.now();

    for (const req of pending) {
      if (!isPendingHostGuardActive(req, nowMs)) continue;
      const thread = threads.find(
        (candidate) =>
          candidate.id === req.threadId &&
          candidate.deletedAt === null &&
          candidate.archivedAt === null,
      );
      if (!thread) continue;

      const navThreadId = resolveNavigationThreadId(threads, thread);
      const rawKey = threadKey({ environmentId, threadId: thread.id });
      const navKey = threadKey({ environmentId, threadId: navThreadId });
      if (hidden.has(rawKey) || hidden.has(navKey)) continue;

      const alertKey = `${environmentId}:${req.requestId}`;
      if (!markAlerted(alertKey)) continue;

      const { notificationMode, inAppNotificationsEnabled } = getClientSettings();
      if (hasNotificationSound(notificationMode)) {
        void playNotificationSound("input", () =>
          hasNotificationSound(getClientSettings().notificationMode),
        );
      }

      const guardLabel = sanitizeApprovalDisplayText(req.guard, 64) || "host-guard";
      const title = m(msg("Approval needed ({guard})", { guard: guardLabel }));
      const threadTitle = sanitizeApprovalDisplayText(thread.title, 100);
      const commandPreview = formatSafeCommandArgv(req.command).slice(0, 140);
      const isViewingThread =
        active.environmentId === environmentId &&
        (active.threadId === thread.id || active.threadId === navThreadId);
      const visibleAndFocused =
        typeof document !== "undefined" &&
        document.visibilityState === "visible" &&
        document.hasFocus();

      const openTargetThread = () => {
        void router.navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId, threadId: navThreadId },
        });
      };

      const threadKeys = new Set([rawKey, navKey]);

      if (visibleAndFocused) {
        if (inAppNotificationsEnabled && !isViewingThread) {
          const toastId = toastManager.add({
            onRemove: () => openToasts.delete(alertKey),
            type: "warning",
            title,
            description: threadTitle || commandPreview,
            data: {
              hideCopyButton: true,
              leadingIcon: (
                <ShieldQuestionIcon aria-hidden className="size-4 text-warning-foreground" />
              ),
            },
            actionProps: {
              children: m(msg("Open thread")),
              onClick: () => {
                closeAlert(alertKey);
                openTargetThread();
              },
            },
          });
          openToasts.set(alertKey, { threadKeys, id: toastId });
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
            body: threadTitle ? `${threadTitle}: ${commandPreview}` : commandPreview,
            tag: `hg:${threadNotificationTag(environmentId, navThreadId)}`,
            silent: true,
          });
          openNotifications.set(alertKey, { threadKeys, notification });
          notification.addEventListener("close", () => openNotifications.delete(alertKey));
          notification.addEventListener("click", () => {
            closeAlert(alertKey);
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
      pending: [] as ReadonlyArray<PendingHostGuardRequest>,
      stop: () => {},
    };
    const unsubscribePending = registry.subscribe(
      hostGuardPendingAtom(environmentId),
      (pending) => {
        entry.pending = pending;
        evaluate(environmentId, pending);
      },
      { immediate: true },
    );
    const unsubscribeThreads = registry.subscribe(
      environmentThreadShells.environmentThreadsAtom(environmentId),
      () => {
        if (entry.pending.length > 0) evaluate(environmentId, entry.pending);
      },
    );
    entry.stop = () => {
      unsubscribePending();
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
