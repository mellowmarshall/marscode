/** Status, offline telemetry, host problem, and storage report banners for Fleet Console. */
import { useState } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import { T, Var, useGT } from "gt-react";
import {
  AlertTriangleIcon,
  CpuIcon,
  Maximize2Icon,
  PlayIcon,
  RefreshCwIcon,
  WrenchIcon,
  XIcon,
} from "lucide-react";

import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import type { MergedFleetHost } from "./devdeckTypes";
import { fetchDevtoolsJson } from "./devtoolsClient";
import { DevtoolsStateBanner } from "./DevtoolsStateBanner";
import type { DevtoolsResourceStatus } from "./devtoolsState";
import type { ConsoleActionFeedback } from "./devtoolsStore";
import { refreshSharedDevdeck } from "./devtoolsStreams";
import {
  formatJobBytes,
  formatJobElapsed,
  isJobLive,
  jobKindLabel,
  jobStateBadgeVariant,
  type JobSummary,
} from "./jobs/jobTypes";

export interface FleetStorageBannerData {
  readonly hostName: string;
  readonly sourceLabel: string;
  readonly mounts: ReadonlyArray<{
    readonly mount: string;
    readonly usedPct: number;
    readonly availBytes?: number;
  }>;
}

export function FleetOfflineBanner({
  environmentId,
  devdeckStatus,
  devdeckError,
  canStartDevdeck,
  onFeedback,
}: {
  readonly environmentId: EnvironmentId;
  readonly devdeckStatus?: Exclude<DevtoolsResourceStatus, "ready"> | undefined;
  readonly devdeckError: string | null;
  readonly canStartDevdeck: boolean;
  readonly onFeedback: (fb: ConsoleActionFeedback) => void;
}) {
  const gt = useGT();
  const [starting, setStarting] = useState(false);

  const handleStartDevdeck = async () => {
    setStarting(true);
    onFeedback({ tone: "busy", text: gt("Starting DevDeck daemon…") });
    const res = await fetchDevtoolsJson<{ readonly ok?: boolean; readonly error?: string }>(
      environmentId,
      "/devdeck/start",
      { method: "POST", body: {} },
    );
    setStarting(false);
    if (res.ok && res.data?.ok) {
      await refreshSharedDevdeck(environmentId);
      onFeedback({ tone: "ok", text: gt("DevDeck daemon started") });
    } else {
      onFeedback({
        tone: "error",
        text: res.data?.error ?? res.error ?? gt("Failed to start DevDeck daemon"),
      });
    }
  };

  const handleRetry = async () => {
    setStarting(true);
    await refreshSharedDevdeck(environmentId);
    setStarting(false);
  };

  const resolvedStatus: Exclude<DevtoolsResourceStatus, "ready"> =
    devdeckStatus ?? (devdeckError ? "offline" : "connecting");

  return (
    <DevtoolsStateBanner
      testId="fleet-telemetry-offline"
      status={resolvedStatus}
      title={devdeckError ? devdeckError : <T>Waiting for fleet host telemetry…</T>}
      detail={
        devdeckError && canStartDevdeck ? (
          <T>
            The configured legacy DevDeck override is offline. Start devdeck.service or clear the
            override in DevTools Settings to use T3 native fleet telemetry.
          </T>
        ) : undefined
      }
      primaryAction={
        devdeckError && canStartDevdeck ? (
          <Button size="xs" disabled={starting} onClick={() => void handleStartDevdeck()}>
            <PlayIcon className="mr-1 size-3" />
            {starting ? <T>Starting…</T> : <T>Start DevDeck</T>}
          </Button>
        ) : undefined
      }
      onRetry={() => void handleRetry()}
      retrying={starting}
    />
  );
}

