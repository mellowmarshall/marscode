import {
  scopedProjectKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import type { CommandOutputView } from "@t3tools/client-runtime/state/command-output";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthDiagnosticsReadScope,
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type OrchestrationV2PendingBackgroundTask,
  type ThreadId,
} from "@t3tools/contracts";
import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import { Link, useNavigate } from "@tanstack/react-router";
import { T, useGT, Var } from "gt-react";
import { ActivityIcon, BotIcon, TerminalIcon, WorkflowIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { useRelativeTimeState } from "../../hooks/useRelativeTimeState";
import { m } from "../../i18n/messages";
import { cn } from "../../lib/utils";
import {
  useProjects,
  useServerConfigs,
  useThreadVisibleTurnItems,
  useVisibleThreadShells,
} from "../../state/entities";
import { useEnvironment } from "../../state/environments";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { useShipQueueSnapshot } from "../../state/shipQueue";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { useCommandOutputStreaming } from "../chat/CommandOutputPanel";
import { BackgroundWorkInspectorDialog } from "../jobs/BackgroundWorkInspector";
import { isCernoCommand } from "../jobs/cernoCommand";
import { JobSparkline } from "../jobs/JobMetricCharts";
import {
  detectSilentStallSeconds,
  parseCommandOutputMetrics,
  shortJobLabel,
} from "../jobs/jobOutputParser";
import { isShipQueueCommand } from "../jobs/shipQueueBackgroundFilter";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { type MachineBackgroundJobEntry, selectEnvironmentBackgroundJobs } from "./machines.logic";

type JobFilter = "all" | "commands" | "subagents";

function taskKindLabel(
  kind: OrchestrationV2PendingBackgroundTask["kind"] | string,
  gt: ReturnType<typeof useGT>,
): string {
  switch (kind) {
    case "subagent":
      return gt("Subagent", { $context: "background job kind" });
    case "monitor":
      return gt("Monitor", { $context: "background job kind" });
    case "background_task":
      return gt("Background task", { $context: "background job kind" });
    default:
      return gt("Command", { $context: "background job kind" });
  }
}

function JobTimestamp({ timestamp }: { readonly timestamp: string }) {
  const relative = useRelativeTimeState(timestamp);
  if (relative.status !== "relative") return null;
  return (
    <span className="text-xs text-muted-foreground tabular-nums">
      {relative.suffix ? `${relative.value} ${relative.suffix}` : relative.value}
    </span>
  );
}

function MachineJobRow({
  environmentId,
  entry,
  projectName,
  nowMs,
  onInspect,
}: {
  readonly environmentId: EnvironmentId;
  readonly entry: MachineBackgroundJobEntry;
  readonly projectName: string | null;
  readonly nowMs: number;
  readonly onInspect: (entry: MachineBackgroundJobEntry) => void;
}) {
  const gt = useGT();
  const streamsOutput = useCommandOutputStreaming(environmentId);
  const { task, thread } = entry;
  const isCommandLike = task.kind !== "subagent";
  const outputActive = Boolean(isCommandLike && task.itemId && streamsOutput);

  const outputQuery = useEnvironmentQuery<CommandOutputView, unknown>(
    outputActive && task.itemId
      ? orchestrationEnvironment.v2.commandOutput({
          environmentId,
          input: {
            threadId: task.sourceThreadId ?? thread.id,
            itemId: task.itemId,
          },
        })
      : null,
  );

  const outputText = outputQuery.data?.output.text ?? "";
  const metrics = outputText ? parseCommandOutputMetrics(outputText) : null;
  const progress = metrics?.progress ?? null;
  const pct = progress ? Math.max(0, Math.min(100, Math.round(progress.fraction * 100))) : null;
  const primarySeries = metrics?.series[0] ?? null;

  const isRunningOutput = outputActive && (outputQuery.data ? outputQuery.data.running : true);
  const lastActivityMs = outputQuery.dataUpdatedAt > 0 ? outputQuery.dataUpdatedAt : null;
  const silentSeconds = detectSilentStallSeconds(lastActivityMs, nowMs, isRunningOutput);

  const commandTitle = task.description?.trim() || task.command?.split(/\r?\n/u)[0]?.trim() || "";
  const title = commandTitle || shortJobLabel(task, task.command);
  const waiting = backgroundWorkHoldsCompletion([task]);
  const dotClass =
    silentSeconds !== null ? "bg-warning" : waiting ? "bg-info" : "bg-muted-foreground/55";
  const subtitle = [projectName, thread.title, thread.branch].filter(Boolean).join(" · ");

  return (
    <li className="list-none">
      <button
        type="button"
        onClick={() => onInspect(entry)}
        className="flex w-full cursor-pointer flex-col gap-1.5 px-4 py-2.5 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <div className="flex w-full items-center justify-between gap-3">
          <div className="flex min-w-0 flex-1 items-center gap-2.5">
            <span aria-hidden className={cn("size-2 shrink-0 rounded-full", dotClass)} />
            {task.kind === "subagent" ? (
              <BotIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            ) : (
              <TerminalIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            )}
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <div className="flex min-w-0 items-center gap-1.5">
                <span className="truncate font-mono text-sm font-medium text-foreground">
                  {title}
                </span>
                <Badge size="sm" variant={waiting ? "outline" : "secondary"}>
                  {taskKindLabel(task.kind, gt)}
                </Badge>
              </div>
              {subtitle ? (
                <span className="truncate text-xs text-muted-foreground">{subtitle}</span>
              ) : null}
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2.5">
            {primarySeries ? <JobSparkline series={primarySeries} width={68} height={18} /> : null}
            {metrics?.kpis.slice(0, 2).map((kpi) => (
              <Badge key={kpi.key} size="sm" variant={kpi.anomaly ? "destructive" : "secondary"}>
                <span className="font-mono tabular-nums">
                  {kpi.label} {kpi.text}
                </span>
              </Badge>
            ))}
            {pct !== null ? (
              <span className="font-mono text-xs font-medium text-foreground tabular-nums">
                {pct}%
              </span>
            ) : null}
            {silentSeconds !== null ? (
              <span className="font-mono text-xs font-medium text-warning-foreground tabular-nums">
                {gt("Stalled {seconds}s", { seconds: silentSeconds })}
              </span>
            ) : (
              <JobTimestamp timestamp={thread.updatedAt} />
            )}
          </div>
        </div>

        {pct !== null ? (
          <div aria-hidden className="ms-4.5 h-0.5 overflow-hidden rounded-full bg-border/60">
            <div
              className={cn(
                "h-full rounded-full transition-[width] duration-300",
                silentSeconds !== null ? "bg-warning" : "bg-primary",
              )}
              style={{ width: `${pct}%` }}
            />
          </div>
        ) : null}
      </button>
    </li>
  );
}

export function MachineJobsPanel({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const gt = useGT();
  const navigate = useNavigate();
  const environment = useEnvironment(environmentId);
  const allThreads = useVisibleThreadShells();
  const projects = useProjects();
  const serverConfigs = useServerConfigs();
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const canReadDiagnostics = useEnvironmentScope(environmentId, AuthDiagnosticsReadScope);
  const interruptTurn = useOrchestrationCommand(threadEnvironment.interruptTurn, {
    reportFailure: false,
  });

  const [filter, setFilter] = useState<JobFilter>("all");
  const [inspectedKey, setInspectedKey] = useState<string | null>(null);
  const [stoppingThreadId, setStoppingThreadId] = useState<ThreadId | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const workflowsEnabled = serverConfigs.get(environmentId)?.settings.workflowsEnabled === true;
  const workflowsLive = useEnvironmentQuery(
    workflowsEnabled ? serverEnvironment.workflowsLive({ environmentId, input: {} }) : null,
  );
  const activeWorkflowCount =
    workflowsEnabled && workflowsLive.data
      ? workflowsLive.data.runs.filter((run) => run.endedAt === null).length
      : 0;

  const shipQueueSupported =
    serverConfigs.get(environmentId)?.environment.capabilities.shipQueue === true;
  const shipQueueSnapshot = useShipQueueSnapshot(shipQueueSupported ? environmentId : null);
  const knownShipJobIds =
    shipQueueSupported && shipQueueSnapshot.available && shipQueueSnapshot.jobs.length > 0
      ? new Set(shipQueueSnapshot.jobs.map((job) => job.id))
      : undefined;
  const entries = selectEnvironmentBackgroundJobs(allThreads, environmentId, {
    excludeShipQueue: shipQueueSupported,
    knownShipJobIds,
  });
  const inspectedEntry = inspectedKey
    ? (entries.find((candidate) => candidate.key === inspectedKey) ?? null)
    : null;
  const inspectedProjectedItems = useThreadVisibleTurnItems(
    inspectedEntry ? scopeThreadRef(environmentId, inspectedEntry.thread.id) : null,
  );
  const inspectedTurnItems = inspectedProjectedItems.map((projected) => projected.item);
  const hasCernoJobs =
    entries.some((entry) => isCernoCommand(entry.task.command)) ||
    inspectedTurnItems.some(
      (item) =>
        item.type === "command_execution" &&
        item.status === "running" &&
        !(shipQueueSupported && isShipQueueCommand(item.input)) &&
        isCernoCommand(item.input),
    );
  const cernoQuery = useEnvironmentQuery(
    canReadDiagnostics && hasCernoJobs
      ? serverEnvironment.cernoRuns({ environmentId, input: {} })
      : null,
  );
  const cernoRuns = cernoQuery.data?.runs ?? [];

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- poll 5s clock only while background jobs exist on this machine
  useEffect(() => {
    if (entries.length === 0) return;
    const id = window.setInterval(() => setNowMs(Date.now()), 5_000);
    return () => window.clearInterval(id);
  }, [entries.length]);

  const projectNames = new Map(
    projects.map((project) => [
      scopedProjectKey(scopeProjectRef(project.environmentId, project.id)),
      project.title,
    ]),
  );

  const filtered = entries.filter((entry) => {
    if (filter === "subagents") return entry.task.kind === "subagent";
    if (filter === "commands") return entry.task.kind !== "subagent";
    return true;
  });

  const inspectedThreadTasks = inspectedEntry
    ? entries
        .filter((candidate) => candidate.thread.id === inspectedEntry.thread.id)
        .map((candidate) => candidate.task)
    : [];

  const openThread = (threadId: ThreadId) => {
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId },
    });
  };

  const stopThread = async (threadId: ThreadId) => {
    setStoppingThreadId(threadId);
    const result = await interruptTurn({
      environmentId,
      input: { threadId },
    });
    setStoppingThreadId(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: gt("Could not stop thread"),
          description: thrownErrorMessage(error, m) ?? String(error),
        }),
      );
    }
  };

  return (
    <>
      <section className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-border/70 bg-card">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-medium text-foreground">
              <T>Background jobs</T>
            </h2>
            <Badge size="sm" variant="secondary">
              {entries.length}
            </Badge>
            {activeWorkflowCount > 0 ? (
              <Button
                size="xs"
                variant="outline"
                render={<Link to="/workflows" search={{ env: environmentId }} />}
              >
                <WorkflowIcon aria-hidden />
                <T>
                  Workflows · <Var>{activeWorkflowCount}</Var> active
                </T>
              </Button>
            ) : null}
          </div>

          {entries.length > 0 ? (
            <ToggleGroup
              aria-label={gt("Filter background jobs")}
              variant="segmented"
              value={[filter]}
              onValueChange={(next) => {
                const value = next[0];
                if (value === "all" || value === "commands" || value === "subagents") {
                  setFilter(value);
                }
              }}
            >
              <Toggle value="all">
                <T>All</T>
              </Toggle>
              <Toggle value="commands">
                <T>Commands</T>
              </Toggle>
              <Toggle value="subagents">
                <T>Subagents</T>
              </Toggle>
            </ToggleGroup>
          ) : null}
        </div>

        {entries.length === 0 ? (
          <Empty size="compact">
            <EmptyMedia variant="icon">
              <ActivityIcon />
            </EmptyMedia>
            <EmptyHeader>
              <EmptyTitle>
                <T>No running background jobs</T>
              </EmptyTitle>
              <EmptyDescription>
                <T>
                  Awaited commands, monitors, and subagents running on this machine appear here.
                </T>
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : filtered.length === 0 ? (
          <Empty size="compact">
            <EmptyMedia variant="icon">
              <ActivityIcon />
            </EmptyMedia>
            <EmptyHeader>
              <EmptyTitle>
                <T>No matching jobs</T>
              </EmptyTitle>
              <EmptyDescription>
                <T>Switch the filter above to inspect other running background work.</T>
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ul className="m-0 divide-y divide-border/50 p-0">
            {filtered.map((entry) => {
              const projectName =
                projectNames.get(
                  scopedProjectKey(
                    scopeProjectRef(entry.thread.environmentId, entry.thread.projectId),
                  ),
                ) ?? null;
              return (
                <MachineJobRow
                  key={entry.key}
                  environmentId={environmentId}
                  entry={entry}
                  projectName={projectName}
                  nowMs={nowMs}
                  onInspect={(picked) => setInspectedKey(picked.key)}
                />
              );
            })}
          </ul>
        )}
      </section>

      {inspectedEntry ? (
        <BackgroundWorkInspectorDialog
          open={inspectedEntry !== null}
          onOpenChange={(nextOpen) => {
            if (!nextOpen) {
              setInspectedKey(null);
            }
          }}
          environmentId={environmentId}
          threadId={inspectedEntry.thread.id}
          tasks={inspectedThreadTasks}
          turnItems={inspectedTurnItems}
          cernoRuns={cernoRuns}
          initialTaskId={inspectedEntry.task.taskId}
          assumeLiveWithoutItems
          showHostHardware
          hostLabel={environment?.label}
          branch={inspectedEntry.thread.branch}
          worktreePath={inspectedEntry.thread.worktreePath}
          stopDisabled={!canOperate}
          stopping={stoppingThreadId === inspectedEntry.thread.id}
          onStop={() => stopThread(inspectedEntry.thread.id)}
          onOpenThread={openThread}
          onOpenOwnerThread={() => openThread(inspectedEntry.thread.id)}
        />
      ) : null}
    </>
  );
}
