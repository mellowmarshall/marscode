/**
 * Slide-over detail inspector for T3-tracked background jobs (render, training, eval, build, test).
 * Surfaces actionable context first (title, owning thread link, command, explicit log state & tail),
 * followed by plottable time-series charts, compact KPIs, steps, and artifacts.
 */
import { useState } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import { T, Var, useGT } from "gt-react";
import {
  AlertTriangleIcon,
  ArrowUpRightIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CpuIcon,
  FolderIcon,
  TerminalIcon,
  XCircleIcon,
} from "lucide-react";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import type { DevdeckHostTelemetry, MergedFleetHost } from "../devdeckTypes";
import { DevtoolsStateBanner } from "../DevtoolsStateBanner";
import { isPlottableSeries, JobMetricChart } from "./JobCharts";
import { useJobDetail } from "./jobsStore";
import { JobArtifactsSection, JobStepsSection } from "./JobStepsAndArtifacts";
import {
  formatJobBytes,
  formatJobDuration,
  formatJobElapsed,
  formatMetricNumber,
  isJobLive,
  jobKindLabel,
  jobStateBadgeVariant,
  type JobLogState,
  type JobSummary,
} from "./jobTypes";

function findCorrelatedGpuInfo(
  job: JobSummary,
  localHost: DevdeckHostTelemetry | null,
  hosts: ReadonlyArray<MergedFleetHost>,
): string | null {
  const hostMatch = hosts.find(
    (h) =>
      h.shortName === job.binding.host ||
      h.id === job.binding.host ||
      h.probeHostName === job.binding.host,
  );
  const gpu = hostMatch?.telemetry?.gpu ?? localHost?.gpu;
  if (!gpu) return null;
  const parts: string[] = [];
  if (typeof gpu.busy_pct === "number") parts.push(`${Math.round(gpu.busy_pct)}% GPU`);
  if (
    typeof gpu.vram_used === "number" &&
    typeof gpu.vram_total === "number" &&
    gpu.vram_total > 0
  ) {
    parts.push(`${formatJobBytes(gpu.vram_used)}/${formatJobBytes(gpu.vram_total)} VRAM`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

function logStateTitle(logState: JobLogState, gt: ReturnType<typeof useGT>): string {
  switch (logState) {
    case "pending_file":
      return gt("Waiting for log file to appear");
    case "restricted":
      return gt("Log file blocked by log path policy");
    case "unreadable":
      return gt("Log file could not be read");
    case "remote_unavailable":
      return gt("Log file lives on a remote host");
    case "attached":
      return gt("Log file attached (no lines yet)");
    case "stream_only":
      return gt("Live command output");
    case "no_output":
    default:
      return gt("No command output captured yet");
  }
}

export function ManagedJobInspector({
  environmentId,
  job,
  nowMs,
  localHost,
  hosts,
  cancelling,
  onCancel,
  onOpenThread,
}: {
  readonly environmentId: EnvironmentId;
  readonly job: JobSummary;
  readonly nowMs: number;
  readonly localHost: DevdeckHostTelemetry | null;
  readonly hosts: ReadonlyArray<MergedFleetHost>;
  readonly cancelling: boolean;
  readonly onCancel: () => void;
  readonly onOpenThread?: ((threadId: string) => void) | undefined;
}) {
  const gt = useGT();
  const [confirmStopJobId, setConfirmStopJobId] = useState<string | null>(null);
  const [expandedCommandJobId, setExpandedCommandJobId] = useState<string | null>(null);
  const { detail, loading, error, status, retry } = useJobDetail(
    environmentId,
    job.id,
    job.revision,
  );
  const live = isJobLive(job);
  const isCernoProcessJob = job.id.startsWith("cerno:");
  const stopsWholeThread = job.source === "background" && !isCernoProcessJob;
  const confirmingStop = confirmStopJobId === job.id;
  const commandExpanded = expandedCommandJobId === job.id;
  const elapsed = formatJobElapsed(job.timing, nowMs);
  const eta = formatJobDuration(job.timing.etaSeconds);
  const pct = job.progress ? Math.round(job.progress.fraction * 100) : null;
  const gpuSummary = live ? findCorrelatedGpuInfo(job, localHost, hosts) : null;

  const pidStats = detail?.pidStats ?? job.pidStats;
  const logTail = detail?.logTail ?? job.recentTail ?? [];
  const logState: JobLogState =
    detail?.logState ?? job.logState ?? (logTail.length > 0 ? "stream_only" : "no_output");
  const logStateReason = detail?.logStateReason ?? job.logStateReason;
  const plottableSeries = (detail?.series ?? []).filter(isPlottableSeries);
  const commandText = detail?.command ?? pidStats?.cmdline ?? null;
  const isMultilineCommand = Boolean(
    commandText && (commandText.includes("\n") || commandText.length > 140),
  );

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="outline">{jobKindLabel(job.kind)}</Badge>
            <Badge variant={jobStateBadgeVariant(job.state)}>{job.phaseLabel}</Badge>
            {job.anomaly ? <Badge variant="error">{job.anomaly}</Badge> : null}
            <span className="font-mono text-3xs text-muted-foreground">{job.id}</span>
          </div>
          <h2 className="line-clamp-2 break-words text-sm font-semibold text-foreground">
            {job.title}
          </h2>
          {job.subtitle ? (
            <div className="truncate font-mono text-2xs text-muted-foreground">{job.subtitle}</div>
          ) : null}
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          {elapsed ? (
            <span className="font-mono text-xs text-muted-foreground tabular-nums">{elapsed}</span>
          ) : null}
          {job.binding.threadId && onOpenThread ? (
            <Button size="xs" variant="outline" onClick={() => onOpenThread(job.binding.threadId!)}>
              <ArrowUpRightIcon className="mr-1 size-3" />
              <T>Open thread</T>
            </Button>
          ) : null}
          {live && (job.cancellable || job.state === "cancelling") ? (
            confirmingStop && job.state !== "cancelling" ? (
              <>
                <Button size="xs" variant="ghost" onClick={() => setConfirmStopJobId(null)}>
                  <T>Cancel</T>
                </Button>
                <Button
                  size="xs"
                  variant="destructive"
                  disabled={cancelling}
                  title={gt("Stop owning thread, active turn, and all running background commands")}
                  onClick={() => {
                    setConfirmStopJobId(null);
                    onCancel();
                  }}
                >
                  <XCircleIcon className="mr-1 size-3.5" />
                  {isCernoProcessJob ? <T>Confirm stop process</T> : <T>Confirm stop thread</T>}
                </Button>
              </>
            ) : (
              <Button
                size="xs"
                variant="destructive"
                disabled={cancelling || job.state === "cancelling"}
                title={
                  stopsWholeThread
                    ? gt("Stop owning thread, active turn, and all running background commands")
                    : isCernoProcessJob
                      ? gt("Stop running cerno process (SIGTERM)")
                      : undefined
                }
                onClick={() =>
                  job.source === "background" ? setConfirmStopJobId(job.id) : onCancel()
                }
              >
                <XCircleIcon className="mr-1 size-3.5" />
                {job.state === "cancelling" ? (
                  <T>Stopping…</T>
                ) : stopsWholeThread ? (
                  <T>Stop thread</T>
                ) : isCernoProcessJob ? (
                  <T>Stop process</T>
                ) : (
                  <T>Cancel</T>
                )}
              </Button>
            )
          ) : null}
        </div>
      </div>

      {/* Host / Worktree / PID / GPU metadata strip */}
      <div className="space-y-1.5 rounded-md border bg-muted/15 px-3 py-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-3xs text-muted-foreground tabular-nums">
          <span>{job.binding.host}</span>
          {job.binding.branch ? <span>{job.binding.branch}</span> : null}
          {job.binding.worktreePath ? (
            <span className="inline-flex min-w-0 items-center gap-1">
              <FolderIcon className="size-3 shrink-0" />
              <span className="truncate">{job.binding.worktreePath}</span>
            </span>
          ) : null}
          {pidStats ? (
            <span>
              {`pid ${pidStats.pid}${pidStats.rssBytes ? ` · ${formatJobBytes(pidStats.rssBytes)} RSS` : ""}`}
            </span>
          ) : null}
          {gpuSummary ? (
            <span className="inline-flex items-center gap-1 text-foreground/80">
              <CpuIcon className="size-3 shrink-0" />
              <span>{gpuSummary}</span>
            </span>
          ) : null}
        </div>

        {commandText ? (
          <div className="space-y-1">
            {isMultilineCommand ? (
              <button
                type="button"
                className="inline-flex items-center gap-1 font-mono text-3xs text-muted-foreground hover:text-foreground"
                onClick={() => setExpandedCommandJobId((prev) => (prev === job.id ? null : job.id))}
              >
                {commandExpanded ? (
                  <ChevronDownIcon className="size-3" />
                ) : (
                  <ChevronRightIcon className="size-3" />
                )}
                <span>{commandExpanded ? gt("Hide command") : gt("Show full command")}</span>
              </button>
            ) : null}
            <pre
              className={
                isMultilineCommand && !commandExpanded
                  ? "max-h-12 overflow-hidden rounded bg-background/70 px-2 py-1 font-mono text-3xs text-foreground/85"
                  : "max-h-40 overflow-auto rounded bg-background/70 px-2 py-1.5 font-mono text-3xs whitespace-pre-wrap break-all text-foreground/85"
              }
            >
              {commandText}
            </pre>
          </div>
        ) : null}
      </div>

      {/* Summary & Cerno verdict */}
      {job.summary ? (
        <div className="rounded-md border bg-muted/25 px-3 py-2 text-xs text-foreground">
          {job.summary}
        </div>
      ) : null}

      {detail?.cerno &&
      (detail.cerno.hangLoop || detail.cerno.needsInput || detail.cerno.summary) ? (
        <div className="flex items-center gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning-foreground">
          <AlertTriangleIcon className="size-3.5 shrink-0 text-warning" />
          <span className="min-w-0 truncate">
            {detail.cerno.summary ||
              (detail.cerno.hangLoop
                ? gt("Log analyzer flagged a possible hang loop.")
                : gt("Log analyzer flagged a process waiting for input."))}
          </span>
        </div>
      ) : null}

      {/* Progress bar + rate + ETA */}
      {job.progress ? (
        <div className="space-y-1.5 rounded-md border bg-muted/20 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs tabular-nums">
            <div className="flex items-center gap-2 font-mono">
              <span className="font-semibold text-foreground">{`${pct ?? 0}%`}</span>
              <span className="text-muted-foreground">
                {`${Math.round(job.progress.current)}/${Math.round(job.progress.total)}${job.progress.unit ? ` ${job.progress.unit}` : ""}`}
              </span>
              {job.progress.stageLabel ? (
                <Badge size="sm" variant="outline">
                  {job.progress.stageLabel}
                </Badge>
              ) : null}
            </div>
            <div className="flex items-center gap-3 font-mono text-2xs text-muted-foreground">
              {job.progress.rate !== undefined ? (
                <span>{`${job.progress.rate} ${job.progress.rateUnit ?? "/s"}`}</span>
              ) : null}
              {eta ? (
                <span>
                  <T>
                    ETA <Var>{eta}</Var>
                  </T>
                </span>
              ) : null}
            </div>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-info transition-[width] duration-300"
              style={{ width: `${Math.max(0, Math.min(100, pct ?? 0))}%` }}
            />
          </div>
        </div>
      ) : null}

      {/* Detail fetch state */}
      {error ? (
        <DevtoolsStateBanner
          compact
          status={status === "degraded" ? "degraded" : "error"}
          title={error}
          onRetry={retry}
          retrying={loading}
        />
      ) : loading && !detail ? (
        <DevtoolsStateBanner
          compact
          status="connecting"
          title={<T>Loading job output and metrics…</T>}
        />
      ) : null}

      {/* Bounded Log Tail & Explicit Log State (shown BEFORE charts so useful output is immediate) */}
      <div
        data-testid="job-inspector-log-section"
        data-log-state={logState}
        className="space-y-1.5 rounded-md border bg-muted/20 p-3"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
            <TerminalIcon className="size-3" />
            <T>Output & Log Tail</T>
          </div>
          <span className="truncate font-mono text-3xs text-muted-foreground tabular-nums">
            {detail?.logPath
              ? gt("{path} ({count} lines)", {
                  path: detail.logPath,
                  count: detail.linesParsed ?? logTail.length,
                })
              : logTail.length > 0
                ? gt("{count} lines", { count: logTail.length })
                : logStateTitle(logState, gt)}
          </span>
        </div>

        {logTail.length > 0 ? (
          <>
            {logStateReason ? (
              <div className="text-3xs text-muted-foreground">{logStateReason}</div>
            ) : null}
            <pre className="max-h-72 overflow-auto rounded bg-background/80 p-2.5 font-mono text-3xs leading-relaxed text-foreground/90">
              {logTail.slice(-120).join("\n")}
            </pre>
          </>
        ) : (
          <div className="rounded bg-background/60 px-3 py-2.5 text-2xs text-muted-foreground">
            <div className="font-medium text-foreground/85">{logStateTitle(logState, gt)}</div>
            {logStateReason ? (
              <div className="mt-0.5 font-mono text-3xs">{logStateReason}</div>
            ) : null}
          </div>
        )}
      </div>

      {/* Compact Scalar KPI Strip */}
      {job.kpis && job.kpis.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {job.kpis.map((kpi) => (
            <div
              key={kpi.key}
              className="inline-flex items-baseline gap-1.5 rounded-md border bg-muted/20 px-2.5 py-1 text-2xs"
            >
              <span className="text-muted-foreground">{kpi.label}</span>
              <span
                className={
                  kpi.anomaly
                    ? "font-mono font-semibold text-destructive tabular-nums"
                    : "font-mono font-semibold text-foreground tabular-nums"
                }
              >
                {kpi.text ?? formatMetricNumber(kpi.value, kpi.anomaly)}
                {kpi.unit ? (
                  <span className="ml-0.5 text-3xs font-normal text-muted-foreground">
                    {kpi.unit}
                  </span>
                ) : null}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {/* Plottable Metric Series Charts Only (never empty 1-point or flat-constant boxes) */}
      {plottableSeries.length > 0 ? (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {plottableSeries.map((series) => (
            <JobMetricChart key={series.key} series={series} />
          ))}
        </div>
      ) : null}

      {detail?.steps && detail.steps.length > 0 ? <JobStepsSection steps={detail.steps} /> : null}
      {detail?.artifacts && detail.artifacts.length > 0 ? (
        <JobArtifactsSection artifacts={detail.artifacts} />
      ) : null}
    </div>
  );
}