export function FleetOfflineJobsFallback({
  hostJobs,
  nowMs,
  onInspectJob,
}: {
  readonly hostJobs: ReadonlyArray<JobSummary>;
  readonly nowMs: number;
  readonly onInspectJob: (jobId: string) => void;
}) {
  const gt = useGT();
  const sortedJobs = hostJobs
    .toSorted((a, b) => {
      const la = isJobLive(a) ? 0 : 1;
      const lb = isJobLive(b) ? 0 : 1;
      if (la !== lb) return la - lb;
      return Date.parse(b.timing.startedAt) - Date.parse(a.timing.startedAt);
    })
    .slice(0, 12);

  if (sortedJobs.length === 0) return null;

  return (
    <section className="overflow-hidden rounded-lg border border-border/70 bg-card/40">
      <div className="flex items-center justify-between gap-2 border-b border-border/60 bg-muted/20 px-3 py-2 text-xs font-semibold text-foreground">
        <div className="flex items-center gap-2">
          <CpuIcon className="size-3.5 text-muted-foreground" />
          <T>Tracked Background Jobs</T>
          <Badge size="sm" variant="secondary">
            <Var>{sortedJobs.filter(isJobLive).length}</Var>
          </Badge>
        </div>
      </div>
      <div className="divide-y divide-border/50">
        {sortedJobs.map((job) => {
          const elapsed = formatJobElapsed(job.timing, nowMs);
          return (
            <div key={job.id} className="flex items-center justify-between gap-2 px-3 py-2 text-xs">
              <div className="min-w-0 flex-1 space-y-0.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge size="sm" variant="outline">
                    {jobKindLabel(job.kind)}
                  </Badge>
                  <Badge size="sm" variant={jobStateBadgeVariant(job.state)}>
                    {job.phaseLabel}
                  </Badge>
                  <Badge size="sm" variant="secondary">
                    {job.binding.host.replace(/^dev-/, "")}
                  </Badge>
                  <span className="truncate font-medium text-foreground">{job.title}</span>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {elapsed ? (
                  <span className="font-mono text-3xs text-muted-foreground tabular-nums">
                    {elapsed}
                  </span>
                ) : null}
                <Button
                  size="xs"
                  variant="ghost"
                  aria-label={gt("Inspect job")}
                  onClick={() => onInspectJob(job.id)}
                >
                  <Maximize2Icon className="size-3" />
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function FleetHostProblemBanner({
  host,
  busyKeys,
  onProvisionHost,
  onCheckHosts,
}: {
  readonly host: MergedFleetHost;
  readonly busyKeys: ReadonlySet<string>;
  readonly onProvisionHost: (host: MergedFleetHost) => void;
  readonly onCheckHosts: () => void;
}) {
  if (!host.problem) return null;
  const isBad = host.problem.tone === "bad";
  return (
    <div
      data-testid="host-problem-banner"
      className={
        isBad
          ? "mb-4 flex flex-wrap items-start justify-between gap-3 rounded-lg border border-destructive/45 bg-destructive/10 p-3 text-xs"
          : "mb-4 flex flex-wrap items-start justify-between gap-3 rounded-lg border border-warning/45 bg-warning/10 p-3 text-xs"
      }
    >
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-center gap-2">
          <AlertTriangleIcon
            className={isBad ? "size-4 shrink-0 text-destructive" : "size-4 shrink-0 text-warning"}
          />
          <Badge size="sm" variant={isBad ? "destructive" : "warning"}>
            {host.problem.label}
          </Badge>
          <span className="font-semibold text-foreground">{host.shortName}</span>
        </div>
        <ul className="space-y-0.5 pl-6 font-mono text-2xs text-foreground/90">
          {host.problem.details.map((detail) => (
            <li key={detail}>{detail}</li>
          ))}
        </ul>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {host.probeHostName && host.problem.kind !== "offline" ? (
          <Button
            size="xs"
            variant="outline"
            disabled={busyKeys.has(`provision:${host.probeHostName}`)}
            onClick={() => onProvisionHost(host)}
          >
            <WrenchIcon className="mr-1 size-3" />
            <T>Provision host</T>
          </Button>
        ) : null}
        <Button
          size="xs"
          variant="outline"
          disabled={busyKeys.has("hosts-check")}
          onClick={onCheckHosts}
        >
          <RefreshCwIcon className="mr-1 size-3" />
          <T>Check hosts</T>
        </Button>
      </div>
    </div>
  );
}

export function FleetStorageReportBanner({
  report,
  onClose,
}: {
  readonly report: FleetStorageBannerData;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  return (
    <div className="mb-4 space-y-2 rounded-lg border border-border bg-card/60 p-3 text-xs">
      <div className="flex items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold text-foreground">
            <T>
              Storage report: <Var>{report.hostName}</Var>
            </T>
          </span>
          <span className="text-3xs text-muted-foreground">{report.sourceLabel}</span>
        </div>
        <Button size="xs" variant="ghost" aria-label={gt("Close storage report")} onClick={onClose}>
          <XIcon className="size-3.5" />
        </Button>
      </div>
      <div className="flex flex-wrap gap-3 font-mono text-2xs tabular-nums">
        {report.mounts.map((m) => (
          <span
            key={m.mount}
            className="rounded border border-border/60 bg-background/60 px-2 py-1"
          >
            {gt("{mount}: {pct}% ({free} free)", {
              mount: m.mount,
              pct: m.usedPct.toFixed(1),
              free: formatJobBytes(m.availBytes),
            })}
          </span>
        ))}
      </div>
    </div>
  );
}
