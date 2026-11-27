/** Main `Machines` cockpit inside Fleet Console (host telemetry, threads, jobs/procs, localhosts). */
import { useEffect, useState } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { T, useGT } from "gt-react";

import { Sheet, SheetHeader, SheetPopup, SheetTitle } from "../components/ui/sheet";
import { DeckHeaderStrip } from "./DeckHeaderStrip";
import type { MergedFleetHost } from "./devdeckTypes";
import {
  fetchDevtoolsJson,
  runTrackedDevdeckAction,
  type DevdeckServerItem,
  type DevdeckSessionItem,
  type StorageReviewLaunchPayload,
  type StorageScanPayload,
} from "./devtoolsClient";
import { DevtoolsErrorBoundary } from "./DevtoolsErrorBoundary";
import type { DevtoolsResourceStatus } from "./devtoolsState";
import {
  closeFleetConsole,
  setConsoleHost,
  setConsoleJobId,
  type ConsoleActionFeedback,
} from "./devtoolsStore";
import { refreshSharedDevdeck } from "./devtoolsStreams";
import {
  FleetHostProblemBanner,
  FleetOfflineBanner,
  FleetOfflineJobsFallback,
  FleetStorageReportBanner,
  type FleetStorageBannerData,
} from "./FleetHostBanners";
import { resolveFleetJobTarget, type FleetJobTarget } from "./fleetHostEnvironment";
import { FleetJobsAndProcsPanel } from "./FleetJobsAndProcsPanel";
import { FleetLocalhostsPanel, serverActionBody, serverActionPath } from "./FleetLocalhostsPanel";
import { FleetThreadsPanel } from "./FleetThreadsPanel";
import { cancelTrackedJob, refreshSharedJobs } from "./jobs/jobsStore";
import { isJobLive, type JobSummary } from "./jobs/jobTypes";
import { ManagedJobInspector } from "./jobs/ManagedJobInspector";
import { useLiveClockMs } from "./liveClock";

