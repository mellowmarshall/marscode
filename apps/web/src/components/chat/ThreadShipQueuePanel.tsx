import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ShipQueueJob,
  type ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { msg, T, useGT, useMessages, Var } from "gt-react";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  ShieldQuestionIcon,
  XIcon,
} from "lucide-react";
import { useId, useState } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { useNowSecond } from "../../hooks/useNowSecond";
import { findActionableDepHoldForJob } from "../../lib/shipQueueApprovals";
import {
  buildSafePrUrl,
  deriveShipJobSteps,
  formatShipJobElapsed,
  isShipQueueJobLive,
  resolveShipJobDisplayState,
  shipQueueStatusVariant,
  type ShipStepState,
} from "../../lib/shipQueueSteps";
import {
  addBoundedDismiss,
  selectVisibleThreadShipJobs,
  shipJobKey,
} from "../../lib/threadShipStatus";
import { cn } from "../../lib/utils";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { useShipQueueSnapshot, useThreadShipJobs } from "../../state/shipQueue";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button, InlineButton } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ThreadDetailsSection } from "./ThreadDetailsSection";

function LiveShipElapsed({ job }: { readonly job: ShipQueueJob }) {
  const nowMs = useNowSecond();
  const text = formatShipJobElapsed(job, nowMs);
  if (!text) return null;
  return <span className="text-2xs text-muted-foreground tabular-nums">{text}</span>;
}

function statusDotClass(variant: ReturnType<typeof shipQueueStatusVariant>): string {
  if (variant === "error") return "bg-destructive";
  if (variant === "success") return "bg-success";
  if (variant === "warning") return "bg-warning";
  if (variant === "info") return "bg-info";
  return "bg-muted-foreground/60";
}

function segmentClass(state: ShipStepState): string {
  if (state === "done") return "bg-success";
  if (state === "active") return "bg-info";
  if (state === "waiting") return "bg-warning";
  if (state === "failed") return "bg-destructive";
  return "bg-muted-foreground/20";
}

function stepStateLabel(state: ShipStepState, resolve: ReturnType<typeof useMessages>): string {
  if (state === "done") return resolve(msg("done"));
  if (state === "active") return resolve(msg("active"));
  if (state === "waiting") return resolve(msg("waiting"));
  if (state === "failed") return resolve(msg("failed"));
  return resolve(msg("pending"));
}

function displayStateLabel(rawDisplay: string, gt: ReturnType<typeof useGT>): string {
  const lower = rawDisplay.trim().toLowerCase();
  if (lower === "deploying") return gt("Deploying");
  if (lower === "post-merge") return gt("Post-merge");
  if (lower === "running") return gt("Shipping");
  if (lower === "queued") return gt("Queued");
  if (lower === "waiting_watcher" || lower === "waiting") return gt("Waiting");
  if (lower === "parked") return gt("Parked");
  if (lower === "done" || lower === "merged") return gt("Shipped");
  if (lower === "cancelled") return gt("Cancelled");
  if (lower === "failed") return gt("Failed");
  return rawDisplay;
}

