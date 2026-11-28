/** DevDeck-style Ship Queue panel embedded in T3's Issues page (`Issues | Ship Queue`). */
import { useState } from "react";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { T, Var, useGT } from "gt-react";
import { RefreshCwIcon } from "lucide-react";

import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { useQuietThreadShells } from "../state/entities";
import type { ShipQueueJob } from "./devtoolsClient";
import { refreshSharedShipQueueDeps, useSharedShipQueueDeps } from "./devtoolsDepsStore";
import { DevtoolsErrorBoundary } from "./DevtoolsErrorBoundary";
import { DevtoolsStateBanner } from "./DevtoolsStateBanner";
import { cancelTrackedJob, refreshSharedJobs, useSharedJobs } from "./jobs/jobsStore";
import { useLiveClockMs } from "./liveClock";
import { compareShipJobsNewestFirst, shipJobRepoName } from "./shipQueueJobFacts";
import { isShipQueueJobLive } from "./ShipQueueSteps";
import { SHIP_QUEUE_GRID_COLUMNS, ShipQueueTableRow } from "./ShipQueueTableRow";
import { findActionableDepHoldForJob } from "./threadApprovals";

function ShipQueuePanelInner({ environmentId }: { readonly environmentId: EnvironmentId | null }) {
  const gt = useGT();
  const navigate = useNavigate();
  const allThreads = useQuietThreadShells();
  const jobsState = useSharedJobs(environmentId);
  const envThreads = environmentId
    ? allThreads.filter(
        (t) => t.environmentId === environmentId && t.deletedAt === null && t.archivedAt === null,
      )
    : [];
  const resolveLiveThreadId = (rawThreadId: string | undefined): ThreadId | null => {
    if (!rawThreadId) return null;
    if (envThreads.length === 0) return null;
    let cur = envThreads.find((t) => t.id === rawThreadId);
    if (!cur) return null;
    const seen = new Set<ThreadId>([cur.id]);
    while (cur.lineage.relationshipToParent === "subagent" && cur.lineage.parentThreadId !== null) {
      const parent = envThreads.find((t) => t.id === cur!.lineage.parentThreadId);
      if (!parent || seen.has(parent.id)) break;
      seen.add(parent.id);
      cur = parent;
    }
    return cur.id;
  };
  const [repoFilter, setRepoFilter] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const revisions = new Map<ShipQueueJob, number>();
  const shipJobs: ReadonlyArray<ShipQueueJob> = jobsState.jobs.flatMap((j) => {
    if (j.source !== "ship-queue" || !j.shipJob) return [];
    revisions.set(j.shipJob, j.revision);
    return [j.shipJob];
  });
  const hasLive = shipJobs.some(isShipQueueJobLive);
  const nowMs = useLiveClockMs(hasLive);
  const depsState = useSharedShipQueueDeps(environmentId, !jobsState.unsupported && hasLive);
  const depsRepos = depsState.payload?.repos ?? [];

  const repos = Array.from(
    new Set(shipJobs.map((j) => j.repo).filter(Boolean) as string[]),
  ).toSorted();
  const needle = query.trim().toLowerCase();
  const filtered = shipJobs.filter((j) => {
    if (repoFilter !== "all" && j.repo !== repoFilter) return false;
    if (!needle) return true;
    const hay =
      `${j.id ?? ""} ${j.repo ?? ""} ${j.title ?? ""} ${j.branch ?? ""} ${j.pr ?? ""}`.toLowerCase();
    return hay.includes(needle);
  });

  const activeJobs = filtered.filter(isShipQueueJobLive);
  const recentJobs = filtered
    .filter((j) => !isShipQueueJobLive(j))
    .toSorted(compareShipJobsNewestFirst)
    .slice(0, 40);
  const repoLabel = (repo: string) => shipJobRepoName({ repo }) ?? repo;
  const failedRecentCount = recentJobs.filter((j) =>
    (j.state ?? j.display_state ?? "").toLowerCase().includes("fail"),
  ).length;

  const handleCancel = async (id: string) => {
    if (!environmentId) return;
    setCancellingId(id);
    setActionError(null);
    const res = await cancelTrackedJob(environmentId, `ship:${id}`);
    setCancellingId(null);
    if (!res.ok) {
      setActionError(res.error ?? gt("Failed to cancel ship job"));
    } else {
      void refreshSharedJobs(environmentId);
    }
  };

  const handleOpenThread = (threadId: string) => {
    if (!environmentId) return;
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId: threadId as ThreadId },
    });
  };

  if (!environmentId) {
    return (
      <div className="rounded-lg border border-border/60 p-6 text-center text-xs text-muted-foreground">
        <T>Connect an environment to view Ship Queue jobs.</T>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            size="sm"
            className="w-56"
            placeholder={gt("Filter jobs, PRs, branches…")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {repos.length > 1 ? (
            <Select value={repoFilter} onValueChange={(v) => v && setRepoFilter(v)}>
              <SelectTrigger size="sm" className="w-36" aria-label={gt("Filter by repository")}>
                <SelectValue>
                  {repoFilter === "all" ? gt("All repos") : repoLabel(repoFilter)}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="start">
                <SelectItem value="all">{gt("All repos")}</SelectItem>
                {repos.map((r) => (
                  <SelectItem key={r} value={r}>
                    {repoLabel(r)}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          ) : null}
          {activeJobs.length > 0 ? (
            <Badge size="sm" variant="info">
              <T>
                <Var>{activeJobs.length}</Var> active
              </T>
            </Badge>
          ) : null}
          {failedRecentCount > 0 ? (
            <Badge size="sm" variant="error">
              <T>
                <Var>{failedRecentCount}</Var> failed
              </T>
            </Badge>
          ) : null}
        </div>
        <Button
          size="xs"
          variant="outline"
          onClick={() => {
            void refreshSharedJobs(environmentId);
            refreshSharedShipQueueDeps(environmentId);
          }}
        >
          <RefreshCwIcon className="mr-1 size-3" />
          <T>Refresh</T>
        </Button>
      </div>

      {actionError || jobsState.error ? (
        <DevtoolsStateBanner
          compact
          status={
            actionError
              ? "error"
              : jobsState.status === "ready" || jobsState.status === "connecting"
                ? "error"
                : jobsState.status
          }
          title={actionError ?? jobsState.error ?? gt("Ship Queue error")}
          onRetry={() => {
            setActionError(null);
            void refreshSharedJobs(environmentId);
            refreshSharedShipQueueDeps(environmentId);
          }}
        />
      ) : null}

      <div className="overflow-hidden rounded-lg border border-border/70 bg-card/40">
        <div
          className={`${SHIP_QUEUE_GRID_COLUMNS} items-center border-b border-border/70 bg-muted/25 px-3 py-1.5 text-3xs font-medium uppercase tracking-wide text-muted-foreground`}
        >
          <span />
          <span>
            <T>Queue #</T>
          </span>
          <span>
            <T>Repo · CI host</T>
          </span>
          <span>
            <T>PR</T>
          </span>
          <span>
            <T>Title</T>
          </span>
          <span className="text-right">
            <T>State</T>
          </span>
          <span className="text-right">
            <T>When</T>
          </span>
          <span />
        </div>

        {jobsState.unsupported ? (
          <div className="px-4 py-8 text-center text-xs text-muted-foreground">
            <T>Devtools API is not supported on this host.</T>
          </div>
        ) : activeJobs.length === 0 && recentJobs.length === 0 ? (
          <div className="px-4 py-8 text-center text-xs text-muted-foreground">
            {!jobsState.live && jobsState.error ? (
              <T>Disconnected from Ship Queue.</T>
            ) : !jobsState.live ? (
              <T>Connecting to Ship Queue…</T>
            ) : (
              <T>No Ship Queue jobs match the current filter.</T>
            )}
          </div>
        ) : (
          <>
            {activeJobs.map((job, idx) => {
              const id = job.id
                ? String(job.id)
                : `${job.repo ?? "repo"}:${job.branch ?? "job"}:${job.submitted_at ?? idx}`;
              const liveThreadId = resolveLiveThreadId(job.thread_id);
              const depHold =
                liveThreadId !== null ? findActionableDepHoldForJob(job, depsRepos) : null;
              return (
                <ShipQueueTableRow
                  key={id}
                  job={job}
                  revision={revisions.get(job) ?? 0}
                  environmentId={environmentId}
                  depHeld={depHold !== null}
                  expanded={expandedId === id}
                  nowMs={nowMs}
                  cancelling={cancellingId === id}
                  onToggleExpand={() => setExpandedId((cur) => (cur === id ? null : id))}
                  onCancel={() => job.id && void handleCancel(job.id)}
                  onOpenThread={
                    liveThreadId !== null ? () => handleOpenThread(liveThreadId) : undefined
                  }
                />
              );
            })}
            {recentJobs.length > 0 ? (
              <>
                <div className="border-y border-border/60 bg-muted/20 px-3 py-1 text-3xs font-medium uppercase tracking-wide text-muted-foreground">
                  <T>Recent</T>
                </div>
                {recentJobs.map((job, idx) => {
                  const id = job.id
                    ? String(job.id)
                    : `${job.repo ?? "repo"}:${job.branch ?? "job"}:${job.submitted_at ?? idx}`;
                  const liveThreadId = resolveLiveThreadId(job.thread_id);
                  return (
                    <ShipQueueTableRow
                      key={id}
                      job={job}
                      revision={revisions.get(job) ?? 0}
                      environmentId={environmentId}
                      expanded={expandedId === id}
                      nowMs={nowMs}
                      cancelling={cancellingId === id}
                      onToggleExpand={() => setExpandedId((cur) => (cur === id ? null : id))}
                      onCancel={() => job.id && void handleCancel(job.id)}
                      onOpenThread={
                        liveThreadId !== null ? () => handleOpenThread(liveThreadId) : undefined
                      }
                    />
                  );
                })}
              </>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

export function ShipQueuePanel(props: { readonly environmentId: EnvironmentId | null }) {
  return (
    <DevtoolsErrorBoundary panelName="Ship Queue" resetKeys={[props.environmentId]}>
      <ShipQueuePanelInner {...props} />
    </DevtoolsErrorBoundary>
  );
}
