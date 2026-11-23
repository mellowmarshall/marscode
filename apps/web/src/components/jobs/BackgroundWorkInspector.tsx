import type { CommandOutputView } from "@t3tools/client-runtime/state/command-output";
import type { ThreadStructure } from "@t3tools/client-runtime/state/shell";
import type {
  EnvironmentId,
  OrchestrationV2PendingBackgroundTask,
  ThreadId,
} from "@t3tools/contracts";
import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as DateTime from "effect/DateTime";
import { T, useGT, Var } from "gt-react";
import {
  AlertTriangleIcon,
  ArrowUpRightIcon,
  CpuIcon,
  FolderIcon,
  XCircleIcon,
} from "lucide-react";
import { useEffect, useState } from "react";

import { formatBytes } from "../../lib/formatBytes";
import { cn } from "../../lib/utils";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { CommandOutputPanel, useCommandOutputStreaming } from "../chat/CommandOutputPanel";
import { ShellCommandBlock } from "../chat/ShellCommandBlock";
import { Badge } from "../ui/badge";
import { Button, InlineButton } from "../ui/button";
import { Dialog, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../ui/dialog";
import { JobMetricChart } from "./JobMetricCharts";
import {
  detectSilentStallSeconds,
  parseCommandOutputMetrics,
  shortJobLabel,
} from "./jobOutputParser";

const CHART_COLORS = ["var(--chart-1)", "var(--chart-2)"] as const;

export function resolveBackgroundTaskTurnItem(
  task: OrchestrationV2PendingBackgroundTask,
  turnItems: ThreadStructure["turnItems"],
) {
  return turnItems.findLast((candidate) =>
    task.itemId === undefined
      ? (candidate.nativeItemRef?.nativeId || candidate.id) === task.taskId
      : candidate.id === task.itemId,
  );
}

function taskKindLabel(
  kind: OrchestrationV2PendingBackgroundTask["kind"] | string,
  gt: ReturnType<typeof useGT>,
): string {
  switch (kind) {
    case "subagent":
      return gt("Subagent", { $context: "kind of background work" });
    case "command":
      return gt("Command", { $context: "kind of background work" });
    case "monitor":
      return gt("Monitor", { $context: "kind of background work" });
    case "background_task":
      return gt("Background task", { $context: "kind of background work" });
    default:
      return kind.replaceAll("_", " ");
  }
}

export function BackgroundWorkTaskSection({
  environmentId,
  threadId,
  task,
  turnItems,
  assumeLiveWithoutItems = false,
  hostLabel,
  branch,
  worktreePath,
  gpuSummary,
  nowMs,
  onOpenThread,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly task: OrchestrationV2PendingBackgroundTask;
  readonly turnItems: ThreadStructure["turnItems"];
  readonly assumeLiveWithoutItems?: boolean;
  readonly hostLabel?: string | null | undefined;
  readonly branch?: string | null | undefined;
  readonly worktreePath?: string | null | undefined;
  readonly gpuSummary?: string | null | undefined;
  readonly nowMs: number;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const gt = useGT();
  const streamsOutput = useCommandOutputStreaming(environmentId);
  const item = resolveBackgroundTaskTurnItem(task, turnItems);
  const command = task.command ?? (item?.type === "command_execution" ? item.input : undefined);
  const description = task.description?.trim();
  const title =
    description && description !== command?.trim()
      ? description
      : command
        ? gt("Command", { $context: "title of a background shell command" })
        : taskKindLabel(task.kind, gt);
  const itemId = task.itemId ?? (item?.type === "command_execution" ? item.id : undefined);
  const childThreadId = task.kind === "subagent" ? task.childThreadId : undefined;
  const outputActive = Boolean(
    task.kind !== "subagent" &&
    itemId &&
    streamsOutput &&
    (item ? item.status === "running" : assumeLiveWithoutItems),
  );

  const outputQuery = useEnvironmentQuery<CommandOutputView, unknown>(
    outputActive && itemId
      ? orchestrationEnvironment.v2.commandOutput({
          environmentId,
          input: {
            threadId: task.sourceThreadId ?? item?.threadId ?? threadId,
            itemId,
          },
        })
      : null,
  );

  const outputText =
    outputQuery.data?.output.text ??
    (item?.type === "command_execution" ? (item.output ?? "") : "");
  const metrics = outputText ? parseCommandOutputMetrics(outputText) : null;
  const progress = metrics?.progress ?? null;
  const kpis = metrics?.kpis ?? [];
  const series = metrics?.series ?? [];
  const pct = progress ? Math.max(0, Math.min(100, Math.round(progress.fraction * 100))) : null;

  const isRunningOutput = outputActive && (outputQuery.data ? outputQuery.data.running : true);
  const itemUpdatedMs =
    item && "updatedAt" in item && item.updatedAt ? DateTime.toEpochMillis(item.updatedAt) : null;
  const lastActivityMs = outputQuery.dataUpdatedAt > 0 ? outputQuery.dataUpdatedAt : itemUpdatedMs;
  const silentSeconds = detectSilentStallSeconds(lastActivityMs, nowMs, isRunningOutput);

  const hasMetadata = Boolean(hostLabel || branch || worktreePath || gpuSummary);

  return (
    <section className="space-y-3 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <h3 className="font-medium text-foreground">{title}</h3>
          <Badge size="sm" variant="outline">
            {taskKindLabel(task.kind, gt)}
          </Badge>
          {silentSeconds !== null ? (
            <Badge size="sm" variant="warning">
              {gt("No output for {seconds}s", { seconds: silentSeconds })}
            </Badge>
          ) : null}
        </div>
        <span className="shrink-0 text-xs text-muted-foreground">
          {backgroundWorkHoldsCompletion([task])
            ? gt("Waiting", { $context: "status of background work" })
            : gt("Running", { $context: "status of background work" })}
        </span>
      </div>

      {hasMetadata ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border/70 bg-muted/20 px-3 py-1.5 font-mono text-xs text-muted-foreground tabular-nums">
          {hostLabel ? <span>{hostLabel}</span> : null}
          {branch ? <span>{branch}</span> : null}
          {worktreePath ? (
            <span className="inline-flex min-w-0 items-center gap-1">
              <FolderIcon className="size-3 shrink-0" aria-hidden />
              <span className="truncate">{worktreePath}</span>
            </span>
          ) : null}
          {gpuSummary ? (
            <span className="inline-flex items-center gap-1 text-foreground">
              <CpuIcon className="size-3 shrink-0" aria-hidden />
              <span>{gpuSummary}</span>
            </span>
          ) : null}
        </div>
      ) : null}

      {silentSeconds !== null ? (
        <div className="flex items-center gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning-foreground">
          <AlertTriangleIcon className="size-3.5 shrink-0" aria-hidden />
          <span>
            <T>
              No new output for <Var>{silentSeconds}</Var>s. The stream stays attached and updates
              automatically when output resumes.
            </T>
          </span>
        </div>
      ) : null}

      {progress ? (
        <div className="space-y-1.5 rounded-md border border-border/70 bg-muted/20 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-xs tabular-nums">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold text-foreground">{pct}%</span>
              <span className="text-muted-foreground">
                {`${Math.round(progress.current)}/${Math.round(progress.total)}${
                  progress.unit ? ` ${progress.unit}` : ""
                }`}
              </span>
              {progress.stageLabel ? (
                <Badge size="sm" variant="outline">
                  {progress.stageLabel}
                </Badge>
              ) : null}
            </div>
            <div className="flex items-center gap-3 text-muted-foreground">
              {progress.rate ? <span>{progress.rate}</span> : null}
              {progress.etaText ? (
                <span>
                  <T>
                    ETA <Var>{progress.etaText}</Var>
                  </T>
                </span>
              ) : null}
            </div>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className={cn(
                "h-full rounded-full transition-[width] duration-300",
                silentSeconds !== null ? "bg-warning" : "bg-info",
              )}
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      ) : null}

      {command ? (
        <div className="rounded-md border border-border bg-muted/20 p-3 font-mono text-xs whitespace-pre-wrap break-words">
          <ShellCommandBlock command={command} />
        </div>
      ) : null}

      {outputActive && itemId ? (
        <div className="font-mono text-xs whitespace-pre-wrap break-words">
          <CommandOutputPanel
            environmentId={environmentId}
            threadId={task.sourceThreadId ?? item?.threadId ?? threadId}
            itemId={itemId}
          />
        </div>
      ) : null}

      {kpis.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {kpis.map((kpi) => (
            <div
              key={kpi.key}
              className="inline-flex items-baseline gap-1.5 rounded-md border border-border/70 bg-muted/20 px-2.5 py-1 text-xs"
            >
              <span className="text-muted-foreground">{kpi.label}</span>
              <span
                className={cn(
                  "font-mono font-semibold tabular-nums",
                  kpi.anomaly ? "text-destructive-foreground" : "text-foreground",
                )}
              >
                {kpi.text}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {series.length > 0 ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {series.slice(0, 4).map((entry, idx) => (
            <JobMetricChart
              key={entry.key}
              series={entry}
              stroke={CHART_COLORS[idx % CHART_COLORS.length]!}
            />
          ))}
        </div>
      ) : null}

      {childThreadId ? (
        <InlineButton onClick={() => onOpenThread(childThreadId)}>
          <T>Open subagent</T>
        </InlineButton>
      ) : null}
    </section>
  );
}

export function BackgroundWorkInspectorDialog({
  open,
  onOpenChange,
  environmentId,
  threadId,
  tasks,
  turnItems,
  initialTaskId,
  assumeLiveWithoutItems = false,
  showHostHardware = false,
  hostLabel,
  branch,
  worktreePath,
  stopDisabled = false,
  stopping = false,
  onStop,
  onOpenThread,
  onOpenOwnerThread,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly tasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>;
  readonly turnItems: ThreadStructure["turnItems"];
  readonly initialTaskId?: string | null | undefined;
  readonly assumeLiveWithoutItems?: boolean;
  readonly showHostHardware?: boolean;
  readonly hostLabel?: string | null | undefined;
  readonly branch?: string | null | undefined;
  readonly worktreePath?: string | null | undefined;
  readonly stopDisabled?: boolean;
  readonly stopping?: boolean;
  readonly onStop?: (() => Promise<void>) | undefined;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly onOpenOwnerThread?: (() => void) | undefined;
}) {
  const gt = useGT();
  const [selection, setSelection] = useState<{
    readonly base: string | null;
    readonly picked: string | null;
  }>({ base: null, picked: null });
  const [confirmingStop, setConfirmingStop] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- poll 5s clock while inspector dialog is open for silent stall duration
  useEffect(() => {
    if (!open || tasks.length === 0) return;
    const id = window.setInterval(() => setNowMs(Date.now()), 5_000);
    return () => window.clearInterval(id);
  }, [open, tasks.length]);

  const hardware = useEnvironmentQuery(
    open && showHostHardware ? serverEnvironment.hostHardware({ environmentId, input: {} }) : null,
  );
  const primaryGpu = hardware.data?.gpus[0] ?? null;
  const gpuParts: string[] = [];
  if (primaryGpu?.utilization !== null && primaryGpu?.utilization !== undefined) {
    gpuParts.push(gt("{percent}% GPU", { percent: Math.round(primaryGpu.utilization * 100) }));
  }
  if (
    primaryGpu &&
    primaryGpu.memoryUsedBytes !== null &&
    primaryGpu.memoryTotalBytes !== null &&
    primaryGpu.memoryTotalBytes > 0
  ) {
    gpuParts.push(
      gt("{used} / {total} VRAM", {
        used: formatBytes(primaryGpu.memoryUsedBytes),
        total: formatBytes(primaryGpu.memoryTotalBytes),
      }),
    );
  }
  if (primaryGpu?.temperatureC !== null && primaryGpu?.temperatureC !== undefined) {
    gpuParts.push(`${Math.round(primaryGpu.temperatureC)}°C`);
  }
  const gpuSummary = gpuParts.length > 0 ? gpuParts.join(" · ") : null;

  const baseTaskId = initialTaskId ?? null;
  const pickedTaskId = selection.base === baseTaskId ? selection.picked : null;
  const activeTaskId =
    pickedTaskId && tasks.some((task) => task.taskId === pickedTaskId)
      ? pickedTaskId
      : baseTaskId && tasks.some((task) => task.taskId === baseTaskId)
        ? baseTaskId
        : (tasks[0]?.taskId ?? null);
  const activeTask = tasks.find((task) => task.taskId === activeTaskId) ?? tasks[0] ?? null;

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setConfirmingStop(false);
      setSelection({ base: null, picked: null });
    }
    onOpenChange(nextOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <div className="flex flex-wrap items-center justify-between gap-2 pe-8">
            <DialogTitle>
              <T>Background work</T>
            </DialogTitle>
            <div className="flex flex-wrap items-center gap-1.5">
              {onOpenOwnerThread ? (
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => {
                    onOpenChange(false);
                    onOpenOwnerThread();
                  }}
                >
                  <ArrowUpRightIcon aria-hidden />
                  <T>Open thread</T>
                </Button>
              ) : null}
              {onStop && tasks.length > 0 ? (
                confirmingStop ? (
                  <>
                    <Button size="xs" variant="ghost" onClick={() => setConfirmingStop(false)}>
                      <T>Cancel</T>
                    </Button>
                    <Button
                      size="xs"
                      variant="destructive"
                      disabled={stopDisabled || stopping}
                      onClick={() => {
                        setConfirmingStop(false);
                        void onStop();
                      }}
                    >
                      <XCircleIcon aria-hidden />
                      <T>Confirm stop thread</T>
                    </Button>
                  </>
                ) : (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={stopDisabled || stopping}
                    onClick={() => setConfirmingStop(true)}
                  >
                    <XCircleIcon aria-hidden />
                    {stopping ? <T>Stopping…</T> : <T>Stop thread</T>}
                  </Button>
                )
              ) : null}
            </div>
          </div>
          {tasks.length > 1 ? (
            <div className="flex flex-wrap items-center gap-1 pt-1">
              {tasks.map((task) => {
                const item = resolveBackgroundTaskTurnItem(task, turnItems);
                const cmd =
                  task.command ?? (item?.type === "command_execution" ? item.input : undefined);
                const selected = task.taskId === activeTask?.taskId;
                return (
                  <Button
                    key={task.taskId}
                    size="xs"
                    variant={selected ? "secondary" : "ghost"}
                    onClick={() => setSelection({ base: baseTaskId, picked: task.taskId })}
                  >
                    {shortJobLabel(task, cmd)}
                  </Button>
                );
              })}
            </div>
          ) : null}
        </DialogHeader>
        <DialogPanel>
          {activeTask ? (
            <BackgroundWorkTaskSection
              environmentId={environmentId}
              threadId={threadId}
              task={activeTask}
              turnItems={turnItems}
              assumeLiveWithoutItems={assumeLiveWithoutItems}
              hostLabel={hostLabel}
              branch={branch}
              worktreePath={worktreePath}
              gpuSummary={gpuSummary}
              nowMs={nowMs}
              onOpenThread={(childId) => {
                onOpenChange(false);
                onOpenThread(childId);
              }}
            />
          ) : null}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
