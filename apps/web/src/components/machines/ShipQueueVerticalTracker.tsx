import type { ShipQueueJob } from "@t3tools/contracts";
import { useGT, useMessages } from "gt-react";
import {
  CheckCircle2Icon,
  CircleDotIcon,
  CircleIcon,
  ClockIcon,
  ExternalLinkIcon,
  XCircleIcon,
} from "lucide-react";

import { deriveShipJobSteps, type ShipStepState } from "../../lib/shipQueueSteps";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";

function StepIcon({ state }: { readonly state: ShipStepState }) {
  if (state === "done") {
    return <CheckCircle2Icon aria-hidden className="size-4 shrink-0 text-success-foreground" />;
  }
  if (state === "active") {
    return <CircleDotIcon aria-hidden className="size-4 shrink-0 text-info-foreground" />;
  }
  if (state === "waiting") {
    return <ClockIcon aria-hidden className="size-4 shrink-0 text-warning-foreground" />;
  }
  if (state === "failed") {
    return <XCircleIcon aria-hidden className="size-4 shrink-0 text-destructive-foreground" />;
  }
  return <CircleIcon aria-hidden className="size-4 shrink-0 text-muted-foreground/50" />;
}

export function ShipQueueVerticalTracker({ job }: { readonly job: ShipQueueJob }) {
  const gt = useGT();
  const resolve = useMessages();
  const steps = deriveShipJobSteps(
    job,
    {
      queued: gt("Queued"),
      watcher: gt("Watcher"),
      ci: gt("CI"),
      push: gt("Push"),
      pr: gt("Pull Request"),
      merge: gt("Merge Gate"),
      land: gt("Deploy"),
    },
    resolve,
  );

  return (
    <ol className="m-0 flex flex-col gap-0 p-0">
      {steps.map((step, index) => {
        const isLast = index === steps.length - 1;
        return (
          <li key={step.id} className="relative flex min-w-0 gap-3 pb-3 last:pb-0">
            <div className="flex flex-col items-center">
              <StepIcon state={step.state} />
              {!isLast ? (
                <span
                  aria-hidden
                  className={cn(
                    "mt-1 w-px flex-1",
                    step.state === "done" ? "bg-success/50" : "bg-border/70",
                  )}
                />
              ) : null}
            </div>

            <div className="flex min-w-0 flex-1 flex-col gap-0.5 pt-0.5">
              <div className="flex flex-wrap items-center gap-1.5">
                <span
                  className={cn(
                    "text-xs font-medium",
                    step.state === "failed"
                      ? "text-destructive-foreground"
                      : step.state === "pending"
                        ? "text-muted-foreground"
                        : "text-foreground",
                  )}
                >
                  {step.label}
                </span>

                {step.badge ? (
                  step.href ? (
                    <a
                      href={step.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-0.5 rounded bg-secondary px-1.5 py-0.5 font-mono text-2xs text-info-foreground hover:underline"
                    >
                      {step.badge}
                      <ExternalLinkIcon aria-hidden className="size-2.5" />
                    </a>
                  ) : (
                    <Badge size="sm" variant="secondary">
                      {step.badge}
                    </Badge>
                  )
                ) : null}
              </div>

              {step.detail ? (
                <p
                  className={cn(
                    "text-xs break-words",
                    step.state === "failed"
                      ? "text-destructive-foreground"
                      : "text-muted-foreground",
                  )}
                >
                  {step.detail}
                </p>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
