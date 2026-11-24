import type { CommandOutputView } from "@t3tools/client-runtime/state/command-output";
import type { ThreadStructure } from "@t3tools/client-runtime/state/shell";
import {
  AuthDiagnosticsReadScope,
  type CernoLiveRun,
  type EnvironmentId,
  type OrchestrationV2PendingBackgroundTask,
  type ThreadId,
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
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import {
  BackgroundWorkInspectorDialog,
  resolveBackgroundTaskTurnItem,
} from "../jobs/BackgroundWorkInspector";
import { isCernoCommand } from "../jobs/cernoCommand";
import {
  CernoCertaintyPips,
  cernoToneDotClass,
  cernoToneTextClass,
} from "../jobs/CernoRunAssessment";
import {
  formatCernoElapsed,
  matchCernoRunsToTasks,
  presentCernoRun,
  selectCommandOutputMetrics,
  type CernoOperatorTone,
} from "../jobs/cernoRunPresentation";
import { selectVisibleBackgroundWorkTasks } from "../jobs/shipQueueBackgroundFilter";
import {
  detectSilentStallSeconds,
  formatCompactElapsed,
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
  cernoRun,
  nowMs,
  onInspect,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly task: OrchestrationV2PendingBackgroundTask;
  readonly turnItems: ThreadStructure["turnItems"];
  readonly cernoRun: CernoLiveRun | null;
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

  const rawStreamText =
    outputQuery.data?.output.text ??
    (item?.type === "command_execution" ? (item.output ?? "") : "");
  const metrics = selectCommandOutputMetrics(rawStreamText, cernoRun?.logTail);
  const progress = metrics?.progress ?? null;
  const pct = progress ? Math.max(0, Math.min(100, Math.round(progress.fraction * 100))) : null;

  const isRunningOutput = outputActive && (outputQuery.data ? outputQuery.data.running : true);
  const itemUpdatedMs =
    item && "updatedAt" in item && item.updatedAt ? DateTime.toEpochMillis(item.updatedAt) : null;
  const lastActivityMs = outputQuery.dataUpdatedAt > 0 ? outputQuery.dataUpdatedAt : itemUpdatedMs;
  const silentSeconds = cernoRun
    ? null
    : detectSilentStallSeconds(lastActivityMs, nowMs, isRunningOutput);

  const label = shortJobLabel(task, command);
  const fullName = task.description?.trim() || command?.split(/\r?\n/u)[0]?.trim() || label;
  const elapsedText = cernoRun
    ? formatCernoElapsed(cernoRun, nowMs)
    : item?.startedAt
      ? formatCompactElapsed(Math.max(0, nowMs - DateTime.toEpochMillis(item.startedAt)))
      : null;

  if (cernoRun) {
    const view = presentCernoRun(cernoRun);
    const tipParts = [
      fullName,
      gt("{verdict} ({percent}%)", {
        verdict: view.verdict,
        percent: view.confidencePct,
      }),
      view.liveness,
      pct !== null ? `${pct}%` : null,
      progress?.etaText ? gt("ETA {eta}", { eta: progress.etaText }) : null,
    ].filter(Boolean);

    return (
      <Tooltip>
        <TooltipTrigger
          delay={200}
          render={
            <ThreadDetailsControl
              size="sm"
              variant="ghost"
              part="row"
              multiline
              onClick={() => onInspect(task.taskId)}
            />
          }
        >
          <div className="flex w-full min-w-0 flex-col gap-1">
            <div className="flex min-w-0 items-center gap-2">
              <span
                aria-hidden
                className={cn("size-1.5 shrink-0 rounded-full", cernoToneDotClass(view.tone))}
              />
              <span
                className={cn(
                  "min-w-0 flex-1 truncate font-mono text-xs text-foreground/90",
                  THREAD_DETAILS_PANEL_LABEL_CLASS,
                )}
              >
                {label}
              </span>
              <span className="shrink-0 font-mono text-2xs text-muted-foreground tabular-nums">
                {elapsedText}
              </span>
            </div>
            <div className="flex min-w-0 items-center justify-between gap-2 ps-3.5 text-2xs">
              <span className="inline-flex min-w-0 items-center gap-1.5">
                <span className={cn("truncate font-medium", cernoToneTextClass(view.tone))}>
                  {view.verdict}
                </span>
                <CernoCertaintyPips pips={view.pips} tone={view.tone} />
                <span className="font-mono text-muted-foreground tabular-nums">
                  {view.confidencePct}%
                </span>
              </span>
              <span className="shrink-0 font-mono text-muted-foreground tabular-nums">
                {view.liveness}
              </span>
            </div>
            {pct !== null && progress ? (
              <div className="flex items-center gap-2 ps-3.5 font-mono text-2xs text-muted-foreground tabular-nums">
                <span
                  aria-hidden
                  className="block h-[3px] flex-1 overflow-hidden rounded-full bg-muted-foreground/20"
                >
                  <span
                    className={cn(
                      "block h-full rounded-full transition-[width] duration-300",
                      view.tone === "warning" || view.tone === "destructive"
                        ? "bg-warning"
                        : "bg-info",
                    )}
                    style={{ width: `${pct}%` }}
                  />
                </span>
                <span className="shrink-0">
                  {`${pct}% · ${Math.round(progress.current)}/${Math.round(progress.total)}`}
                </span>
              </div>
            ) : null}
          </div>
        </TooltipTrigger>
        <TooltipPopup side="left" className="max-w-xs">
          {tipParts.join(" · ")}
        </TooltipPopup>
      </Tooltip>
    );
  }

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
  cwd,
  branch,
  excludeShipQueue,
  knownShipJobIds,
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
  readonly cwd?: string | null | undefined;
  readonly branch?: string | null | undefined;
  readonly excludeShipQueue?: boolean | undefined;
  readonly knownShipJobIds?: ReadonlySet<string> | undefined;
  readonly stopDisabled: boolean;
  readonly stopping: boolean;
  readonly onStop: () => Promise<void>;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const gt = useGT();
  const environment = useEnvironment(environmentId);
  const canReadDiagnostics = useEnvironmentScope(environmentId, AuthDiagnosticsReadScope);
  const [inspectTaskId, setInspectTaskId] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const mergedTasks = selectVisibleBackgroundWorkTasks({
    tasks,
    turnItems,
    excludeShipQueue,
    knownShipJobIds,
  });
  const taskCandidates = mergedTasks.map((task) => {
    const item = resolveBackgroundTaskTurnItem(task, turnItems);
    return {
      taskId: task.taskId,
      command: task.command ?? (item?.type === "command_execution" ? item.input : undefined),
    };
  });
  const hasCernoCandidate = taskCandidates.some((candidate) => isCernoCommand(candidate.command));

  const cernoQuery = useEnvironmentQuery(
    canReadDiagnostics && hasCernoCandidate
      ? serverEnvironment.cernoRuns({ environmentId, input: {} })
      : null,
  );
  const cernoRuns = cernoQuery.data?.runs ?? [];

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- poll 5s clock while active background tasks render in the thread rail
  useEffect(() => {
    if (mergedTasks.length === 0) return;
    const id = window.setInterval(() => setNowMs(Date.now()), 5_000);
    return () => window.clearInterval(id);
  }, [mergedTasks.length]);

  if (mergedTasks.length === 0) return null;

  const matchedByTaskId = matchCernoRunsToTasks(taskCandidates, cernoRuns, cwd);

  let worstTone: CernoOperatorTone = "info";
  let worstVerdict: string | null = null;
  let worstRank = -1;
  for (const run of matchedByTaskId.values()) {
    if (!run) continue;
    const view = presentCernoRun(run);
    const rank =
      view.tone === "destructive"
        ? 4
        : view.tone === "warning"
          ? 3
          : view.tone === "info" || view.tone === "success"
            ? 2
            : 1;
    if (rank > worstRank) {
      worstRank = rank;
      worstTone = view.tone;
      worstVerdict = view.verdict;
    }
  }

  const showInlineRows = density === "full" && mergedTasks.length <= MAX_INLINE_RAIL_JOBS;

  return (
    <ThreadDetailsSection
      headingId="thread-details-background-work-heading"
      title={gt("Background work")}
      showHeading={false}
    >
      <div data-thread-details-background-work className="flex flex-col">
        {showInlineRows ? (
          mergedTasks.map((task) => (
            <BackgroundWorkRailRow
              key={task.taskId}
              environmentId={environmentId}
              threadId={threadId}
              task={task}
              turnItems={turnItems}
              cernoRun={matchedByTaskId.get(task.taskId) ?? null}
              nowMs={nowMs}
              onInspect={(taskId) => setInspectTaskId(taskId)}
            />
          ))
        ) : (
          <ThreadDetailsControl
            size="sm"
            variant="ghost"
            part="row"
            onClick={() => setInspectTaskId(mergedTasks[0]?.taskId ?? null)}
          >
            <TerminalIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
            <span className={cn("min-w-0 flex-1 truncate", THREAD_DETAILS_PANEL_LABEL_CLASS)}>
              <T>Background work</T>
            </span>
            <span className="flex shrink-0 items-center gap-1.5 font-mono text-xs text-muted-foreground tabular-nums">
              <span
                aria-hidden
                className={cn("size-1.5 rounded-full", cernoToneDotClass(worstTone))}
              />
              <span>
                {worstVerdict ? `${mergedTasks.length} · ${worstVerdict}` : mergedTasks.length}
              </span>
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
        tasks={mergedTasks}
        turnItems={turnItems}
        cernoRuns={cernoRuns}
        initialTaskId={inspectTaskId}
        assumeLiveWithoutItems
        showHostHardware
        hostLabel={environment?.label}
        branch={branch}
        worktreePath={cwd}
        stopDisabled={stopDisabled}
        stopping={stopping}
        onStop={onStop}
        onOpenThread={onOpenThread}
      />
    </ThreadDetailsSection>
  );
}
