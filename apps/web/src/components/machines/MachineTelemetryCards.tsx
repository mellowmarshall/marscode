import type { EnvironmentId } from "@t3tools/contracts";
import { T, useGT, Var } from "gt-react";
import { CpuIcon, GpuIcon, HardDriveIcon, MemoryStickIcon } from "lucide-react";

import { formatBytes } from "../../lib/formatBytes";
import { cn } from "../../lib/utils";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { Skeleton } from "../ui/skeleton";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  clampRatio,
  formatPercent,
  formatUptime,
  metricTone,
  shortMountLabel,
  type MetricTone,
} from "./machines.logic";

function ProgressBar({
  ratio,
  tone = "default",
}: {
  readonly ratio: number | null;
  readonly tone?: MetricTone;
}) {
  const clamped = clampRatio(ratio);
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <div
        className={cn(
          "h-full rounded-full transition-[width] duration-300 motion-reduce:transition-none",
          tone === "danger"
            ? "bg-destructive"
            : tone === "warning"
              ? "bg-warning"
              : "bg-foreground/70",
        )}
        style={{ width: `${Math.round((clamped ?? 0) * 100)}%` }}
      />
    </div>
  );
}

function toneTextClass(tone: MetricTone): string {
  if (tone === "danger") return "text-destructive";
  if (tone === "warning") return "text-warning-foreground";
  return "text-foreground";
}

