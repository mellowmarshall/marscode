/**
 * Ultra-compact right-rail row for a background job bound to the active thread.
 * Designed for the narrow (~180-220px) Thread Details rail: 1-3 glanceable lines with
 * semantic status dot, thin blue progress bar, and click-to-open slide-over Job Inspector.
 */
import { T, useGT } from "gt-react";
import { XCircleIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../../components/ui/button";
import { TruncatedText } from "../TruncatedText";
import { JobSparkline } from "./JobCharts";
import {
  formatJobElapsed,
  isJobLive,
  jobKindLabel,
  jobTerminalStateLabel,
  type JobSummary,
} from "./jobTypes";

function statusDotClass(state: JobSummary["state"]): string {
  if (state === "running") return "bg-info animate-pulse";
  if (state === "queued" || state === "waiting") return "bg-warning animate-pulse";
  if (state === "done") return "bg-success";
  if (state === "failed" || state === "cancelled" || state === "cancelling") {
    return "bg-destructive";
  }
  return "bg-muted-foreground";
}

export function ThreadManagedJobCard({
  job,
  nowMs,
  cancelling,
  onCancel,
  onDismiss,
  onInspect,
}: {
  readonly job: JobSummary;
  readonly nowMs: number;
  readonly cancelling: boolean;
  readonly onCancel: () => void;
  readonly onDismiss?: () => void;
  readonly onInspect: () => void;
}) {
  const gt = useGT();
  const [confirmStopJobId, setConfirmStopJobId] = useState<string | null>(null);
  const live = isJobLive(job);
  const confirmingStop = live && confirmStopJobId === job.id && job.state !== "cancelling";
  const pct = job.progress
    ? Math.max(0, Math.min(100, Math.round(job.progress.fraction * 100)))
    : null;
  const elapsed = formatJobElapsed(job.timing, nowMs);
  const label = job.title.trim() || jobKindLabel(job.kind);
  const terminalTone =
    job.state === "failed" || job.state === "cancelled" || job.state === "cancelling"
      ? "text-destructive-foreground"
      : job.state === "done"
        ? "text-success-foreground"
        : "text-muted-foreground";

  const isCernoProcessJob = job.id.startsWith("cerno:");
  const stopsWholeThread = job.source === "background" && !isCernoProcessJob;
  const isStallAnomaly = Boolean(job.anomaly && job.anomaly.startsWith("No output for "));

  return (
    <div className="group space-y-1.5 rounded-md border border-border/70 bg-card/60 px-2 py-1.5 text-2xs transition-colors hover:border-border hover:bg-muted/30">
      {/* Row 1: clickable inspect trigger + sibling action button (zero nested interactive elements, L11) */}
      <div className="flex items-center justify-between gap-1">
        <button
          type="button"
          aria-label={gt("Inspect job: {title}", { title: label })}
          className="flex min-w-0 flex-1 items-center justify-between gap-1.5 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          onClick={onInspect}
        >
          <span className="flex min-w-0 flex-1 items-center gap-1.5">
            <span
              aria-hidden
              className={`size-1.5 shrink-0 rounded-full ${statusDotClass(job.state)}`}
            />
            <TruncatedText
              as="span"
              text={label}
              className="min-w-0 flex-1 truncate font-medium text-foreground"
            />
          </span>
          <span className="flex shrink-0 items-center gap-1">
            {live && pct !== null ? (
              <span
                data-testid="job-progress-pct"
                className="font-mono text-3xs font-medium text-foreground/85 tabular-nums"
              >
                {`${pct}%`}
              </span>
            ) : !live ? (
              <span className={`font-mono text-3xs font-medium tabular-nums ${terminalTone}`}>
                {jobTerminalStateLabel(job.state)}
              </span>
            ) : null}
            {elapsed ? (
              <span
                data-testid="job-elapsed"
                className="whitespace-nowrap font-mono text-3xs text-muted-foreground tabular-nums"
              >
                {elapsed}
              </span>
            ) : null}
          </span>
        </button>
        {live && (job.cancellable || job.state === "cancelling") ? (
          <Button
            size="icon-micro"
            variant="ghost"
            disabled={cancelling || job.state === "cancelling"}
            aria-label={
              stopsWholeThread
                ? gt("Stop thread (stops active turn and background commands)")
                : isCernoProcessJob
                  ? gt("Stop process")
                  : gt("Cancel job")
            }
            onClick={() => {
              if (job.source === "background") {
                setConfirmStopJobId(confirmingStop ? null : job.id);
              } else {
                onCancel();
              }
            }}
          >
            <XCircleIcon className="size-3 text-muted-foreground hover:text-destructive" />
          </Button>
        ) : onDismiss ? (
          <Button size="icon-micro" variant="ghost" aria-label={gt("Dismiss")} onClick={onDismiss}>
            <XIcon className="size-3 text-muted-foreground hover:text-foreground" />
          </Button>
        ) : null}
      </div>

      {confirmingStop ? (
        <div className="flex flex-wrap items-center justify-between gap-1 rounded border border-destructive/40 bg-destructive/10 px-1.5 py-1 text-3xs">
          <span className="text-foreground">
            {isCernoProcessJob ? <T>Stop process?</T> : <T>Stop thread?</T>}
          </span>
          <div className="flex items-center gap-1">
            <Button size="xs" variant="ghost" onClick={() => setConfirmStopJobId(null)}>
              <T>Cancel</T>
            </Button>
            <Button
              size="xs"
              variant="destructive"
              disabled={cancelling}
              onClick={() => {
                setConfirmStopJobId(null);
                onCancel();
              }}
            >
              <T>Stop</T>
            </Button>
          </div>
        </div>
      ) : null}

      {/* Row 2: thin 4px blue progress bar (only when progress exists) */}
      {pct !== null ? (
        <div className="h-1 w-full overflow-hidden rounded-full bg-muted" onClick={onInspect}>
          <div
            className="h-full rounded-full bg-info transition-[width] duration-300"
            style={{ width: `${pct}%` }}
          />
        </div>
      ) : null}

      {/* Row 3: anomaly chip (warning amber for stalls, error red for failures) OR mini sparkline */}
      {job.anomaly ? (
        <div
          className={`truncate font-mono text-3xs ${
            isStallAnomaly ? "text-warning-foreground" : "text-destructive-foreground"
          }`}
          onClick={onInspect}
        >
          {job.anomaly}
        </div>
      ) : job.sparkline ? (
        <div onClick={onInspect}>
          <JobSparkline sparkline={job.sparkline} />
        </div>
      ) : null}
    </div>
  );
}
