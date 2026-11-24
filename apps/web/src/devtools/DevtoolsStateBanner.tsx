/**
 * Shared explicit state banner for DevTools views (`connecting`, `offline`, `degraded`,
 * `unconfigured`, `error`) with consistent tone and actionable recovery buttons.
 */
import type { ReactNode } from "react";
import { T } from "gt-react";
import { AlertTriangleIcon, InfoIcon, Loader2Icon, RefreshCwIcon, WifiOffIcon } from "lucide-react";

import { Button } from "../components/ui/button";
import type { DevtoolsResourceStatus } from "./devtoolsState";

export function DevtoolsStateBanner({
  status,
  title,
  detail,
  primaryAction,
  onRetry,
  retrying = false,
  compact = false,
  testId,
}: {
  readonly status: Exclude<DevtoolsResourceStatus, "ready">;
  readonly title: ReactNode;
  readonly detail?: ReactNode | undefined;
  readonly primaryAction?: ReactNode | undefined;
  readonly onRetry?: (() => void) | undefined;
  readonly retrying?: boolean | undefined;
  readonly compact?: boolean | undefined;
  readonly testId?: string | undefined;
}) {
  const toneClass =
    status === "error"
      ? "border-destructive/40 bg-destructive/5"
      : status === "offline" || status === "degraded"
        ? "border-warning/40 bg-warning/5"
        : "border-border/70 bg-muted/20";

  const icon =
    status === "connecting" ? (
      <Loader2Icon className="mt-0.5 size-3.5 shrink-0 animate-spin text-muted-foreground" />
    ) : status === "offline" ? (
      <WifiOffIcon className="mt-0.5 size-4 shrink-0 text-warning" />
    ) : status === "degraded" ? (
      <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-warning" />
    ) : status === "error" ? (
      <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
    ) : (
      <InfoIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
    );

  return (
    <div
      data-testid={testId}
      data-devtools-state={status}
      className={
        compact
          ? `flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-xs ${toneClass}`
          : `flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-3 text-xs ${toneClass}`
      }
    >
      <div className="flex min-w-0 items-start gap-2.5">
        {icon}
        <div className="min-w-0 space-y-0.5">
          <div className="font-medium text-foreground">{title}</div>
          {detail ? <div className="text-3xs text-muted-foreground">{detail}</div> : null}
        </div>
      </div>

      {primaryAction || onRetry ? (
        <div className="flex shrink-0 items-center gap-1.5">
          {primaryAction}
          {onRetry ? (
            <Button size="xs" variant="outline" disabled={retrying} onClick={onRetry}>
              <RefreshCwIcon className={retrying ? "mr-1 size-3 animate-spin" : "mr-1 size-3"} />
              <T>Retry</T>
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
