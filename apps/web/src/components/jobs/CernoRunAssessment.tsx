import type { CernoLiveRun } from "@t3tools/contracts";
import { T, useGT, Var } from "gt-react";
import { ChevronRightIcon } from "lucide-react";

import { formatBytes } from "../../lib/formatBytes";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { presentCernoRun, type CernoOperatorTone } from "./cernoRunPresentation";

export function cernoToneDotClass(tone: CernoOperatorTone): string {
  switch (tone) {
    case "destructive":
      return "bg-destructive";
    case "warning":
      return "bg-warning";
    case "success":
      return "bg-success";
    case "neutral":
      return "bg-muted-foreground";
    default:
      return "bg-info";
  }
}

export function cernoToneTextClass(tone: CernoOperatorTone): string {
  switch (tone) {
    case "destructive":
      return "text-destructive-foreground";
    case "warning":
      return "text-warning-foreground";
    case "success":
      return "text-success-foreground";
    case "neutral":
      return "text-muted-foreground";
    default:
      return "text-info-foreground";
  }
}

export function CernoCertaintyPips({
  pips,
  tone,
}: {
  readonly pips: 1 | 2 | 3 | 4;
  readonly tone: CernoOperatorTone;
}) {
  const activeClass = cernoToneDotClass(tone);
  return (
    <span aria-hidden className="inline-flex h-2.5 shrink-0 items-end gap-0.5">
      <span
        className={cn("h-1 w-0.5 rounded-xs", pips >= 1 ? activeClass : "bg-muted-foreground/25")}
      />
      <span
        className={cn("h-1.5 w-0.5 rounded-xs", pips >= 2 ? activeClass : "bg-muted-foreground/25")}
      />
      <span
        className={cn("h-2 w-0.5 rounded-xs", pips >= 3 ? activeClass : "bg-muted-foreground/25")}
      />
      <span
        className={cn("h-2.5 w-0.5 rounded-xs", pips >= 4 ? activeClass : "bg-muted-foreground/25")}
      />
    </span>
  );
}

export function CernoRunAssessment({ run }: { readonly run: CernoLiveRun }) {
  const gt = useGT();
  const view = presentCernoRun(run);
  const badgeVariant =
    view.tone === "destructive" ? "error" : view.tone === "neutral" ? "secondary" : view.tone;
  const logLines = run.logTail
    ? run.logTail
        .split(/\r?\n/u)
        .filter((line) => line.length > 0)
        .slice(-6)
    : [];
  const totalBytes = run.bytesStdout + run.bytesStderr;

  return (
    <div className="space-y-2.5">
      <div
        className={cn(
          "space-y-1.5 rounded-md border px-3 py-2.5 text-xs",
          view.tone === "destructive"
            ? "border-destructive/40 bg-destructive/10"
            : view.tone === "warning"
              ? "border-warning/40 bg-warning/10"
              : "border-border/70 bg-muted/20",
        )}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge size="sm" variant={badgeVariant}>
              {view.verdict}
            </Badge>
            <CernoCertaintyPips pips={view.pips} tone={view.tone} />
            <span className="font-mono text-2xs text-muted-foreground tabular-nums">
              {gt("{level} certainty ({percent}%)", {
                level: view.certaintyLabel,
                percent: view.confidencePct,
              })}
            </span>
          </div>
          <span className="font-mono text-2xs text-muted-foreground tabular-nums">
            {gt("Last activity: {liveness}", { liveness: view.liveness })}
          </span>
        </div>
        <p className="text-xs text-foreground">{view.reason}</p>
        <p className="text-2xs text-muted-foreground">{view.actionNote}</p>
      </div>

      {logLines.length > 0 ? (
        <div className="space-y-1">
          <div className="flex items-center justify-between gap-2 font-mono text-2xs text-muted-foreground">
            <span>
              <T>Latest log output</T>
            </span>
            {run.logPath ? <span className="truncate">{run.logPath}</span> : null}
          </div>
          <pre className="max-h-36 overflow-x-auto rounded-md border border-border/70 bg-muted/30 px-2.5 py-2 font-mono text-2xs text-muted-foreground">
            {logLines.join("\n")}
          </pre>
        </div>
      ) : null}

      <Collapsible>
        <CollapsibleTrigger className="group flex w-full items-center gap-1.5 rounded-md border border-border/60 px-2.5 py-1.5 text-left text-2xs font-medium text-muted-foreground hover:text-foreground">
          <ChevronRightIcon
            aria-hidden
            className="size-3.5 shrink-0 transition-transform group-data-panel-open:rotate-90"
          />
          <span>
            <T>Model internals (SSM heads, cutoffs, kernel wait)</T>
          </span>
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 rounded-md border border-border/60 bg-muted/15 px-3 py-2 font-mono text-2xs text-muted-foreground tabular-nums">
            <span>
              <T>
                state: <Var>{run.state}</Var> (<Var>{Math.round(run.confidence * 100)}</Var>%,{" "}
                <Var>{run.margin >= 0 ? `+${run.margin.toFixed(1)}` : run.margin.toFixed(1)}</Var>)
              </T>
            </span>
            <span>
              <T>
                fail gate: <Var>{Math.round(run.pFail * 100)}</Var>% (warn{" "}
                <Var>{Math.round(run.cutoffs.suspThresh * 100)}</Var>%, wake{" "}
                <Var>{Math.round(run.cutoffs.confThresh * 100)}</Var>%)
              </T>
            </span>
            {run.wchan ? (
              <span>
                <T>
                  wchan: <Var>{run.wchan}</Var>
                </T>
              </span>
            ) : null}
            <span>
              <T>
                output: <Var>{formatBytes(totalBytes)}</Var>
              </T>
            </span>
            {run.hasRemoteSocket ? (
              <span>
                <T>remote socket</T>
              </span>
            ) : null}
            {run.hasExtFileLock ? (
              <span>
                <T>external flock</T>
              </span>
            ) : null}
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </div>
  );
}