export function ThreadShipQueuePanel({
  environmentId,
  threadId,
  branch,
  worktreePath,
  gitCwd,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly gitCwd: string | null;
}) {
  const headingId = useId();
  const gt = useGT();
  const resolve = useMessages();
  const navigate = useNavigate();
  const snap = useShipQueueSnapshot(environmentId);
  const threadJobs = useThreadShipJobs({
    environmentId,
    threadId,
    branch,
    worktreePath,
    gitCwd,
  });
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const cancelShipQueueJob = useAtomCommand(serverEnvironment.cancelShipQueueJob, {
    reportFailure: false,
  });

  const [dismissedKeys, setDismissedKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [selectedJobKey, setSelectedJobKey] = useState<string | null>(null);
  const [cancellingKey, setCancellingKey] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const minuteIso = useNowMinute();
  const parsedMinuteMs = Date.parse(minuteIso);
  const nowMs = Number.isFinite(parsedMinuteMs) ? parsedMinuteMs : 0;

  if (!snap.available || threadJobs.length === 0) {
    return null;
  }

  const { jobs: visibleJobs } = selectVisibleThreadShipJobs(threadJobs, nowMs, dismissedKeys);
  if (visibleJobs.length === 0) {
    return null;
  }

  const matchedIndex = selectedJobKey
    ? visibleJobs.findIndex((job) => shipJobKey(job) === selectedJobKey)
    : -1;
  const activeIndex = matchedIndex >= 0 ? matchedIndex : 0;
  const activeJob = visibleJobs[activeIndex];
  if (!activeJob) {
    return null;
  }

  const activeKey = shipJobKey(activeJob);
  const isLive = isShipQueueJobLive(activeJob);
  const displayState = resolveShipJobDisplayState(activeJob);
  const variant = shipQueueStatusVariant(displayState);
  const prUrl = buildSafePrUrl(activeJob);
  const depHold = findActionableDepHoldForJob(activeJob, snap.deps);
  const finishedElapsed = !isLive ? formatShipJobElapsed(activeJob, nowMs) : null;
  const isCancelling = cancellingKey === activeKey;

  const stepLabels = {
    queued: gt("Queued"),
    watcher: gt("Watcher"),
    ci: gt("CI"),
    push: gt("Push"),
    pr: gt("PR"),
    merge: gt("Merge"),
    land: gt("Deploy"),
  };
  const steps = deriveShipJobSteps(activeJob, stepLabels, resolve);
  const currentStep =
    steps.find((s) => s.state === "failed" || s.state === "active" || s.state === "waiting") ??
    steps[steps.length - 1];

  const handleOpenQueue = () => {
    void navigate({
      to: "/machines",
      search: { env: environmentId, tab: "ship-queue" },
    });
  };

  const handleCancel = async () => {
    if (!canOperate || !isLive || isCancelling) return;
    setCancellingKey(activeKey);
    setActionError(null);
    const result = await cancelShipQueueJob({
      environmentId,
      input: { jobId: activeJob.id },
    });
    setCancellingKey(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      setActionError(thrownErrorMessage(failure, resolve) ?? gt("Failed to cancel ship job."));
    } else if (result._tag === "Success" && !result.value.ok) {
      setActionError(result.value.error ?? gt("Failed to cancel ship job."));
    }
  };

  const handleDismiss = () => {
    setActionError(null);
    setDismissedKeys((prev) => addBoundedDismiss(new Set(prev), activeKey));
  };

  const handleStepJob = (delta: -1 | 1) => {
    const nextIndex = (activeIndex + delta + visibleJobs.length) % visibleJobs.length;
    const nextJob = visibleJobs[nextIndex];
    if (nextJob) setSelectedJobKey(shipJobKey(nextJob));
  };

  return (
    <ThreadDetailsSection
      headingId={headingId}
      title={gt("Ship Queue")}
      actions={
        <div className="flex items-center gap-0.5">
          {visibleJobs.length > 1 ? (
            <>
              <Button
                aria-label={gt("Previous ship job")}
                size="icon-micro"
                variant="ghost"
                onClick={() => handleStepJob(-1)}
              >
                <ChevronLeftIcon className="size-3" />
              </Button>
              <span className="px-1 text-2xs text-muted-foreground tabular-nums">
                {activeIndex + 1}/{visibleJobs.length}
              </span>
              <Button
                aria-label={gt("Next ship job")}
                size="icon-micro"
                variant="ghost"
                onClick={() => handleStepJob(1)}
              >
                <ChevronRightIcon className="size-3" />
              </Button>
            </>
          ) : null}
          <Button size="micro" variant="ghost" onClick={handleOpenQueue}>
            <T>Queue</T>
          </Button>
        </div>
      }
    >
      <div className="mx-1.5 flex flex-col gap-2 rounded-lg border border-border/70 bg-muted/25 px-2.5 py-2 text-xs">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <span
              aria-hidden
              className={cn("size-2 shrink-0 rounded-full", statusDotClass(variant))}
            />
            <span className="font-medium text-foreground">
              {displayStateLabel(displayState, gt)}
            </span>
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            {isLive ? (
              <LiveShipElapsed job={activeJob} />
            ) : finishedElapsed ? (
              <span className="text-2xs text-muted-foreground tabular-nums">{finishedElapsed}</span>
            ) : null}
            {isLive && canOperate ? (
              <InlineButton
                tone="muted"
                disabled={isCancelling}
                onClick={() => void handleCancel()}
              >
                {isCancelling ? <T>Cancelling…</T> : <T>Cancel</T>}
              </InlineButton>
            ) : !isLive ? (
              <Button
                aria-label={gt("Dismiss ship job")}
                size="icon-micro"
                variant="ghost"
                onClick={handleDismiss}
              >
                <XIcon className="size-3" />
              </Button>
            ) : null}
          </div>
        </div>

        <div
          aria-label={gt("Ship progress steps")}
          className="flex items-center gap-1"
          role="group"
        >
          {steps.map((step) => {
            const detailText = step.detail ?? stepStateLabel(step.state, resolve);
            return (
              <Tooltip key={step.id}>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label={`${step.label}: ${detailText}`}
                      className={cn(
                        "h-1.5 flex-1 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
                        segmentClass(step.state),
                      )}
                    />
                  }
                />
                <TooltipPopup side="top">
                  <div className="flex flex-col gap-0.5 text-xs">
                    <span className="font-medium">
                      {step.label}
                      {step.badge ? ` (${step.badge})` : ""}
                    </span>
                    <span className="text-muted-foreground">{detailText}</span>
                  </div>
                </TooltipPopup>
              </Tooltip>
            );
          })}
        </div>

        {(currentStep && currentStep.label !== displayStateLabel(displayState, gt)) ||
        activeJob.pr ||
        activeJob.routeHost ? (
          <div className="flex items-center justify-between gap-2 text-2xs text-muted-foreground">
            <div className="flex min-w-0 items-center gap-1.5">
              {currentStep && currentStep.label !== displayStateLabel(displayState, gt) ? (
                <span className="truncate">{currentStep.label}</span>
              ) : null}
              {activeJob.routeHost ? (
                <Badge size="sm" variant="secondary">
                  {activeJob.routeHost}
                </Badge>
              ) : null}
            </div>
            {activeJob.pr ? (
              prUrl ? (
                <a
                  href={prUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex shrink-0 items-center gap-0.5 font-mono text-2xs text-info-foreground hover:underline"
                >
                  #{activeJob.pr}
                  <ExternalLinkIcon aria-hidden className="size-2.5" />
                </a>
              ) : (
                <span className="shrink-0 font-mono text-2xs text-muted-foreground">
                  #{activeJob.pr}
                </span>
              )
            ) : null}
          </div>
        ) : null}

        {depHold ? (
          <div className="flex items-start gap-1.5 text-2xs text-warning-foreground">
            <ShieldQuestionIcon aria-hidden className="mt-0.5 size-3 shrink-0" />
            <span className="min-w-0 leading-snug">
              <T>
                Waiting on dependency approval (<Var>{depHold.repo}</Var>)
              </T>
            </span>
          </div>
        ) : currentStep?.state === "failed" && currentStep.detail ? (
          <p className="truncate text-2xs text-destructive">{currentStep.detail}</p>
        ) : null}

        {actionError ? (
          <p role="alert" className="text-2xs text-destructive">
            {actionError}
          </p>
        ) : null}
      </div>
    </ThreadDetailsSection>
  );
}
