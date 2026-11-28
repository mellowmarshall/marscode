/**
 * Thread-scoped right-rail inspector sections rendered inside `ThreadDetailsPanel`.
 * Shows active thread Ship Queue jobs (plus latest failed until dismissed or done for linger window),
 * active thread MCP jobs (with live tail + non-occluded elapsed timer), and the thread's device leases
 * (its DeviceService sessions) and actionable devdeck sessions.
 */
import { useEffect, useState } from "react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { T, useGT } from "gt-react";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  CpuIcon,
  SmartphoneIcon,
  XCircleIcon,
} from "lucide-react";

import { ThreadDetailsSection } from "../components/chat/ThreadDetailsSection";
import { readIssueListPreferences } from "../components/issue/issueListPreferences";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { useQuietThreadShell } from "../state/entities";
import { runTrackedDevdeckAction, type ShipQueueJob } from "./devtoolsClient";
import { DevtoolsErrorBoundary } from "./DevtoolsErrorBoundary";
import { useCompletedShipLingerMinutes } from "./devtoolsPreferences";
import { openFleetConsole } from "./devtoolsStore";
import { useDeviceState } from "../state/device";
import { refreshSharedDevdeck, useSharedDevdeck } from "./devtoolsStreams";
import {
  cancelTrackedJob,
  matchJobToThread,
  refreshSharedJobs,
  useSharedJobs,
} from "./jobs/jobsStore";
import { isHostJob, isJobLive } from "./jobs/jobTypes";
import { ThreadManagedJobCard } from "./jobs/ThreadManagedJobCard";
import { useLiveClockMs } from "./liveClock";
import { ShipQueueMiniCard } from "./ShipQueueMiniCard";
import { isShipQueueJobLive } from "./ShipQueueSteps";
import { TruncatedText } from "./TruncatedText";
import {
  addBoundedDismiss,
  formatCompactMem,
  matchThreadJobs,
  matchThreadSessions,
  normalizeDirectoryPath,
  selectVisibleThreadManagedJobs,
  selectVisibleThreadShipJobs,
  shipJobKey,
} from "./threadShipStatus";

const dismissedShipJobKeys = new Set<string>();
const dismissedManagedJobIds = new Set<string>();

