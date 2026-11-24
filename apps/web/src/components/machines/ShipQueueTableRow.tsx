import type { ShipQueueDepRepo, ShipQueueJob, ThreadId } from "@t3tools/contracts";
import { T, useGT, Var } from "gt-react";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  ShieldQuestionIcon,
} from "lucide-react";
import { useState } from "react";

import {
  buildSafePrUrl,
  extractShipIssueRefs,
  formatShipJobElapsed,
  formatShipWhenStamp,
  isShipQueueJobLive,
  resolveShipJobDisplayState,
  shipQueueStatusVariant,
  shouldHideRedundantStatusBadge,
} from "../../lib/shipQueueSteps";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { ShipQueueVerticalTracker } from "./ShipQueueVerticalTracker";

function statusDotClass(variant: ReturnType<typeof shipQueueStatusVariant>): string {
  if (variant === "error") return "bg-destructive";
  if (variant === "success") return "bg-success";
  if (variant === "warning") return "bg-warning";
  if (variant === "info") return "bg-info";
  return "bg-muted-foreground/60";
}

function localizedJobState(raw: string, gt: ReturnType<typeof useGT>): string {
  const lower = raw.trim().toLowerCase();
  if (lower === "deploying") return gt("Deploying");
  if (lower === "post-merge") return gt("Post-merge");
  if (lower === "running") return gt("Running");
  if (lower === "queued") return gt("Queued");
  if (lower === "waiting_watcher" || lower === "waiting") return gt("Waiting");
  if (lower === "parked") return gt("Parked");
  if (lower === "done" || lower === "merged") return gt("Done");
  if (lower === "cancelled") return gt("Cancelled");
  if (lower === "failed") return gt("Failed");
  return raw;
}

export function ShipQueueTableRow({
  job,
  depHold,
  threadExists,
  nowMs,
  canOperate,
  cancelling,
  onOpenThread,
  onCancel,
}: {
  readonly job: ShipQueueJob;
  readonly depHold: ShipQueueDepRepo | null;
  readonly threadExists: boolean;
  readonly nowMs: number;
  readonly canOperate: boolean;
  readonly cancelling: boolean;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly onCancel: (jobId: string) => void;
}) {
  const gt = useGT();
  const [expanded, setExpanded] = useState(false);

  const isLive = isShipQueueJobLive(job);
  const displayState = resolveShipJobDisplayState(job);
  const variant = shipQueueStatusVariant(displayState);
  const showStateBadge = !shouldHideRedundantStatusBadge(displayState);
  const prUrl = buildSafePrUrl(job);
  const issueRefs = extractShipIssueRefs(job);
  const elapsed = formatShipJobElapsed(job, nowMs);
  const when = formatShipWhenStamp(job.submittedAt, nowMs);

  return (
    <li className="min-w-0 list-none">
      <div className="flex flex-col gap-2.5 px-4 py-3 md:flex-row md:items-center md:justify-between md:gap-4">
        <div className="flex min-w-0 items-start gap-2.5">
          <Button
            aria-expanded={expanded}
            aria-label={expanded ? gt("Collapse ship steps") : gt("Expand ship steps")}
            className="mt-0.5 shrink-0"
            size="icon-micro"
            variant="ghost"
            onClick={() => setExpanded((prev) => !prev)}
          >
            {expanded ? (
              <ChevronDownIcon className="size-3.5" />
            ) : (
              <ChevronRightIcon className="size-3.5" />
            )}
          </Button>

          <span
            aria-hidden
            className={cn("mt-1.5 size-2 shrink-0 rounded-full", statusDotClass(variant))}
          />

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="max-w-full truncate text-sm font-medium text-foreground">
                {job.title || job.branch || job.repo || job.id}
              </span>
              {depHold ? (
                <Badge size="sm" variant="warning">
                  <ShieldQuestionIcon aria-hidden className="size-3" />
                  <T>Approval</T>
                </Badge>
              ) : null}
              {showStateBadge ? (
                <Badge size="sm" variant={variant}>
                  {localizedJobState(displayState, gt)}
                </Badge>
              ) : null}
              {job.routeHost ? (
                <Badge size="sm" variant="secondary">
                  {job.routeHost}
                </Badge>
              ) : null}
            </div>

            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              {job.repo ? <span className="font-medium text-foreground/80">{job.repo}</span> : null}
              {job.branch ? (
                <code className="truncate font-mono text-2xs">{job.branch}</code>
              ) : null}
              <span className="font-mono text-2xs">#{job.id}</span>
              {job.pr ? (
                prUrl ? (
                  <a
                    href={prUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-0.5 font-mono text-2xs text-info-foreground hover:underline"
                  >
                    <T>
                      PR #<Var>{job.pr}</Var>
                    </T>
                    <ExternalLinkIcon aria-hidden className="size-2.5" />
                  </a>
                ) : (
                  <span className="font-mono text-2xs">
                    <T>
                      PR #<Var>{job.pr}</Var>
                    </T>
                  </span>
                )
              ) : null}
              {issueRefs.map((ref) =>
                ref.url ? (
                  <a
                    key={ref.num}
                    href={ref.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-0.5 font-mono text-2xs text-muted-foreground hover:text-foreground hover:underline"
                  >
                    #{ref.num}
                  </a>
                ) : (
                  <span key={ref.num} className="font-mono text-2xs">
                    #{ref.num}
                  </span>
                ),
              )}
            </div>

            {job.reason && variant === "error" ? (
              <p className="mt-1 text-xs text-destructive-foreground break-words">{job.reason}</p>
            ) : job.waiting && isLive ? (
              <p className="mt-1 text-xs text-muted-foreground break-words">{job.waiting}</p>
            ) : null}
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 pl-7 md:pl-0">
          {elapsed ? (
            <span className="text-xs text-muted-foreground tabular-nums">{elapsed}</span>
          ) : null}
          {when ? (
            <span className="text-2xs text-muted-foreground tabular-nums">{when}</span>
          ) : null}
          {job.threadId && threadExists ? (
            <Button
              size="xs"
              variant="outline"
              onClick={() => onOpenThread(job.threadId as ThreadId)}
            >
              <T>Open thread</T>
            </Button>
          ) : null}
          {isLive && canOperate ? (
            <Button
              size="xs"
              variant="ghost-destructive"
              disabled={cancelling}
              onClick={() => onCancel(job.id)}
            >
              {cancelling ? <T>Cancelling…</T> : <T>Cancel</T>}
            </Button>
          ) : null}
        </div>
      </div>

      {expanded ? (
        <div className="border-t border-border/50 bg-muted/20 px-4 py-3 pl-9">
          <ShipQueueVerticalTracker job={job} />
        </div>
      ) : null}
    </li>
  );
}