export function FleetMachinesView({
  environmentId,
  hosts,
  selectedHost,
  hostJobs,
  jobTargets,
  selectedJobId,
  devdeckStatus,
  devdeckError = null,
  onFeedback,
}: {
  readonly environmentId: EnvironmentId;
  readonly hosts: ReadonlyArray<MergedFleetHost>;
  readonly selectedHost: MergedFleetHost | null;
  readonly hostJobs: ReadonlyArray<JobSummary>;
  /** Shown job key -> owning environment and real job id (remote hosts' own environments). */
  readonly jobTargets?: ReadonlyMap<string, FleetJobTarget> | undefined;
  readonly selectedJobId: string | null;
  readonly devdeckStatus?: DevtoolsResourceStatus | undefined;
  readonly devdeckError?: string | null;
  readonly onFeedback: (fb: ConsoleActionFeedback) => void;
}) {
  const gt = useGT();
  const navigate = useNavigate();
  const [busyKeys, setBusyKeys] = useState<ReadonlySet<string>>(() => new Set());
  const withBusyKey = <T,>(key: string, fn: () => Promise<T>): Promise<T> => {
    setBusyKeys((prev) => {
      const next = new Set(prev);
      next.add(key);
      return next;
    });
    const clearBusyKey = () => {
      setBusyKeys((prev) => {
        if (!prev.has(key)) return prev;
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    };
    return Promise.resolve().then(fn).finally(clearBusyKey);
  };
  const [reportBanner, setReportBanner] = useState<FleetStorageBannerData | null>(null);

  const hasLiveJob = hostJobs.some(isJobLive);
  const nowMs = useLiveClockMs(hasLiveJob);
  const inspectedJob = selectedJobId
    ? (hostJobs.find((j) => j.id === selectedJobId) ?? null)
    : null;
  const watchedRemoteHostId =
    selectedHost && !selectedHost.isLocal && selectedHost.hasDevdeckNode ? selectedHost.id : null;

  // Renew DevDeck's 12s viewer lease (`ViewerEvery = 5s`) while viewing a remote DevDeck node so
  // remote GPU/VRAM/CPU metrics update live every 5s instead of 30s background cadence.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- network lease renewal bound to viewed remote host
  useEffect(() => {
    if (!watchedRemoteHostId) return;
    let disposed = false;
    let stopped = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    const stopTimer = () => {
      stopped = true;
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
    const kick = () => {
      if (disposed || stopped || (typeof document !== "undefined" && document.hidden)) return;
      void fetchDevtoolsJson(
        environmentId,
        `/devdeck/nodes/${encodeURIComponent(watchedRemoteHostId)}/kick`,
        { method: "POST", body: {} },
      ).then((res) => {
        if (!disposed && !res.ok && (res.status === 403 || res.status === 404)) {
          stopTimer();
        }
      });
    };
    kick();
    timer = setInterval(kick, 5_000);
    const onVisibility = () => {
      if (!document.hidden) kick();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      disposed = true;
      stopTimer();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [environmentId, watchedRemoteHostId]);

  const handleToggleCi = async (host: MergedFleetHost, enabled: boolean) => {
    const probeName = host.probeHostName ?? host.id;
    onFeedback({
      tone: "busy",
      text: enabled
        ? gt("Enabling CI on {host}…", { host: host.shortName })
        : gt("Disabling CI on {host}…", { host: host.shortName }),
    });
    const res = await withBusyKey(`ci:${probeName}`, () =>
      runTrackedDevdeckAction(environmentId, `/hosts/${encodeURIComponent(probeName)}/ci`, {
        on: enabled,
      }),
    );
    if (res.ok) {
      void refreshSharedDevdeck(environmentId);
      onFeedback({
        tone: "ok",
        text: enabled
          ? gt("CI enabled on {host}", { host: host.shortName })
          : gt("CI disabled on {host}", { host: host.shortName }),
      });
    } else {
      onFeedback({ tone: "error", text: res.error ?? gt("Failed to toggle CI host state") });
    }
  };

  const handleCheckHosts = async () => {
    onFeedback({ tone: "busy", text: gt("Checking fleet hosts…") });
    const res = await withBusyKey("hosts-check", () =>
      runTrackedDevdeckAction(environmentId, "/hosts/check"),
    );
    if (res.ok) {
      void refreshSharedDevdeck(environmentId);
      onFeedback({ tone: "ok", text: gt("Host probe check triggered") });
    } else {
      onFeedback({ tone: "error", text: res.error ?? gt("Failed to check hosts") });
    }
  };

  const handleProvisionHost = async (host: MergedFleetHost) => {
    const probeName = host.probeHostName ?? host.id;
    onFeedback({
      tone: "busy",
      text: gt("Provisioning {host}…", { host: host.shortName }),
    });
    const res = await withBusyKey(`provision:${probeName}`, () =>
      runTrackedDevdeckAction(environmentId, `/hosts/${encodeURIComponent(probeName)}/provision`),
    );
    if (res.ok) {
      void refreshSharedDevdeck(environmentId);
      onFeedback({
        tone: "ok",
        text: gt("Provisioning completed for {host}", { host: host.shortName }),
      });
    } else {
      onFeedback({ tone: "error", text: res.error ?? gt("Host provisioning failed") });
    }
  };

  const handleServerAction = async (srv: DevdeckServerItem, verb: "start" | "stop") => {
    const path = serverActionPath(srv, verb);
    if (!path) return;
    const key = srv.id || srv.container || srv.service || "srv";
    const res = await withBusyKey(`srv:${key}:${verb}`, () =>
      runTrackedDevdeckAction(environmentId, path, serverActionBody(srv, verb)),
    );
    if (res.ok) {
      void refreshSharedDevdeck(environmentId);
      onFeedback({
        tone: "ok",
        text:
          verb === "stop"
            ? gt("Stopped {name}", { name: srv.service || srv.container || key })
            : gt("Started {name}", { name: srv.service || srv.container || key }),
      });
    } else {
      onFeedback({ tone: "error", text: res.error ?? gt("Server action failed") });
    }
  };

  const handleCancelJob = async (jobKey: string) => {
    const target = resolveFleetJobTarget(jobTargets, jobKey, environmentId);
    const res = await withBusyKey(`job:${jobKey}`, () =>
      cancelTrackedJob(target.environmentId, target.jobId),
    );
    if (res.ok) {
      void refreshSharedJobs(target.environmentId);
      onFeedback({ tone: "ok", text: gt("Sent cancel/kill signal to job") });
    } else {
      onFeedback({ tone: "error", text: res.error ?? gt("Failed to kill job") });
    }
  };

  const handleCloseSession = async (sess: DevdeckSessionItem) => {
    if (!sess.id) return;
    const sid = sess.id;
    const res = await withBusyKey(`sess:${sid}`, () =>
      runTrackedDevdeckAction(environmentId, `/sessions/${encodeURIComponent(sid)}/close`),
    );
    if (res.ok) {
      void refreshSharedDevdeck(environmentId);
      onFeedback({ tone: "ok", text: gt("Killed {name}", { name: sess.name || sid }) });
    } else {
      onFeedback({ tone: "error", text: res.error ?? gt("Failed to kill process") });
    }
  };

  const handleRunStorageReport = async (host: MergedFleetHost) => {
    if (!host.isLocal) {
      const mounts = (host.telemetry?.disks ?? [])
        .filter((d) => d.total && d.total > 0)
        .map((d) => ({
          mount: d.mount || d.label || "/",
          usedPct: Math.round(((d.used ?? 0) / (d.total ?? 1)) * 1000) / 10,
          availBytes: Math.max(0, (d.total ?? 0) - (d.used ?? 0)),
        }));
      setReportBanner({
        hostName: host.shortName,
        sourceLabel: gt("Live DevDeck telemetry (use Agent cleanup review for remote deep audit)"),
        mounts,
      });
      onFeedback({
        tone: "ok",
        text: gt("Showing live mount report for {host}", { host: host.shortName }),
      });
      return;
    }

    onFeedback({
      tone: "busy",
      text: gt("Running storage scan for {host}…", { host: host.shortName }),
    });
    const res = await withBusyKey(`storage-report:${host.id}`, () =>
      fetchDevtoolsJson<StorageScanPayload>(environmentId, "/storage/scan/refresh", {
        method: "POST",
        body: {},
      }),
    );
    if (res.ok && res.data?.hostScan) {
      setReportBanner({
        hostName: res.data.hostScan.host ?? host.shortName,
        sourceLabel: gt("Local reaper scan"),
        mounts: (res.data.hostScan.mounts ?? []).map((m) => ({
          mount: m.mount,
          usedPct: m.used_pct,
          ...(m.avail_bytes !== undefined ? { availBytes: m.avail_bytes } : {}),
        })),
      });
      onFeedback({ tone: "ok", text: gt("Storage scan refreshed") });
    } else {
      onFeedback({ tone: "error", text: res.error ?? gt("Failed to run storage scan") });
    }
  };

  const handleStartCleanupReview = async (host: MergedFleetHost) => {
    onFeedback({
      tone: "busy",
      text: gt("Starting agent cleanup review for {host}…", { host: host.shortName }),
    });
    const mounts = (host.telemetry?.disks ?? [])
      .filter((d) => d.total && d.total > 0)
      .flatMap((d) => {
        const mount = d.mount || (d.label?.startsWith("/") ? d.label : "");
        if (!mount.startsWith("/")) return [];
        return [
          {
            mount,
            usedPct: Math.round(((d.used ?? 0) / (d.total ?? 1)) * 1000) / 10,
          },
        ];
      });
    const safeHost = (host.probeHostName ?? host.shortName).trim().replace(/[^A-Za-z0-9._-]/g, "-");
    const res = await withBusyKey(`storage-review:${host.id}`, () =>
      fetchDevtoolsJson<StorageReviewLaunchPayload>(environmentId, "/storage/review", {
        method: "POST",
        body: {
          host: safeHost || "local",
          ...(mounts.length > 0 ? { mounts } : {}),
        },
      }),
    );
    if (res.ok && res.data?.launched && res.data.threadId) {
      onFeedback({ tone: "ok", text: gt("Opened agent cleanup review thread") });
      closeFleetConsole();
      void navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId, threadId: res.data.threadId },
      });
    } else if (res.ok && res.data?.prompt) {
      void navigator.clipboard?.writeText(res.data.prompt).catch(() => undefined);
      onFeedback({
        tone: "ok",
        text: gt("Copied agent cleanup prompt to clipboard"),
      });
    } else {
      onFeedback({ tone: "error", text: res.error ?? gt("Failed to start cleanup review") });
    }
  };

  const resolvedDevdeckStatus: DevtoolsResourceStatus =
    devdeckStatus ??
    (devdeckError
      ? selectedHost
        ? "degraded"
        : "offline"
      : selectedHost
        ? "ready"
        : "connecting");
  // Show the banner when no host has loaded yet (even if status briefly reads `ready`) or on an
  // actual error/offline/unconfigured state — never flash during brief error-free SSE reconnects.
  const bannerStatus: Exclude<DevtoolsResourceStatus, "ready"> | null = !selectedHost
    ? resolvedDevdeckStatus === "ready"
      ? "connecting"
      : resolvedDevdeckStatus
    : devdeckError ||
        resolvedDevdeckStatus === "offline" ||
        resolvedDevdeckStatus === "unconfigured" ||
        resolvedDevdeckStatus === "error"
      ? resolvedDevdeckStatus === "ready"
        ? "degraded"
        : resolvedDevdeckStatus
      : null;

  const handleOpenThread = (threadId: string, threadEnvId: EnvironmentId = environmentId) => {
    setConsoleJobId(null);
    closeFleetConsole();
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: threadEnvId, threadId },
    });
  };
  const inspectedTarget = inspectedJob
    ? resolveFleetJobTarget(jobTargets, inspectedJob.id, environmentId)
    : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <DeckHeaderStrip
        hosts={hosts}
        selectedHost={selectedHost}
        busyKeys={busyKeys}
        onSelectHost={(id) => setConsoleHost(id)}
        onToggleCi={(host, enabled) => void handleToggleCi(host, enabled)}
        onCheckHosts={() => void handleCheckHosts()}
        onRunStorageReport={(host) => void handleRunStorageReport(host)}
        onStartCleanupReview={(host) => void handleStartCleanupReview(host)}
      />

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {bannerStatus !== null ? (
          <div className="mb-4">
            <FleetOfflineBanner
              environmentId={environmentId}
              devdeckStatus={bannerStatus}
              devdeckError={devdeckError}
            />
          </div>
        ) : null}

        {selectedHost ? (
          <FleetHostProblemBanner
            host={selectedHost}
            busyKeys={busyKeys}
            onProvisionHost={(h) => void handleProvisionHost(h)}
            onCheckHosts={() => void handleCheckHosts()}
          />
        ) : null}

        {reportBanner ? (
          <FleetStorageReportBanner report={reportBanner} onClose={() => setReportBanner(null)} />
        ) : null}

        {selectedHost ? (
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <div className="space-y-4">
              <FleetThreadsPanel environmentId={environmentId} host={selectedHost} />
              <FleetJobsAndProcsPanel
                key={selectedHost.id}
                host={selectedHost}
                hostJobs={hostJobs}
                selectedJobId={selectedJobId}
                nowMs={nowMs}
                busyKeys={busyKeys}
                onInspectJob={(id) => setConsoleJobId(id)}
                onCancelJob={(id) => void handleCancelJob(id)}
                onCloseSession={(sess) => void handleCloseSession(sess)}
              />
            </div>
            <div className="space-y-4">
              <FleetLocalhostsPanel
                host={selectedHost}
                busyKeys={busyKeys}
                onServerAction={(srv, verb) => void handleServerAction(srv, verb)}
              />
            </div>
          </div>
        ) : (
          <FleetOfflineJobsFallback
            hostJobs={hostJobs}
            nowMs={nowMs}
            onInspectJob={(id) => setConsoleJobId(id)}
          />
        )}
      </div>

      <Sheet
        open={inspectedJob !== null}
        onOpenChange={(open) => {
          if (!open) setConsoleJobId(null);
        }}
      >
        <SheetPopup
          side="right"
          className="w-[min(92vw,48rem)] max-w-3xl wco:mt-(--workspace-topbar-height) wco:h-[calc(100%-var(--workspace-topbar-height))] wco:max-h-[calc(100%-var(--workspace-topbar-height))]"
          data-testid="job-inspector-drawer"
        >
          <SheetHeader>
            <SheetTitle>
              <T>Job Inspector</T>
            </SheetTitle>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-y-auto border-t border-border/60 p-4">
            {inspectedJob && inspectedTarget ? (
              <DevtoolsErrorBoundary
                panelName="Job Inspector"
                resetKeys={[inspectedTarget.environmentId, inspectedJob.id, inspectedJob.revision]}
              >
                <ManagedJobInspector
                  key={inspectedJob.id}
                  environmentId={inspectedTarget.environmentId}
                  job={{ ...inspectedJob, id: inspectedTarget.jobId }}
                  nowMs={nowMs}
                  localHost={selectedHost?.telemetry ?? null}
                  hosts={hosts}
                  cancelling={busyKeys.has(`job:${inspectedJob.id}`)}
                  onCancel={() => void handleCancelJob(inspectedJob.id)}
                  onOpenThread={(threadId) =>
                    handleOpenThread(threadId, inspectedTarget.environmentId)
                  }
                />
              </DevtoolsErrorBoundary>
            ) : null}
          </div>
        </SheetPopup>
      </Sheet>
    </div>
  );
}
