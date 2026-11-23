import type { CommandOutputView } from "@t3tools/client-runtime/state/command-output";
import type { ThreadStructure } from "@t3tools/client-runtime/state/shell";
import type {
  EnvironmentId,
  OrchestrationV2PendingBackgroundTask,
  ThreadId,
} from "@t3tools/contracts";
import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as DateTime from "effect/DateTime";
import { T, useGT } from "gt-react";
import { ChevronRightIcon, TerminalIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { cn } from "../../lib/utils";
import { useEnvironment } from "../../state/environments";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import {
  BackgroundWorkInspectorDialog,
  resolveBackgroundTaskTurnItem,
} from "../jobs/BackgroundWorkInspector";
import {
  detectSilentStallSeconds,
  formatCompactElapsed,
  parseCommandOutputMetrics,
  shortJobLabel,
} from "../jobs/jobOutputParser";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useCommandOutputStreaming } from "./CommandOutputPanel";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import {
  THREAD_DETAILS_PANEL_CHEVRON_CLASS,
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
} from "./threadDetailsPanelStyles";

const MAX_INLINE_RAIL_JOBS = 3;

function BackgroundWorkRailRow({
  environmentId,
  threadId,
  task,
  turnItems,
  nowMs,
  onInspect,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly task: OrchestrationV2PendingBackgroundTask;
  readonly turnItems: ThreadStructure["turnItems"];
  readonly nowMs: number;
  readonly onInspect: (taskId: string) => void;
}) {
  const gt = useGT();
  const streamsOutput = useCommandOutputStreaming(environmentId);
  const item = resolveBackgroundTaskTurnItem(task, turnItems);
  const command = task.command ?? (item?.type === "command_execution" ? item.input : undefined);
  const itemId = task.itemId ?? (item?.type === "command_execution" ? item.id : undefined);
  const outputActive = Boolean(
    task.kind !== "subagent" &&
    itemId &&
    streamsOutput &&
    (item ? item.status === "running" : true),
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
  const pct = progress ? Math.max(0, Math.min(100, Math.round(progress.fraction * 100))) : null;

  const isRunningOutput = outputActive && (outputQuery.data ? outputQuery.data.running : true);
  const itemUpdatedMs =
    item && "updatedAt" in item && item.updatedAt ? DateTime.toEpochMillis(item.updatedAt) : null;
  const lastActivityMs = outputQuery.dataUpdatedAt > 0 ? outputQuery.dataUpdatedAt : itemUpdatedMs;
  const silentSeconds = detectSilentStallSeconds(lastActivityMs, nowMs, isRunningOutput);

  const label = shortJobLabel(task, command);
  const fullName = task.description?.trim() || command?.split(/\r?\n/u)[0]?.trim() || label;
  const elapsedText = item?.startedAt
    ? formatCompactElapsed(Math.max(0, nowMs - DateTime.toEpochMillis(item.startedAt)))
    : null;
  const waiting = backgroundWorkHoldsCompletion([task]);
  const rightMetric =
    silentSeconds !== null
      ? gt("{seconds}s !", { seconds: silentSeconds })
      : pct !== null
        ? `${pct}%`
        : (elapsedText ??
          (waiting
            ? gt("Wait", { $context: "compact status of waiting background task" })
            : gt("Live", { $context: "compact status of running background task" })));

  const tipParts = [
    fullName,
    pct !== null ? `${pct}%` : null,
    progress?.rate ?? null,
    progress?.etaText ? gt("ETA {eta}", { eta: progress.etaText }) : null,
    silentSeconds !== null ? gt("No output for {seconds}s", { seconds: silentSeconds }) : null,
  ].filter(Boolean);

  return (
    <div className="relative">
      <Tooltip>
        <TooltipTrigger
          delay={200}
          render={
            <ThreadDetailsControl
              size="sm"
              variant="ghost"
              part="row"
              onClick={() => onInspect(task.taskId)}
            />
          }
        >
          <span
            aria-hidden
            className={cn("flex items-center justify-center", THREAD_DETAILS_PANEL_ICON_CLASS)}
          >
            <span
              className={cn(
                "size-1.5 rounded-full",
                silentSeconds !== null ? "bg-warning" : "bg-info",
              )}
            />
          </span>
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-foreground/85",
              THREAD_DETAILS_PANEL_LABEL_CLASS,
              task.kind !== "subagent" && "font-mono text-xs",
            )}
          >
            {label}
          </span>
          <span
            className={cn(
              "shrink-0 font-mono text-xs tabular-nums",
              silentSeconds !== null
                ? "font-medium text-warning-foreground"
                : "text-muted-foreground",
            )}
          >
            {rightMetric}
          </span>
        </TooltipTrigger>
        <TooltipPopup side="left" className="max-w-xs">
          {tipParts.join(" · ")}
        </TooltipPopup>
      </Tooltip>
      {pct !== null ? (
        <div
          aria-hidden
          className="pointer-events-none absolute right-2.5 bottom-0.5 left-9 h-0.5 overflow-hidden rounded-full bg-muted-foreground/20"
        >
          <div
            className={cn(
              "h-full rounded-full transition-[width] duration-300",
              silentSeconds !== null ? "bg-warning" : "bg-info",
            )}
            style={{ width: `${pct}%` }}
          />
        </div>
      ) : null}
    </div>
  );
}