export function MachineTelemetryCards({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const gt = useGT();
  const hardware = useEnvironmentQuery(
    serverEnvironment.hostHardware({ environmentId, input: {} }),
  );
  // Older servers may lack `server.getHostHardware`; fall back silently to `server.getHostResources`.
  const fallbackToBasic = hardware.error !== null && hardware.data === null;
  const resources = useEnvironmentQuery(
    fallbackToBasic ? serverEnvironment.hostResources({ environmentId, input: {} }) : null,
  );

  const hw = hardware.data;
  const basic = hw ?? resources.data;
  const isInitialLoading =
    basic === null && (hardware.isPending || (fallbackToBasic && resources.isPending));

  if (isInitialLoading) {
    return (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Skeleton shape="card" className="h-28" />
        <Skeleton shape="card" className="h-28" />
        <Skeleton shape="card" className="h-28" />
      </div>
    );
  }

  if (basic === null) {
    return null;
  }

  const cpuRatio = clampRatio(basic.cpuUtilization);
  const cpuTone = metricTone(cpuRatio);
  const memUsedBytes = Math.max(0, basic.totalMemoryBytes - basic.availableMemoryBytes);
  const memRatio =
    basic.totalMemoryBytes > 0 ? clampRatio(memUsedBytes / basic.totalMemoryBytes) : null;
  const memTone = metricTone(memRatio);
  const uptime = hw ? formatUptime(hw.uptimeSeconds) : null;
  const gpus = hw?.gpus ?? [];
  const disks = hw?.disks ?? [];

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <div className="flex min-w-0 flex-col justify-between gap-2.5 rounded-xl border border-border/70 bg-card p-4">
        <div className="flex items-center justify-between gap-2">
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <CpuIcon className="size-3.5 shrink-0" aria-hidden />
            <T>CPU</T>
          </span>
          <span className="text-xs text-muted-foreground tabular-nums">
            <T>
              <Var>{basic.cpuCount}</Var> cores
            </T>
          </span>
        </div>
        <div
          className={cn("font-mono text-2xl font-semibold tabular-nums", toneTextClass(cpuTone))}
        >
          {formatPercent(cpuRatio)}
        </div>
        <ProgressBar ratio={cpuRatio} tone={cpuTone} />
        <div className="flex flex-wrap items-center justify-between gap-2 text-2xs text-muted-foreground tabular-nums">
          <span>
            {hw?.loadAverage ? (
              <T>
                Load <Var>{hw.loadAverage[0].toFixed(2)}</Var> ·{" "}
                <Var>{hw.loadAverage[1].toFixed(2)}</Var> ·{" "}
                <Var>{hw.loadAverage[2].toFixed(2)}</Var>
              </T>
            ) : (
              gt("Host utilization")
            )}
          </span>
          {uptime ? (
            <span>
              <T>
                Up <Var>{uptime}</Var>
              </T>
            </span>
          ) : null}
        </div>
      </div>

      <div className="flex min-w-0 flex-col justify-between gap-2.5 rounded-xl border border-border/70 bg-card p-4">
        <div className="flex items-center justify-between gap-2">
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <MemoryStickIcon className="size-3.5 shrink-0" aria-hidden />
            <T>Memory</T>
          </span>
          <span className="text-xs text-muted-foreground tabular-nums">
            {formatBytes(memUsedBytes)} / {formatBytes(basic.totalMemoryBytes)}
          </span>
        </div>
        <div
          className={cn("font-mono text-2xl font-semibold tabular-nums", toneTextClass(memTone))}
        >
          {formatPercent(memRatio)}
        </div>
        <ProgressBar ratio={memRatio} tone={memTone} />
        <div className="text-2xs text-muted-foreground tabular-nums">
          <T>
            <Var>{formatBytes(basic.availableMemoryBytes)}</Var> available
          </T>
        </div>
      </div>

      {gpus.map((gpu) => {
        const vramRatio =
          gpu.memoryUsedBytes !== null && gpu.memoryTotalBytes !== null && gpu.memoryTotalBytes > 0
            ? clampRatio(gpu.memoryUsedBytes / gpu.memoryTotalBytes)
            : null;
        const primaryRatio = gpu.utilization ?? vramRatio;
        const gpuTone = metricTone(primaryRatio);
        return (
          <div
            key={gpu.index}
            className="flex min-w-0 flex-col justify-between gap-2.5 rounded-xl border border-border/70 bg-card p-4"
          >
            <div className="flex min-w-0 items-center justify-between gap-2">
              <span className="inline-flex shrink-0 items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <GpuIcon className="size-3.5 shrink-0" aria-hidden />
                {gpus.length > 1 ? gt("GPU {index}", { index: gpu.index }) : gt("GPU")}
              </span>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span className="min-w-0 truncate text-xs text-muted-foreground">
                      {gpu.name}
                    </span>
                  }
                />
                <TooltipPopup side="top">{gpu.name}</TooltipPopup>
              </Tooltip>
            </div>
            <div
              className={cn(
                "font-mono text-2xl font-semibold tabular-nums",
                toneTextClass(gpuTone),
              )}
            >
              {formatPercent(primaryRatio)}
            </div>
            <ProgressBar ratio={primaryRatio} tone={gpuTone} />
            <div className="flex items-center justify-between gap-2 text-2xs text-muted-foreground tabular-nums">
              <span className="truncate">
                {gpu.memoryUsedBytes !== null && gpu.memoryTotalBytes !== null
                  ? gt("{used} / {total} VRAM", {
                      used: formatBytes(gpu.memoryUsedBytes),
                      total: formatBytes(gpu.memoryTotalBytes),
                    })
                  : gpu.memoryTotalBytes !== null
                    ? gt("{total} VRAM", { total: formatBytes(gpu.memoryTotalBytes) })
                    : gt("GPU utilization")}
              </span>
              {gpu.temperatureC !== null ? <span>{Math.round(gpu.temperatureC)}°C</span> : null}
            </div>
          </div>
        );
      })}

      {disks.length > 0 ? (
        <div
          className={cn(
            "flex min-w-0 flex-col justify-between gap-2.5 rounded-xl border border-border/70 bg-card p-4",
            gpus.length === 0 && "sm:col-span-2",
          )}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <HardDriveIcon className="size-3.5 shrink-0" aria-hidden />
              <T>Storage</T>
            </span>
            <span className="text-xs text-muted-foreground tabular-nums">
              {gt("{count, plural, one {# volume} other {# volumes}}", { count: disks.length })}
            </span>
          </div>
          <div className="flex flex-col gap-2">
            {disks.map((disk) => {
              const diskRatio =
                disk.totalBytes > 0 ? clampRatio(disk.usedBytes / disk.totalBytes) : null;
              const diskTone = metricTone(diskRatio);
              return (
                <div key={disk.mount} className="flex flex-col gap-1">
                  <div className="flex items-center justify-between gap-2 text-xs tabular-nums">
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <span className="min-w-0 truncate font-mono text-foreground">
                            {shortMountLabel(disk.mount)}
                          </span>
                        }
                      />
                      <TooltipPopup side="top">{disk.mount}</TooltipPopup>
                    </Tooltip>
                    <span className={cn("shrink-0 font-mono", toneTextClass(diskTone))}>
                      {gt("{available} free", { available: formatBytes(disk.availableBytes) })} ·{" "}
                      {formatPercent(diskRatio)}
                    </span>
                  </div>
                  <ProgressBar ratio={diskRatio} tone={diskTone} />
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
