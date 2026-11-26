/**
 * Ultra-compact 2-line Ship Queue status card for the narrow Thread Details right rail.
 */
import { useGT } from "gt-react";
import { ExternalLinkIcon, ServerIcon, XCircleIcon, XIcon } from "lucide-react";

import { Button } from "../components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import type { ShipQueueJob } from "./devtoolsClient";
import {
  buildSafePrUrl,
  deriveShipJobSteps,
  formatShipJobElapsed,
  isShipQueueJobLive,
  resolveShipJobDisplayState,
} from "./ShipQueueSteps";

export function ShipQueueMiniCard({
  job,
  nowMs,
  cancelling,
  actionError,
  onCancel,
  onDismiss,
}: {
  readonly job: ShipQueueJob;
  readonly nowMs: number;
  readonly cancelling: boolean;
  readonly actionError: string | null;
  readonly onCancel: () => void;
  readonly onDismiss: () => void;
}) {
  const gt = useGT();
  const activeElapsed = formatShipJobElapsed(job, nowMs);
  const prUrl = buildSafePrUrl(job);
  const steps = deriveShipJobSteps(job, {
    queued: gt("Queued"),
    watcher: gt("Watcher"),
    ci: gt("CI"),
    push: gt("Push"),
    pr: gt("PR"),
    merge: gt("Merge"),
    land: gt("Deploy"),
  });
  const current =
    steps.find((s) => s.state === "failed") ??
    steps.find((s) => s.state === "active") ??
    steps.find((s) => s.state === "waiting") ??
    steps.findLast((s) => s.state === "done") ??
    steps[0];
  const dotCls =
    current?.state === "failed"
      ? "bg-destructive"
      : current?.state === "waiting"
        ? "bg-warning"
        : current?.state === "active"
          ? "bg-info animate-pulse"
          : current?.state === "done"
            ? "bg-success"
            : "bg-muted-foreground/45";
  const txtCls =
    current?.state === "failed"
      ? "text-destructive-foreground"
      : current?.state === "waiting"
        ? "text-warning-foreground"
        : current?.state === "active"
          ? "text-info-foreground"
          : current?.state === "done"
            ? "text-success-foreground"
            : "text-muted-foreground";
  const live = isShipQueueJobLive(job);
  const routeHost =
    typeof job.route?.host === "string" && job.route.host.trim().length > 0
      ? job.route.host.trim()
      : null;

  const tooltipDetail =
    routeHost && current?.id === "ci"
      ? `${current.detail ? `${current.detail} · ` : ""}${routeHost}`
      : (current?.detail ?? current?.label ?? resolveShipJobDisplayState(job));

  return (
    <div className="space-y-1.5 rounded-md border border-border/70 bg-card/60 px-2 py-1.5">
      <div className="flex items-center justify-between gap-1.5 text-2xs">
        <Tooltip>
          <TooltipTrigger
            render={
              <span className={`inline-flex min-w-0 items-center gap-1.5 font-medium ${txtCls}`}>
                <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${dotCls}`} />
                <span className="truncate">
                  {current?.label ?? resolveShipJobDisplayState(job)}
                </span>
              </span>
            }
          />
          <TooltipPopup side="top" className="max-w-xs break-words">
            {tooltipDetail}
          </TooltipPopup>
        </Tooltip>
        <div className="flex shrink-0 items-center gap-1">
          {activeElapsed ? (
            <span className="font-mono text-3xs text-muted-foreground tabular-nums">
              {activeElapsed}
            </span>
          ) : null}
          {prUrl ? (
            <a
              href={prUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-0.5 font-mono text-3xs text-info-foreground hover:underline"
              aria-label={gt("Open Pull Request")}
            >
              <span>{job.pr ? `#${job.pr}` : ""}</span>
              <ExternalLinkIcon className="size-2.5" />
            </a>
          ) : null}
          {job.id && /^[0-9]{1,16}$/.test(job.id) && live ? (
            <Button
              size="icon-micro"
              variant="ghost"
              disabled={cancelling}
              aria-label={gt("Cancel job")}
              onClick={onCancel}
            >
              <XCircleIcon className="size-3 text-muted-foreground hover:text-destructive" />
            </Button>
          ) : !live ? (
            <Button
              size="icon-micro"
              variant="ghost"
              aria-label={gt("Dismiss")}
              onClick={onDismiss}
            >
              <XIcon className="size-3 text-muted-foreground hover:text-foreground" />
            </Button>
          ) : null}
        </div>
      </div>

      {routeHost ? (
        <div className="flex items-center gap-1 text-3xs text-muted-foreground">
          <ServerIcon className="size-2.5 shrink-0" />
          <span data-testid="ship-queue-host" className="truncate font-mono">
            {routeHost}
          </span>
        </div>
      ) : null}

      {actionError ? <div className="text-3xs text-destructive">{actionError}</div> : null}

      <div className="flex gap-0.5" aria-hidden>
        {steps.map((step) => (
          <span
            key={step.id}
            className={
              step.state === "done"
                ? "h-1 flex-1 rounded-full bg-success"
                : step.state === "active"
                  ? "h-1 flex-1 rounded-full bg-info"
                  : step.state === "waiting"
                    ? "h-1 flex-1 rounded-full bg-warning"
                    : step.state === "failed"
                      ? "h-1 flex-1 rounded-full bg-destructive"
                      : "h-1 flex-1 rounded-full bg-muted"
            }
          />
        ))}
      </div>
    </div>
  );
}
