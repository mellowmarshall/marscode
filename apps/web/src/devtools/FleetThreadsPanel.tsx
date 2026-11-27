/**
 * Per-host T3 threads panel inside Fleet Console -> Machines.
 * Matches linked environments to the selected host and lets the owner jump straight into any thread.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { T, Var, useGT } from "gt-react";
import { GitBranchIcon, MessageSquareIcon } from "lucide-react";

import { resolveSidebarRowStatus } from "../components/Sidebar.logic";
import { Badge } from "../components/ui/badge";
import { useProjects, useQuietThreadShells } from "../state/entities";
import { useEnvironments } from "../state/environments";
import type { MergedFleetHost } from "./devdeckTypes";
import { useSharedShipQueueDeps } from "./devtoolsDepsStore";
import { closeFleetConsole, useDevtoolsSelector } from "./devtoolsStore";
import { matchHostEnvironmentId } from "./fleetHostEnvironment";
import { useSharedJobs } from "./jobs/jobsStore";
import { isShipQueueJobLive } from "./ShipQueueSteps";
import { deriveThreadDevtoolsApprovals } from "./threadApprovals";
import { collectDescendantSubagentIds } from "./useThreadDevtoolsApprovals";

function formatRelativeShort(iso: string | null | undefined): string {
  if (!iso) return "";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const diffSec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (diffSec < 60) return `${diffSec}s`;
  const mins = Math.floor(diffSec / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

function threadStatusRank(status: ReturnType<typeof resolveSidebarRowStatus>): number {
  if (
    status === "working" ||
    status === "preparing" ||
    status === "approval" ||
    status === "input" ||
    status === "request"
  ) {
    return 0;
  }
  return status === "failed" ? 1 : 2;
}

export function FleetThreadsPanel({
  environmentId,
  host,
}: {
  readonly environmentId: EnvironmentId;
  readonly host: MergedFleetHost;
}) {
  const gt = useGT();
  const navigate = useNavigate();
  const { environments } = useEnvironments();
  const allThreads = useQuietThreadShells();
  const projects = useProjects();

  const matchedEnvId = matchHostEnvironmentId(host, environmentId, environments);
  const projectNameByKey = new Map(
    projects.map((p) => [`${p.environmentId}:${p.id}`, p.title] as const),
  );

  const envGuards = useDevtoolsSelector((s) =>
    matchedEnvId ? (s.pendingByEnv.get(matchedEnvId) ?? null) : null,
  );
  const pendingGuards = envGuards ? envGuards.map((g) => g.request) : [];
  const jobsState = useSharedJobs(matchedEnvId);
  const shipJobs = jobsState.jobs.flatMap((j) =>
    j.source === "ship-queue" && j.shipJob ? [j.shipJob] : [],
  );
  const hasLiveShip = shipJobs.some(isShipQueueJobLive);
  const depsState = useSharedShipQueueDeps(matchedEnvId, matchedEnvId !== null && hasLiveShip);
  const depsRepos = depsState.payload?.repos ?? [];

  const hostThreads = matchedEnvId
    ? allThreads
        .filter(
          (t) =>
            t.environmentId === matchedEnvId &&
            t.deletedAt === null &&
            t.archivedAt === null &&
            t.lineage?.relationshipToParent !== "subagent",
        )
        .map((thread) => {
          const baseStatus = resolveSidebarRowStatus(thread);
          let hasDevtoolsApproval = false;
          if (pendingGuards.length > 0 || depsRepos.length > 0) {
            const candidateIds = [
              thread.id,
              ...collectDescendantSubagentIds(allThreads, matchedEnvId, thread.id),
            ];
            hasDevtoolsApproval = candidateIds.some(
              (tid) =>
                deriveThreadDevtoolsApprovals({
                  threadId: tid,
                  pendingGuards,
                  shipJobs,
                  depsRepos,
                  scanningRepos: depsState.scanningRepos,
                  decidingRepos: depsState.decidingRepos,
                }).length > 0,
            );
          }
          const status =
            hasDevtoolsApproval && baseStatus !== "approval" && baseStatus !== "input"
              ? "approval"
              : baseStatus;
          return {
            thread,
            status,
            rank: threadStatusRank(status),
            updatedMs: Date.parse(thread.updatedAt),
          };
        })
        .toSorted((a, b) => (a.rank !== b.rank ? a.rank - b.rank : b.updatedMs - a.updatedMs))
        .slice(0, 12)
    : [];
  const activeCount = hostThreads.filter((item) => item.rank === 0).length;

  return (
    <section className="overflow-hidden rounded-lg border border-border/70 bg-card/40">
      <div className="flex items-center justify-between gap-2 border-b border-border/60 bg-muted/20 px-3 py-2">
        <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
          <MessageSquareIcon className="size-3.5 text-muted-foreground" />
          <T>Threads</T>
          {activeCount > 0 ? (
            <Badge size="sm" variant="info">
              <T>
                <Var>{activeCount}</Var> active
              </T>
            </Badge>
          ) : null}
        </div>
        <span className="font-mono text-3xs text-muted-foreground">
          {matchedEnvId ? gt("{n} shown", { n: hostThreads.length }) : gt("unlinked host")}
        </span>
      </div>

      {!matchedEnvId ? (
        <div className="px-3 py-4 text-xs text-muted-foreground">
          <T>
            No linked T3 environment matched <Var>{host.shortName}</Var>. Link this machine in T3 to
            browse its threads here.
          </T>
        </div>
      ) : hostThreads.length === 0 ? (
        <div className="px-3 py-4 text-xs text-muted-foreground">
          <T>No active or recent threads on this host.</T>
        </div>
      ) : (
        <div className="divide-y divide-border/50">
          {hostThreads.map(({ thread, status }) => {
            const isActive = status === "working" || status === "preparing";
            const needsAttention =
              status === "approval" || status === "input" || status === "request";
            const isFailed = status === "failed";
            const projectName = projectNameByKey.get(`${thread.environmentId}:${thread.projectId}`);
            const modelName = thread.modelSelection?.model ?? "";

            return (
              <button
                key={`${thread.environmentId}:${thread.id}`}
                type="button"
                className="flex w-full items-start justify-between gap-2 px-3 py-2 text-left text-xs transition hover:bg-muted/25"
                onClick={() => {
                  closeFleetConsole();
                  void navigate({
                    to: "/$environmentId/$threadId",
                    params: { environmentId: thread.environmentId, threadId: thread.id },
                  });
                }}
              >
                <div className="flex min-w-0 items-start gap-2">
                  <span
                    className={
                      isActive
                        ? "mt-1.5 size-2 shrink-0 animate-pulse rounded-full bg-info"
                        : needsAttention
                          ? "mt-1.5 size-2 shrink-0 rounded-full bg-warning"
                          : isFailed
                            ? "mt-1.5 size-2 shrink-0 rounded-full bg-destructive"
                            : "mt-1.5 size-2 shrink-0 rounded-full bg-muted-foreground/35"
                    }
                  />
                  <div className="min-w-0 space-y-0.5">
                    <div className="truncate font-medium text-foreground">
                      {thread.title || gt("Untitled thread")}
                    </div>
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-3xs text-muted-foreground">
                      {projectName ? <span className="truncate">{projectName}</span> : null}
                      {thread.branch ? (
                        <span className="inline-flex items-center gap-0.5 truncate">
                          <GitBranchIcon className="size-2.5 shrink-0" />
                          <span>{thread.branch}</span>
                        </span>
                      ) : null}
                      {modelName ? <span className="truncate">{modelName}</span> : null}
                    </div>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  {isActive ? (
                    <Badge size="sm" variant="info">
                      <T>Working</T>
                    </Badge>
                  ) : needsAttention ? (
                    <Badge size="sm" variant="warning">
                      {status === "approval" ? <T>Approval</T> : <T>Waiting</T>}
                    </Badge>
                  ) : isFailed ? (
                    <Badge size="sm" variant="error">
                      <T>Failed</T>
                    </Badge>
                  ) : null}
                  <span className="font-mono text-3xs text-muted-foreground tabular-nums">
                    {formatRelativeShort(thread.updatedAt)}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
