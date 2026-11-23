import { resolveEnvironmentMachineKind } from "@t3tools/contracts";
import { connectionStatusTitle } from "@t3tools/client-runtime/connection";
import { Link } from "@tanstack/react-router";
import { T, useGT, useMessages, Var } from "gt-react";

import { cn } from "../../lib/utils";
import type { EnvironmentPresentation } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useVisibleThreadShells } from "../../state/entities";
import {
  ConnectionStatusDot,
  connectionPhaseDotClassName,
  connectionPhasePingClassName,
} from "../ConnectionStatusDot";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { Badge } from "../ui/badge";
import { Skeleton } from "../ui/skeleton";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { countEnvironmentThreadStates, formatPercent, metricTone } from "./machines.logic";

function MetricValueText({
  label,
  value,
  tone = "default",
}: {
  readonly label: string;
  readonly value: string;
  readonly tone?: "default" | "warning" | "danger";
}) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-2 text-xs">
      <span className="truncate text-muted-foreground">{label}</span>
      <span
        className={cn(
          "font-mono font-medium tabular-nums",
          tone === "danger"
            ? "text-destructive"
            : tone === "warning"
              ? "text-warning-foreground"
              : "text-foreground",
        )}
      >
        {value}
      </span>
    </div>
  );
}

function MachineCard({
  environment,
  isPrimary,
  selected,
  totalThreads,
  activeThreads,
  attentionThreads,
  onSelect,
}: {
  readonly environment: EnvironmentPresentation;
  readonly isPrimary: boolean;
  readonly selected: boolean;
  readonly totalThreads: number;
  readonly activeThreads: number;
  readonly attentionThreads: number;
  readonly onSelect: () => void;
}) {
  const gt = useGT();
  const messages = useMessages();
  const connected = environment.connection.phase === "connected";
  const resources = useEnvironmentQuery(
    connected
      ? serverEnvironment.hostResources({ environmentId: environment.environmentId, input: {} })
      : null,
  );
  const machineKind = resolveEnvironmentMachineKind(environment.serverConfig);
  const data = resources.data;
  const memRatio =
    data && data.totalMemoryBytes > 0
      ? (data.totalMemoryBytes - data.availableMemoryBytes) / data.totalMemoryBytes
      : null;
  const statusTitle = connectionStatusTitle(environment.connection, messages);

  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        "flex min-w-0 cursor-pointer flex-col gap-3 rounded-xl border p-3.5 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        selected
          ? "border-foreground/35 bg-accent/40 shadow-xs"
          : "border-border/70 bg-card hover:border-border hover:bg-accent/20",
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <EnvironmentMachineIcon
          kind={machineKind}
          className="size-4 shrink-0 text-muted-foreground"
          aria-hidden
        />
        <Tooltip>
          <TooltipTrigger
            render={
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                {environment.label}
              </span>
            }
          />
          <TooltipPopup side="top">{environment.label}</TooltipPopup>
        </Tooltip>
        {isPrimary ? (
          <Badge size="sm" variant="secondary">
            <T>Primary</T>
          </Badge>
        ) : null}
        <ConnectionStatusDot
          dotClassName={connectionPhaseDotClassName(environment.connection.phase)}
          pingClassName={connectionPhasePingClassName(environment.connection.phase)}
        />
      </div>

      {!connected ? (
        <div className="flex min-h-8 items-center justify-between gap-2 text-xs text-muted-foreground">
          <span className="truncate">{statusTitle}</span>
          {totalThreads > 0 ? (
            <span className="shrink-0 tabular-nums">
              {gt("{count, plural, one {# thread} other {# threads}}", { count: totalThreads })}
            </span>
          ) : null}
        </div>
      ) : data === null && resources.isPending ? (
        <div className="flex flex-col gap-1.5 py-0.5">
          <Skeleton shape="block" className="h-3.5 w-full" />
          <Skeleton shape="block" className="h-3.5 w-3/4" />
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          <div className="grid grid-cols-2 gap-x-4 gap-y-1">
            <MetricValueText
              label={gt("CPU")}
              value={formatPercent(data?.cpuUtilization ?? null)}
              tone={metricTone(data?.cpuUtilization ?? null)}
            />
            <MetricValueText
              label={gt("Memory")}
              value={formatPercent(memRatio)}
              tone={metricTone(memRatio)}
            />
          </div>
          <div className="flex items-center justify-between gap-2 pt-0.5 text-2xs text-muted-foreground tabular-nums">
            <span className="shrink-0">
              {activeThreads > 0 ? (
                <T>
                  <Var>{activeThreads}</Var> working
                </T>
              ) : (
                gt("{count, plural, one {# thread} other {# threads}}", { count: totalThreads })
              )}
            </span>
            {attentionThreads > 0 ? (
              <Badge size="sm" variant="warning">
                {gt("{count} needs attention", { count: attentionThreads })}
              </Badge>
            ) : environment.displayUrl ? (
              <span className="min-w-0 truncate font-mono">{environment.displayUrl}</span>
            ) : null}
          </div>
        </div>
      )}
    </button>
  );
}

export function MachineCardStrip({
  environments,
  primaryEnvironmentId,
  selectedEnvironmentId,
  onSelect,
}: {
  readonly environments: ReadonlyArray<EnvironmentPresentation>;
  readonly primaryEnvironmentId: EnvironmentPresentation["environmentId"] | null;
  readonly selectedEnvironmentId: EnvironmentPresentation["environmentId"] | null;
  readonly onSelect: (environmentId: EnvironmentPresentation["environmentId"]) => void;
}) {
  const gt = useGT();
  const threads = useVisibleThreadShells();

  if (environments.length === 0) return null;

  return (
    <section aria-label={gt("Machines")} className="flex flex-col gap-2">
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {environments.map((environment) => {
          const counts = countEnvironmentThreadStates(threads, environment.environmentId);
          return (
            <MachineCard
              key={environment.environmentId}
              environment={environment}
              isPrimary={environment.environmentId === primaryEnvironmentId}
              selected={environment.environmentId === selectedEnvironmentId}
              totalThreads={counts.total}
              activeThreads={counts.active}
              attentionThreads={counts.attention}
              onSelect={() => onSelect(environment.environmentId)}
            />
          );
        })}
      </div>
      {environments.length === 1 ? (
        <p className="text-xs text-muted-foreground">
          <T>
            Add remote servers, Tailscale hosts, or T3 Connect machines in{" "}
            <Link
              to="/settings/connections"
              className="underline underline-offset-4 hover:text-foreground"
            >
              Settings → Connections
            </Link>
            .
          </T>
        </p>
      ) : null}
    </section>
  );
}
