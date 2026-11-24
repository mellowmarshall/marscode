/**
 * Vertical pipeline step renderer for expanded Ship Queue rows (`ShipQueueTableRow.tsx`).
 */
import { useGT } from "gt-react";
import {
  CheckCircle2Icon,
  CircleDashedIcon,
  CircleDotIcon,
  ClockIcon,
  ExternalLinkIcon,
  XCircleIcon,
} from "lucide-react";

import type { ShipQueueJob } from "./devtoolsClient";
import { deriveShipJobSteps, type StepState } from "./ShipQueueSteps";
import { TruncatedText } from "./TruncatedText";

function StepIcon({ state }: { readonly state: StepState }) {
  if (state === "done") return <CheckCircle2Icon className="size-3.5 shrink-0 text-success" />;
  if (state === "failed") return <XCircleIcon className="size-3.5 shrink-0 text-destructive" />;
  if (state === "waiting") return <ClockIcon className="size-3.5 shrink-0 text-warning" />;
  if (state === "active")
    return <CircleDotIcon className="size-3.5 shrink-0 animate-pulse text-info-foreground" />;
  return <CircleDashedIcon className="size-3.5 shrink-0 text-muted-foreground/50" />;
}

export function ShipQueueVerticalTracker({
  job,
  compact = false,
}: {
  readonly job: ShipQueueJob;
  readonly compact?: boolean;
}) {
  const gt = useGT();
  const steps = deriveShipJobSteps(job, {
    queued: gt("Queued"),
    watcher: gt("Watcher"),
    ci: compact ? gt("CI") : gt("CI & Checks"),
    push: gt("Push"),
    pr: compact ? gt("PR") : gt("Pull Request"),
    merge: compact ? gt("Merge") : gt("Merge Gate"),
    land: gt("Deploy"),
  });

  return (
    <ol>
      {steps.map((step, index) => {
        const isLast = index === steps.length - 1;
        const muted = step.state === "pending";
        return (
          <li key={step.id} className="flex items-stretch gap-2">
            <div className="flex flex-col items-center pt-0.5">
              <StepIcon state={step.state} />
              {!isLast ? (
                <span
                  aria-hidden
                  className={
                    step.state === "done"
                      ? "my-0.5 min-h-2 w-px flex-1 bg-success/50"
                      : "my-0.5 min-h-2 w-px flex-1 bg-border"
                  }
                />
              ) : null}
            </div>
            <div
              className={
                isLast
                  ? "min-w-0 flex-1"
                  : compact
                    ? "min-w-0 flex-1 pb-2"
                    : "min-w-0 flex-1 pb-2.5"
              }
            >
              <div className="flex items-center justify-between gap-1.5">
                <span
                  className={
                    muted
                      ? "shrink-0 whitespace-nowrap text-2xs text-muted-foreground/60"
                      : step.state === "failed"
                        ? "shrink-0 whitespace-nowrap text-2xs font-medium text-destructive"
                        : step.state === "active" || step.state === "waiting"
                          ? "shrink-0 whitespace-nowrap text-2xs font-medium text-foreground"
                          : "shrink-0 whitespace-nowrap text-2xs text-foreground/85"
                  }
                >
                  {step.label}
                </span>
                {step.badge ? (
                  step.href ? (
                    <a
                      href={step.href}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex shrink-0 items-center gap-0.5 whitespace-nowrap font-mono text-3xs text-info-foreground hover:underline"
                    >
                      <span>{step.badge}</span>
                      <ExternalLinkIcon className="size-2.5" />
                    </a>
                  ) : (
                    <TruncatedText
                      as="span"
                      text={step.badge}
                      variant="code"
                      className="min-w-0 truncate whitespace-nowrap rounded border bg-muted/30 px-1.5 py-px font-mono text-3xs leading-tight text-muted-foreground"
                    />
                  )
                ) : null}
              </div>
              {step.detail ? (
                <TruncatedText
                  text={step.detail}
                  variant="code"
                  className="mt-0.5 truncate font-mono text-3xs text-muted-foreground"
                />
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
