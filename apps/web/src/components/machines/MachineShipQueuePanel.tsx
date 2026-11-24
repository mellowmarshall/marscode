import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ShipQueueDepDecision,
  type ShipQueueDepRepo,
  type ThreadId,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { T, useGT, useMessages, Var } from "gt-react";
import { ShieldQuestionIcon, ShipIcon } from "lucide-react";
import { useState } from "react";

import { useNowSecond } from "../../hooks/useNowSecond";
import {
  buildShipQueueDepApproval,
  depHoldReportKey,
  findActionableDepHoldForJob,
  isDepHoldActionable,
} from "../../lib/shipQueueApprovals";
import { isShipQueueJobLive, parseShipJobStartMs } from "../../lib/shipQueueSteps";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import {
  canDecideShipQueueDepsAtom,
  clearShipQueueRepoBusy,
  markShipQueueRepoBusy,
  shipQueueBusyAtom,
  useShipQueueSnapshot,
} from "../../state/shipQueue";
import { environmentThreadShells } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Input } from "../ui/input";
import { ShipQueueTableRow } from "./ShipQueueTableRow";

export function MachineShipQueuePanel({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const gt = useGT();
  const resolve = useMessages();
  const navigate = useNavigate();
  const nowMs = useNowSecond();

  const snap = useShipQueueSnapshot(environmentId);
  const canDecide = useAtomValue(canDecideShipQueueDepsAtom(environmentId));
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const busyState = useAtomValue(shipQueueBusyAtom);
  const threads = useAtomValue(environmentThreadShells.environmentThreadsAtom(environmentId));

  const cancelShipQueueJob = useAtomCommand(serverEnvironment.cancelShipQueueJob, {
    reportFailure: false,
  });
  const decideShipQueueDeps = useAtomCommand(serverEnvironment.decideShipQueueDeps, {
    reportFailure: false,
  });
  const scanShipQueueDeps = useAtomCommand(serverEnvironment.scanShipQueueDeps, {
    reportFailure: false,
  });

  const [query, setQuery] = useState("");
  const [repoFilter, setRepoFilter] = useState("all");
  const [cancellingJobId, setCancellingJobId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const liveThreadIds = new Set<string>(
    threads.filter((t) => t.deletedAt === null && t.archivedAt === null).map((t) => t.id),
  );

  const repos = [
    ...new Set([
      ...snap.jobs.map((j) => j.repo).filter((r): r is string => Boolean(r)),
      ...snap.deps.map((d) => d.repo),
    ]),
  ].toSorted();

  const scanningRepos: Record<string, string | null> = {};
  for (const [repo, entry] of Object.entries(busyState.scanning)) {
    if (entry.untilMs > nowMs) scanningRepos[repo] = entry.reportKey;
  }
  const decidingRepos: Record<string, string | null> = {};
  for (const [repo, entry] of Object.entries(busyState.deciding)) {
    if (entry.untilMs > nowMs) decidingRepos[repo] = entry.reportKey;
  }

  const normalizedQuery = query.trim().toLowerCase();
  const matchingJobs = snap.jobs.filter((job) => {
    if (repoFilter !== "all" && job.repo !== repoFilter) return false;
    if (!normalizedQuery) return true;
    const haystack = [
      job.id,
      job.repo,
      job.branch,
      job.title,
      job.pr,
      job.routeHost,
      job.reason,
      job.state,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return haystack.includes(normalizedQuery);
  });

  const activeJobs = matchingJobs
    .filter(isShipQueueJobLive)
    .toSorted((a, b) => (parseShipJobStartMs(b) ?? 0) - (parseShipJobStartMs(a) ?? 0));
  const recentJobs = matchingJobs
    .filter((job) => !isShipQueueJobLive(job))
    .toSorted((a, b) => (parseShipJobStartMs(b) ?? 0) - (parseShipJobStartMs(a) ?? 0));

  const actionableHolds = snap.deps.filter((dep) => {
    if (!isDepHoldActionable(dep)) return false;
    if (repoFilter !== "all" && dep.repo !== repoFilter) return false;
    return true;
  });

  const totalActiveCount = snap.jobs.filter(isShipQueueJobLive).length;
  const totalFailedCount = snap.jobs.filter(
    (j) => !isShipQueueJobLive(j) && j.state.toLowerCase().includes("fail"),
  ).length;
  const totalHoldCount = snap.deps.filter(isDepHoldActionable).length;

  const handleOpenThread = (threadId: ThreadId) => {
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId },
    });
  };

  const handleCancelJob = async (jobId: string) => {
    if (!canOperate || cancellingJobId !== null) return;
    setCancellingJobId(jobId);
    setActionError(null);
    const result = await cancelShipQueueJob({
      environmentId,
      input: { jobId },
    });
    setCancellingJobId(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      setActionError(thrownErrorMessage(failure, resolve) ?? gt("Failed to cancel ship job."));
    } else if (result._tag === "Success" && !result.value.ok) {
      setActionError(result.value.error ?? gt("Failed to cancel ship job."));
    }
  };

  const handleDecide = async (hold: ShipQueueDepRepo, decision: ShipQueueDepDecision) => {
    if (!canDecide || !hold.reportId) return;
    const reportKey = depHoldReportKey(hold);
    setActionError(null);
    markShipQueueRepoBusy("deciding", hold.repo, reportKey);
    const result = await decideShipQueueDeps({
      environmentId,
      input: { reportId: hold.reportId, decision },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      clearShipQueueRepoBusy("deciding", hold.repo, reportKey);
      const failure = squashAtomCommandFailure(result);
      setActionError(
        thrownErrorMessage(failure, resolve) ?? gt("Failed to submit dependency decision."),
      );
    } else if (result._tag === "Success" && !result.value.ok) {
      clearShipQueueRepoBusy("deciding", hold.repo, reportKey);
      setActionError(result.value.error ?? gt("Failed to submit dependency decision."));
    } else if (result._tag === "Success" && result.value.started !== true) {
      clearShipQueueRepoBusy("deciding", hold.repo, reportKey);
    }
  };

  const handleScan = async (hold: ShipQueueDepRepo) => {
    if (!canDecide) return;
    const reportKey = depHoldReportKey(hold);
    setActionError(null);
    markShipQueueRepoBusy("scanning", hold.repo, reportKey);
    const result = await scanShipQueueDeps({
      environmentId,
      input: { repo: hold.repo },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      clearShipQueueRepoBusy("scanning", hold.repo, reportKey);
      const failure = squashAtomCommandFailure(result);
      setActionError(
        thrownErrorMessage(failure, resolve) ?? gt("Failed to start dependency scan."),
      );
    } else if (result._tag === "Success" && !result.value.ok) {
      clearShipQueueRepoBusy("scanning", hold.repo, reportKey);
      setActionError(result.value.error ?? gt("Failed to start dependency scan."));
    } else if (result._tag === "Success" && result.value.started !== true) {
      clearShipQueueRepoBusy("scanning", hold.repo, reportKey);
    }
  };

  if (!snap.available) {
    return (
      <section className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-border/70 bg-card p-4">
        <Empty size="compact">
          <EmptyMedia variant="icon">
            <ShipIcon />
          </EmptyMedia>
          <EmptyHeader>
            <EmptyTitle>
              <T>Ship Queue unavailable</T>
            </EmptyTitle>
            <EmptyDescription>
              <T>No ship-queue installation was detected on this machine.</T>
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </section>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <section className="flex min-w-0 flex-col gap-3 rounded-xl border border-border/70 bg-card px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-medium text-foreground">
              <T>Ship Queue</T>
            </h2>
            <Badge size="sm" variant={snap.daemonRunning ? "success" : "warning"}>
              {snap.daemonRunning ? <T>Daemon running</T> : <T>Daemon stopped</T>}
            </Badge>
            <Badge size="sm" variant="info">
              <T>
                <Var>{totalActiveCount}</Var> active
              </T>
            </Badge>
            {totalFailedCount > 0 ? (
              <Badge size="sm" variant="error">
                <T>
                  <Var>{totalFailedCount}</Var> failed
                </T>
              </Badge>
            ) : null}
            {totalHoldCount > 0 ? (
              <Badge size="sm" variant="warning">
                <T>
                  <Var>{totalHoldCount}</Var> holds
                </T>
              </Badge>
            ) : null}
          </div>

          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
            <Input
              aria-label={gt("Filter ship jobs")}
              className="w-full sm:w-56"
              placeholder={gt("Search branch, title, PR…")}
              size="compact"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            {repos.length > 1 ? (
              <select
                aria-label={gt("Filter by repository")}
                className="h-7 rounded-md border border-input bg-background px-2 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                value={repoFilter}
                onChange={(event) => setRepoFilter(event.target.value)}
              >
                <option value="all">{gt("All repos")}</option>
                {repos.map((repo) => (
                  <option key={repo} value={repo}>
                    {repo}
                  </option>
                ))}
              </select>
            ) : null}
          </div>
        </div>

        {actionError ? (
          <p role="alert" className="text-xs text-destructive-foreground">
            {actionError}
          </p>
        ) : null}
      </section>

      {actionableHolds.length > 0 ? (
        <section className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-warning/40 bg-card">
          <div className="flex items-center justify-between gap-2 border-b border-border/60 bg-warning/8 px-4 py-2.5">
            <div className="flex items-center gap-2">
              <ShieldQuestionIcon aria-hidden className="size-4 text-warning-foreground" />
              <h3 className="text-sm font-medium text-foreground">
                <T>Dependency holds</T>
              </h3>
              <Badge size="sm" variant="warning">
                {actionableHolds.length}
              </Badge>
            </div>
          </div>

          <ul className="m-0 divide-y divide-border/50 p-0">
            {actionableHolds.map((hold) => {
              const entry = buildShipQueueDepApproval({
                hold,
                scanningRepos,
                decidingRepos,
                nowMs,
                resolve,
              });
              return (
                <li
                  key={hold.repo}
                  className="flex flex-col gap-3 px-4 py-3 md:flex-row md:items-start md:justify-between"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-foreground">{hold.repo}</span>
                      {hold.reportId ? (
                        <span className="font-mono text-2xs text-muted-foreground">
                          {hold.reportId}
                        </span>
                      ) : null}
                      {entry.deciding ? (
                        <Badge size="sm" variant="info">
                          <T>Updating…</T>
                        </Badge>
                      ) : entry.scanning ? (
                        <Badge size="sm" variant="info">
                          <T>Scanning…</T>
                        </Badge>
                      ) : null}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">{entry.approval.reason}</p>
                    {hold.updates.length > 0 ? (
                      <ul className="mt-1.5 flex flex-wrap gap-1.5 p-0">
                        {hold.updates.slice(0, 5).map((u) => (
                          <li
                            key={`${u.packageFile}:${u.depName}`}
                            className="list-none rounded border border-border/60 bg-muted/35 px-1.5 py-0.5 font-mono text-2xs text-foreground"
                          >
                            {u.depName}: {u.currentValue} → {u.newValue}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>

                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    {entry.canReject ? (
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={!canDecide || entry.busy}
                        onClick={() => void handleDecide(hold, "reject")}
                      >
                        <T>Reject (24h)</T>
                      </Button>
                    ) : null}
                    {entry.canApprove ? (
                      <Button
                        size="xs"
                        variant="default"
                        disabled={!canDecide || entry.busy}
                        onClick={() => void handleDecide(hold, "approve")}
                      >
                        <T>Approve</T>
                      </Button>
                    ) : null}
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={!canDecide || entry.busy}
                      onClick={() => void handleScan(hold)}
                    >
                      {entry.scanning ? <T>Scanning…</T> : <T>Rescan</T>}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {snap.jobs.length === 0 ? (
        <section className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-border/70 bg-card p-4">
          <Empty size="compact">
            <EmptyMedia variant="icon">
              <ShipIcon />
            </EmptyMedia>
            <EmptyHeader>
              <EmptyTitle>
                <T>No ship jobs yet</T>
              </EmptyTitle>
              <EmptyDescription>
                <T>Submitted merge and deploy jobs on this machine appear here.</T>
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </section>
      ) : activeJobs.length === 0 && recentJobs.length === 0 ? (
        <section className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-border/70 bg-card p-4">
          <Empty size="compact">
            <EmptyMedia variant="icon">
              <ShipIcon />
            </EmptyMedia>
            <EmptyHeader>
              <EmptyTitle>
                <T>No matching ship jobs</T>
              </EmptyTitle>
              <EmptyDescription>
                <T>Adjust the search query or repository filter above.</T>
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </section>
      ) : (
        <>
          {activeJobs.length > 0 ? (
            <section className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-border/70 bg-card">
              <div className="flex items-center justify-between gap-2 border-b border-border/60 px-4 py-2.5">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-medium text-foreground">
                    <T>Active</T>
                  </h3>
                  <Badge size="sm" variant="info">
                    {activeJobs.length}
                  </Badge>
                </div>
              </div>
              <ul className="m-0 divide-y divide-border/50 p-0">
                {activeJobs.map((job) => (
                  <ShipQueueTableRow
                    key={job.id}
                    job={job}
                    depHold={findActionableDepHoldForJob(job, snap.deps)}
                    threadExists={Boolean(job.threadId && liveThreadIds.has(job.threadId))}
                    nowMs={nowMs}
                    canOperate={canOperate}
                    cancelling={cancellingJobId === job.id}
                    onOpenThread={handleOpenThread}
                    onCancel={(id) => void handleCancelJob(id)}
                  />
                ))}
              </ul>
            </section>
          ) : null}

          {recentJobs.length > 0 ? (
            <section className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-border/70 bg-card">
              <div className="flex items-center justify-between gap-2 border-b border-border/60 px-4 py-2.5">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-medium text-foreground">
                    <T>Recent</T>
                  </h3>
                  <Badge size="sm" variant="secondary">
                    {recentJobs.length}
                  </Badge>
                </div>
              </div>
              <ul className="m-0 divide-y divide-border/50 p-0">
                {recentJobs.map((job) => (
                  <ShipQueueTableRow
                    key={job.id}
                    job={job}
                    depHold={null}
                    threadExists={Boolean(job.threadId && liveThreadIds.has(job.threadId))}
                    nowMs={nowMs}
                    canOperate={canOperate}
                    cancelling={cancellingJobId === job.id}
                    onOpenThread={handleOpenThread}
                    onCancel={(id) => void handleCancelJob(id)}
                  />
                ))}
              </ul>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}
