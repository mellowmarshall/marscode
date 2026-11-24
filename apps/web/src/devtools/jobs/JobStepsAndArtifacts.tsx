/** Steps checklist and artifact chips rendered inside the Job Inspector drawer. */
import { T, useGT } from "gt-react";
import {
  CheckCircle2Icon,
  CircleIcon,
  ExternalLinkIcon,
  Loader2Icon,
  XCircleIcon,
} from "lucide-react";

import { Badge } from "../../components/ui/badge";
import { sanitizeJobHref, type JobArtifact, type JobStep } from "./jobTypes";

export function JobStepsSection({ steps }: { readonly steps: ReadonlyArray<JobStep> }) {
  const gt = useGT();
  if (steps.length === 0) return null;
  return (
    <div className="space-y-1.5 rounded-md border bg-muted/15 p-3">
      <div className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
        <T>Steps</T>
      </div>
      <div className="space-y-1.5">
        {steps.map((step) => {
          const safeHref = sanitizeJobHref(step.href);
          return (
            <div key={step.id} className="flex items-center justify-between gap-2 text-xs">
              <div className="flex min-w-0 items-center gap-2">
                {step.state === "done" ? (
                  <CheckCircle2Icon className="size-3.5 shrink-0 text-success" />
                ) : step.state === "failed" ? (
                  <XCircleIcon className="size-3.5 shrink-0 text-destructive" />
                ) : step.state === "active" ? (
                  <Loader2Icon className="size-3.5 shrink-0 animate-spin text-info-foreground" />
                ) : (
                  <CircleIcon className="size-3.5 shrink-0 text-muted-foreground" />
                )}
                <span className="truncate font-medium">{step.label}</span>
                {step.detail ? (
                  <span className="truncate text-2xs text-muted-foreground">{step.detail}</span>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {step.badge ? (
                  <Badge size="sm" variant="outline">
                    {step.badge}
                  </Badge>
                ) : null}
                {safeHref ? (
                  <a
                    href={safeHref}
                    target="_blank"
                    rel="noreferrer"
                    className="text-info-foreground hover:underline"
                    aria-label={gt("Open link for {label}", { label: step.label })}
                  >
                    <ExternalLinkIcon className="size-3" />
                  </a>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function JobArtifactsSection({
  artifacts,
}: {
  readonly artifacts: ReadonlyArray<JobArtifact>;
}) {
  if (artifacts.length === 0) return null;
  return (
    <div className="space-y-1.5 rounded-md border bg-muted/15 p-3">
      <div className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
        <T>Artifacts</T>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {artifacts.map((art) => {
          const href = sanitizeJobHref(art.href);
          if (href) {
            return (
              <a
                key={`${art.label}:${href}`}
                href={href}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 rounded border bg-background px-2 py-1 text-2xs text-info-foreground hover:underline"
              >
                <span>{art.label}</span>
                <ExternalLinkIcon className="size-3" />
              </a>
            );
          }
          return (
            <span
              key={`${art.label}:${art.path ?? ""}`}
              className="inline-flex items-center gap-1 rounded border bg-background px-2 py-1 font-mono text-3xs text-muted-foreground"
            >
              <span className="text-foreground">{art.label}</span>
              {art.path ? <span>{art.path}</span> : null}
            </span>
          );
        })}
      </div>
    </div>
  );
}