function ThreadDevtoolsPanelInner({
  environmentId,
  threadId,
  gitCwd,
  worktreePath,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly gitCwd: string | null;
  readonly worktreePath: string | null;
}) {
  const gt = useGT();
  const navigate = useNavigate();
  const threadShell = useQuietThreadShell(scopeThreadRef(environmentId, threadId));
  const branch = threadShell?.branch ?? null;
  const dedicatedWorktree = normalizeDirectoryPath(worktreePath ?? threadShell?.worktreePath);
  const normGitCwd = normalizeDirectoryPath(gitCwd);

  const jobsState = useSharedJobs(environmentId);
  const devdeckState = useSharedDevdeck(environmentId, "passive");
  const deviceState = useDeviceState(environmentId).state;

  const [jobIndex, setJobIndex] = useState(0);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [closingSessionId, setClosingSessionId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // Starts at mount: with no live job the shared clock is stopped and its time can be old.
  const [lingerClockMs, setLingerClockMs] = useState(() => Date.now());
  const [dismissedShipKeys, setDismissedShipKeys] = useState<ReadonlySet<string>>(
    () => new Set(dismissedShipJobKeys),
  );
  const [dismissedMcpIds, setDismissedMcpIds] = useState<ReadonlySet<string>>(
    () => new Set(dismissedManagedJobIds),
  );

  const matchedManagedJobs = jobsState.jobs.filter(
    (job) =>
      isHostJob(job) && matchJobToThread(job, threadId, branch, dedicatedWorktree, normGitCwd),
  );
  const allShipJobs: ReadonlyArray<ShipQueueJob> = jobsState.jobs.flatMap((j) =>
    j.source === "ship-queue" && j.shipJob ? [j.shipJob] : [],
  );
  const matchedShipJobs = matchThreadJobs(
    allShipJobs,
    threadId,
    branch,
    dedicatedWorktree,
    normGitCwd,
  );

  const hasLiveJob = matchedManagedJobs.some(isJobLive) || matchedShipJobs.some(isShipQueueJobLive);
  const liveNowMs = useLiveClockMs(hasLiveJob);
  const nowMs = Math.max(liveNowMs, lingerClockMs);

  const [shipLingerMinutes] = useCompletedShipLingerMinutes();
  const lingerMs = Number(shipLingerMinutes) * 60 * 1000;
  const {
    jobs: threadManagedJobs,
    lingerUntilMs: managedLingerUntilMs,
    hiddenLiveCount,
  } = selectVisibleThreadManagedJobs(matchedManagedJobs, nowMs, dismissedMcpIds, lingerMs);
  const { jobs: threadJobs, lingerUntilMs: shipLingerUntilMs } = selectVisibleThreadShipJobs(
    matchedShipJobs,
    nowMs,
    dismissedShipKeys,
    lingerMs,
  );
  const clampedIndex = Math.min(jobIndex, Math.max(0, threadJobs.length - 1));
  const activeJob = threadJobs[clampedIndex] ?? null;

  const nextLingerUntilMs =
    managedLingerUntilMs !== null && shipLingerUntilMs !== null
      ? Math.min(managedLingerUntilMs, shipLingerUntilMs)
      : (managedLingerUntilMs ?? shipLingerUntilMs);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- one-shot timer to auto-hide completed job once linger window expires
  useEffect(() => {
    if (nextLingerUntilMs === null) return;
    const delay = Math.max(0, nextLingerUntilMs - Date.now()) + 50;
    const timer = setTimeout(() => {
      setLingerClockMs(Date.now());
    }, delay);
    return () => clearTimeout(timer);
  }, [nextLingerUntilMs]);

  // DeviceService leases each device to one thread, so its sessions are this thread's leases.
  const threadLeases = deviceState.sessions
    .filter((session) => session.threadId === threadId)
    .map((session) => ({
      ...session,
      key: `${session.hostId}\u0000${session.deviceId}`,
      name:
        deviceState.devices.find(
          (device) => device.hostId === session.hostId && device.id === session.deviceId,
        )?.name ?? session.deviceId,
      host: deviceState.hosts.find((host) => host.id === session.hostId)?.label ?? session.hostId,
    }));
  const allSessions = devdeckState.panels?.sessions ?? [];
  const threadSessions = matchThreadSessions(allSessions, branch, dedicatedWorktree, normGitCwd);

  const openShipQueuePage = () => {
    void navigate({
      to: "/issues",
      search: {
        ...readIssueListPreferences(),
        view: "ship-queue" as const,
        shipEnv: environmentId,
      },
    });
  };

  const openHostJobs = (jobId?: string | null, host?: string | null) => {
    openFleetConsole({
      section: "machines",
      ...(host ? { host } : {}),
      jobId: jobId ?? null,
      envId: environmentId,
    });
  };

  const handleCancelJob = async (jobId: string) => {
    setCancellingId(jobId);
    setActionError(null);
    const fullId = jobId.includes(":") ? jobId : `ship:${jobId}`;
    const res = await cancelTrackedJob(environmentId, fullId);
    setCancellingId(null);
    if (!res.ok) {
      setActionError(res.error ?? gt("Failed to cancel job"));
    } else {
      void refreshSharedJobs(environmentId);
    }
  };

  const handleCloseSession = async (sessionId: string) => {
    setClosingSessionId(sessionId);
    setActionError(null);
    const res = await runTrackedDevdeckAction(
      environmentId,
      `/sessions/${encodeURIComponent(sessionId)}/close`,
    );
    setClosingSessionId(null);
    if (!res.ok) {
      setActionError(res.error ?? gt("Failed to close session"));
    } else {
      void refreshSharedDevdeck(environmentId);
    }
  };

  const hasManagedJobs = threadManagedJobs.length > 0;
  const hasShipContent = activeJob !== null;
  const hasRuntimeItems = threadLeases.length > 0 || threadSessions.length > 0;

  if (!hasManagedJobs && !hasShipContent && !hasRuntimeItems) {
    return null;
  }

  return (
    <>
      {hasManagedJobs ? (
        <ThreadDetailsSection
          data-thread-devtools-panel
          headingId="thread-details-jobs-heading"
          title={gt("Jobs")}
          actions={
            <Button
              size="xs"
              variant="ghost"
              onClick={() =>
                openHostJobs(threadManagedJobs[0]?.id, threadManagedJobs[0]?.binding.host)
              }
            >
              <T>Fleet</T>
            </Button>
          }
        >
          <div className="space-y-1.5 px-2.5">
            {actionError && !activeJob ? (
              <div className="text-3xs text-destructive">{actionError}</div>
            ) : null}
            {threadManagedJobs.map((job) => (
              <ThreadManagedJobCard
                key={job.id}
                job={job}
                nowMs={nowMs}
                cancelling={cancellingId === job.id}
                onCancel={() => void handleCancelJob(job.id)}
                onDismiss={() =>
                  setDismissedMcpIds(addBoundedDismiss(dismissedManagedJobIds, job.id))
                }
                onInspect={() => openHostJobs(job.id, job.binding.host)}
              />
            ))}
            {hiddenLiveCount > 0 ? (
              <Button
                size="xs"
                variant="ghost-muted"
                className="w-full justify-center"
                onClick={() => openHostJobs(threadManagedJobs[0]?.id)}
              >
                {gt("+{n} more in Fleet", { n: hiddenLiveCount })}
              </Button>
            ) : null}
          </div>
        </ThreadDetailsSection>
      ) : null}

      {hasShipContent ? (
        <ThreadDetailsSection
          data-thread-devtools-panel
          headingId="thread-details-ship-queue-heading"
          title={gt("Ship Queue")}
          actions={
            <div className="flex items-center gap-1">
              {threadJobs.length > 1 ? (
                <div className="flex items-center gap-0.5 text-3xs text-muted-foreground tabular-nums">
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={clampedIndex === 0}
                    aria-label={gt("Newer job")}
                    onClick={() => setJobIndex(Math.max(0, clampedIndex - 1))}
                  >
                    <ChevronLeftIcon className="size-3" />
                  </Button>
                  <span className="font-mono">{`${clampedIndex + 1}/${threadJobs.length}`}</span>
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={clampedIndex >= threadJobs.length - 1}
                    aria-label={gt("Older job")}
                    onClick={() => setJobIndex(Math.min(threadJobs.length - 1, clampedIndex + 1))}
                  >
                    <ChevronRightIcon className="size-3" />
                  </Button>
                </div>
              ) : null}
              <Button size="xs" variant="ghost" onClick={openShipQueuePage}>
                <T>All</T>
              </Button>
            </div>
          }
        >
          <div className="space-y-1.5 px-2.5">
            {activeJob ? (
              <ShipQueueMiniCard
                job={activeJob}
                nowMs={nowMs}
                cancelling={cancellingId === activeJob.id}
                actionError={actionError}
                onCancel={() => activeJob.id && void handleCancelJob(activeJob.id)}
                onDismiss={() =>
                  setDismissedShipKeys(
                    addBoundedDismiss(dismissedShipJobKeys, shipJobKey(activeJob)),
                  )
                }
              />
            ) : null}
          </div>
        </ThreadDetailsSection>
      ) : null}

      {hasRuntimeItems ? (
        <ThreadDetailsSection
          data-thread-devtools-panel
          headingId="thread-details-runtime-heading"
          title={gt("Leases & Sessions")}
        >
          <div className="space-y-2 px-2.5 text-2xs">
            {!activeJob && actionError ? (
              <div className="text-3xs text-destructive">{actionError}</div>
            ) : null}

            {threadLeases.map((lease) => (
              <div
                key={lease.key}
                className="space-y-0.5 rounded-md border bg-muted/20 px-2 py-1.5"
              >
                <div className="flex items-center justify-between gap-1.5">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <SmartphoneIcon className="size-3 shrink-0 text-muted-foreground" />
                    <TruncatedText
                      as="span"
                      text={lease.name}
                      variant="code"
                      className="min-w-0 truncate font-mono font-medium"
                    />
                  </div>
                  <Badge variant="secondary">{lease.platform}</Badge>
                </div>
                <div className="flex flex-wrap gap-x-2 font-mono text-3xs text-muted-foreground tabular-nums">
                  <span>{lease.deviceId}</span>
                  <span>{lease.host}</span>
                </div>
              </div>
            ))}

            {threadSessions.map((sess) => {
              const sid = sess.id ?? `${sess.kind ?? "proc"}:${sess.pid ?? 0}`;
              const mem = formatCompactMem(sess.mem_bytes);
              const cpu =
                typeof sess.cpu_pct === "number" && sess.cpu_pct >= 1
                  ? `${Math.round(sess.cpu_pct)}%`
                  : "";
              return (
                <div
                  key={sid}
                  className="flex items-center justify-between gap-1.5 rounded-md border bg-muted/20 px-2 py-1.5"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-1">
                      <CpuIcon className="size-3 shrink-0 text-muted-foreground" />
                      <span className="truncate font-medium">{sess.name ?? sess.kind ?? sid}</span>
                    </div>
                    <div className="flex flex-wrap gap-x-2 font-mono text-3xs text-muted-foreground tabular-nums">
                      {sess.endpoint ? <span>{sess.endpoint}</span> : null}
                      {cpu ? <span>{cpu}</span> : null}
                      {mem ? <span>{mem}</span> : null}
                      {sess.orphaned ? (
                        <span className="text-warning">
                          <T>orphaned</T>
                        </span>
                      ) : sess.idle ? (
                        <span>
                          <T>idle</T>
                        </span>
                      ) : null}
                    </div>
                  </div>
                  {sess.id && sess.close_allowed ? (
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={closingSessionId === sess.id}
                      aria-label={gt("Close session")}
                      onClick={() => void handleCloseSession(sess.id!)}
                    >
                      <XCircleIcon className="size-3 text-muted-foreground hover:text-destructive" />
                    </Button>
                  ) : null}
                </div>
              );
            })}
          </div>
        </ThreadDetailsSection>
      ) : null}
    </>
  );
}

export function ThreadDevtoolsPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly gitCwd: string | null;
  readonly worktreePath: string | null;
}) {
  const key = `${props.environmentId}:${props.threadId}`;
  return (
    <DevtoolsErrorBoundary panelName="Thread DevTools" compact resetKeys={[key]}>
      <ThreadDevtoolsPanelInner key={key} {...props} />
    </DevtoolsErrorBoundary>
  );
}