export function ThreadBackgroundWorkPanel({
  density,
  environmentId,
  threadId,
  tasks,
  turnItems,
  branch,
  stopDisabled,
  stopping,
  onStop,
  onOpenThread,
}: {
  readonly density: "full" | "compact" | "essential";
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly tasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>;
  readonly turnItems: ThreadStructure["turnItems"];
  readonly branch?: string | null | undefined;
  readonly stopDisabled: boolean;
  readonly stopping: boolean;
  readonly onStop: () => Promise<void>;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const gt = useGT();
  const environment = useEnvironment(environmentId);
  const [inspectTaskId, setInspectTaskId] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- poll 5s clock while active background tasks render in the thread rail
  useEffect(() => {
    if (tasks.length === 0) return;
    const id = window.setInterval(() => setNowMs(Date.now()), 5_000);
    return () => window.clearInterval(id);
  }, [tasks.length]);

  if (tasks.length === 0) return null;

  const showInlineRows = density === "full" && tasks.length <= MAX_INLINE_RAIL_JOBS;

  return (
    <ThreadDetailsSection
      headingId="thread-details-background-work-heading"
      title={gt("Background work")}
      showHeading={false}
    >
      <div data-thread-details-background-work className="flex flex-col">
        {showInlineRows ? (
          tasks.map((task) => (
            <BackgroundWorkRailRow
              key={task.taskId}
              environmentId={environmentId}
              threadId={threadId}
              task={task}
              turnItems={turnItems}
              nowMs={nowMs}
              onInspect={(taskId) => setInspectTaskId(taskId)}
            />
          ))
        ) : (
          <ThreadDetailsControl
            size="sm"
            variant="ghost"
            part="row"
            onClick={() => setInspectTaskId(tasks[0]?.taskId ?? null)}
          >
            <TerminalIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
            <span className={cn("min-w-0 flex-1 truncate", THREAD_DETAILS_PANEL_LABEL_CLASS)}>
              <T>Background work</T>
            </span>
            <span className="flex shrink-0 items-center gap-1.5 font-mono text-xs text-muted-foreground tabular-nums">
              <span aria-hidden className="size-1.5 rounded-full bg-info" />
              <span>{tasks.length}</span>
              <ChevronRightIcon aria-hidden className={THREAD_DETAILS_PANEL_CHEVRON_CLASS} />
            </span>
          </ThreadDetailsControl>
        )}
      </div>

      <BackgroundWorkInspectorDialog
        open={inspectTaskId !== null}
        onOpenChange={(open) => {
          if (!open) setInspectTaskId(null);
        }}
        environmentId={environmentId}
        threadId={threadId}
        tasks={tasks}
        turnItems={turnItems}
        initialTaskId={inspectTaskId}
        assumeLiveWithoutItems
        showHostHardware
        hostLabel={environment?.label}
        branch={branch}
        stopDisabled={stopDisabled}
        stopping={stopping}
        onStop={onStop}
        onOpenThread={onOpenThread}
      />
    </ThreadDetailsSection>
  );
}
