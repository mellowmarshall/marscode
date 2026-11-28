/**
 * Host load table inside Fleet Console -> Machines: live jobs and hot processes, heaviest first,
 * with CPU and memory as a share of the host so an overloading job can be stopped by hand.
 * Finished jobs stay hidden until asked for. Drops passive Observed stubs and Ship Queue jobs.
 */
import { useState } from "react";
import { T, Var, useGT } from "gt-react";
import { ActivityIcon, FlameIcon, Maximize2Icon, SquareIcon } from "lucide-react";

import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import type { MergedFleetHost } from "./devdeckTypes";
import type { DevdeckSessionItem } from "./devtoolsClient";
import { fleetHostTokens, normalizeFleetHostToken } from "./fleetHostEnvironment";
import { FleetPanel } from "./FleetPanel";
import { formatJobBytes, isHostJob, isJobLive, type JobSummary } from "./jobs/jobTypes";

// Below a 32rem panel the time column and load bars drop so the name keeps room.
const COLS =
  "grid-cols-[minmax(6rem,1fr)_3.5rem_4.5rem_3.75rem] @lg:grid-cols-[minmax(0,1fr)_6rem_7rem_4rem_3.75rem]";
const WIDE = "hidden @lg:block";
const ROW = `grid ${COLS} items-center gap-x-3 px-3 py-2`;

function compactAge(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return "-";
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return mins % 60 > 0 ? `${hrs}h ${mins % 60}m` : `${hrs}h`;
  return `${Math.floor(hrs / 24)}d ${hrs % 24}h`;
}

function jobAgeSeconds(job: JobSummary, nowMs: number): number | undefined {
  const start = Date.parse(job.timing.startedAt);
  const end = job.timing.endedAt ? Date.parse(job.timing.endedAt) : nowMs;
  return Number.isFinite(start) && Number.isFinite(end) ? (end - start) / 1000 : undefined;
}

function jobMatchesFleetHost(job: JobSummary, host: MergedFleetHost): boolean {
  const jh = normalizeFleetHostToken(job.binding.host);
  if (!jh) return host.isLocal;
  return fleetHostTokens(host).has(jh);
}

function isWatchdogTree(s: DevdeckSessionItem): boolean {
  return s.managed === "Watchdog";
}

function isActionableFleetSession(s: DevdeckSessionItem): boolean {
  if (isWatchdogTree(s)) return true;
  if (s.runaway || s.orphaned || s.close_allowed) return true;
  // Drop passive non-closable "Observed" background daemon stubs.
  if ((s.managed ?? "").toLowerCase() === "observed") return false;
  if ((s.kind ?? "").toLowerCase() === "observed") return false;
  return Boolean(
    s.id && (s.endpoint || (s.cpu_pct ?? 0) >= 15 || (s.mem_bytes ?? 0) >= 256 * 1024 ** 2),
  );
}

function jobRank(job: JobSummary): number {
  if (job.state === "running" || job.state === "cancelling") return 0;
  return isJobLive(job) ? 1 : 2;
}

function byLoad(a: JobSummary, b: JobSummary): number {
  const ra = jobRank(a);
  const rb = jobRank(b);
  if (ra !== rb) return ra - rb;
  const ca = a.load?.cpuPct ?? -1;
  const cb = b.load?.cpuPct ?? -1;
  if (ca !== cb) return cb - ca;
  return Date.parse(b.timing.startedAt) - Date.parse(a.timing.startedAt);
}

function stateDotClass(job: JobSummary): string {
  if (job.state === "running") return "bg-info";
  if (job.state === "cancelling" || job.state === "failed") return "bg-destructive";
  if (job.state === "queued" || job.state === "waiting") return "bg-warning";
  return "bg-muted-foreground/40";
}

export function FleetJobsAndProcsPanel({
  host,
  hostJobs: allHostJobs,
  selectedJobId = null,
  nowMs,
  busyKeys,
  onInspectJob,
  onCancelJob,
  onCloseSession,
}: {
  readonly host: MergedFleetHost;
  readonly hostJobs: ReadonlyArray<JobSummary>;
  readonly selectedJobId?: string | null | undefined;
  readonly nowMs: number;
  readonly busyKeys: ReadonlySet<string>;
  readonly onInspectJob: (jobId: string) => void;
  readonly onCancelJob: (jobId: string) => void;
  readonly onCloseSession: (session: DevdeckSessionItem) => void;
}) {
  const gt = useGT();
  const [confirmKillId, setConfirmKillId] = useState<string | null>(null);
  const [showFinished, setShowFinished] = useState(false);

  const cpus = host.telemetry?.cpus ?? 0;
  const memTotal = host.telemetry?.mem?.total ?? 0;
  const cpuShare = (pct: number | undefined) =>
    typeof pct === "number" && cpus > 0 ? pct / (cpus * 100) : null;
  const memShare = (bytes: number | undefined) =>
    typeof bytes === "number" && memTotal > 0 ? bytes / memTotal : null;
  const cpuText = (pct: number | undefined) => {
    if (typeof pct !== "number") return "-";
    const share = cpuShare(pct);
    return share !== null ? `${Math.round(share * 100)}%` : `${Math.round(pct)}%`;
  };

  const hostJobs = allHostJobs
    .filter((j) => isHostJob(j) && jobMatchesFleetHost(j, host))
    .toSorted(byLoad);
  const liveJobs = hostJobs.filter(isJobLive);
  const finishedJobs = hostJobs.filter((j) => !isJobLive(j));
  const shownJobs = showFinished ? [...liveJobs, ...finishedJobs] : liveJobs;
  const sessions = host.sessions
    .filter(isActionableFleetSession)
    .toSorted((a, b) => (b.cpu_pct ?? 0) - (a.cpu_pct ?? 0));

  const renderConfirm = (label: string, detail: string, onConfirm: () => void) => (
    <div className="flex flex-wrap items-center justify-end gap-2 bg-destructive/6 px-3 py-1.5 text-sm">
      <span className="mr-auto min-w-0 truncate text-muted-foreground">{detail}</span>
      <Button size="xs" variant="ghost" onClick={() => setConfirmKillId(null)}>
        <T>Cancel</T>
      </Button>
      <Button
        size="xs"
        variant="destructive"
        onClick={() => {
          setConfirmKillId(null);
          onConfirm();
        }}
      >
        {label}
      </Button>
    </div>
  );

  const renderJob = (job: JobSummary) => {
    const live = isJobLive(job);
    const pct = job.progress ? Math.round(job.progress.fraction * 100) : null;
    const sub =
      job.recentTail?.at(-1) ?? job.subtitle ?? (job.state === "running" ? "" : job.phaseLabel);
    const subLine = [pct !== null ? `${pct}%` : "", sub].filter(Boolean).join(" · ");
    const stopping = busyKeys.has(`job:${job.id}`) || job.state === "cancelling";
    const confirming = confirmKillId === `job:${job.id}`;
    return (
      <div key={job.id} data-testid="fleet-job-row" data-live={live}>
        <div
          className={`${ROW} ${selectedJobId === job.id ? "bg-muted/40" : "hover:bg-muted/20"} ${live ? "" : "opacity-70"}`}
        >
          <button
            type="button"
            className="flex min-w-0 cursor-pointer items-center gap-2.5 text-left"
            onClick={() => onInspectJob(job.id)}
          >
            <span className={`size-2 shrink-0 rounded-full ${stateDotClass(job)}`} />
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium text-foreground">
                {job.title}
              </span>
              {subLine ? (
                <span className="block truncate font-mono text-xs text-muted-foreground">
                  {subLine}
                </span>
              ) : null}
            </span>
          </button>
          <FleetPanel.Meter
            text={live ? cpuText(job.load?.cpuPct) : "-"}
            share={live ? cpuShare(job.load?.cpuPct) : null}
          />
          <FleetPanel.Meter
            text={live && job.load ? formatJobBytes(job.load.memBytes) || "0" : "-"}
            share={live ? memShare(job.load?.memBytes) : null}
          />
          <span
            className={`${WIDE} text-right font-mono text-sm text-muted-foreground tabular-nums`}
          >
            {compactAge(jobAgeSeconds(job, nowMs))}
          </span>
          <div className="flex items-center justify-end gap-0.5">
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={gt("Inspect job")}
              onClick={() => onInspectJob(job.id)}
            >
              <Maximize2Icon />
            </Button>
            {live && job.cancellable ? (
              <Button
                size="icon-xs"
                variant="ghost-destructive"
                disabled={stopping}
                aria-label={gt("Stop thread for {title}", { title: job.title })}
                title={gt("Stop owning thread and all its running background commands")}
                onClick={() => setConfirmKillId(`job:${job.id}`)}
              >
                <SquareIcon className="size-3 fill-current" />
              </Button>
            ) : null}
          </div>
        </div>
        {confirming
          ? renderConfirm(
              gt("Confirm stop"),
              gt("Stop {title}? This stops its thread and every background command it runs.", {
                title: job.title,
              }),
              () => onCancelJob(job.id),
            )
          : null}
      </div>
    );
  };

  const renderSession = (sess: DevdeckSessionItem) => {
    const sid = sess.id || `${sess.pid ?? 0}:${sess.name ?? "proc"}`;
    const watchdog = isWatchdogTree(sess);
    const killing = busyKeys.has(`sess:${sid}`);
    const canKill = host.isLocal && Boolean(sess.id && sess.close_allowed);
    const name = sess.name || sess.kind || sid;
    const meta = [sess.project, sess.pid ? `PID ${sess.pid}` : "", sess.endpoint ?? ""]
      .filter(Boolean)
      .join(" · ");
    return (
      <div key={sid} data-testid="fleet-proc-row">
        <div className={`${ROW} hover:bg-muted/20`}>
          <div className="flex min-w-0 items-center gap-2.5">
            {watchdog || sess.runaway ? (
              <FlameIcon className="size-3.5 shrink-0 text-destructive" />
            ) : (
              <span className="size-2 shrink-0 rounded-full bg-warning" />
            )}
            <span className="min-w-0">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate text-sm font-medium text-foreground">{name}</span>
                {sess.managed ? (
                  <Badge size="sm" variant="outline">
                    {sess.managed}
                  </Badge>
                ) : null}
                {host.isLocal ? null : (
                  <Badge
                    size="sm"
                    variant="secondary"
                    title={sess.close_blocked_reason ?? gt("Close it from its own host")}
                  >
                    <T>View only</T>
                  </Badge>
                )}
              </span>
              {meta ? (
                <span className="block truncate font-mono text-xs text-muted-foreground">
                  {meta}
                </span>
              ) : null}
            </span>
          </div>
          <FleetPanel.Meter text={cpuText(sess.cpu_pct)} share={cpuShare(sess.cpu_pct)} />
          <FleetPanel.Meter
            text={formatJobBytes(sess.mem_bytes) || "-"}
            share={memShare(sess.mem_bytes)}
          />
          <span
            className={`${WIDE} text-right font-mono text-sm text-muted-foreground tabular-nums`}
          >
            {compactAge(sess.age_s)}
          </span>
          <div className="flex items-center justify-end">
            {canKill ? (
              <Button
                size="icon-xs"
                variant="ghost-destructive"
                disabled={killing}
                aria-label={watchdog ? gt("Kill -9 {name}", { name }) : gt("Kill {name}", { name })}
                onClick={() => (watchdog ? setConfirmKillId(sid) : onCloseSession(sess))}
              >
                <SquareIcon className="size-3 fill-current" />
              </Button>
            ) : null}
          </div>
        </div>
        {confirmKillId === sid
          ? renderConfirm(
              gt("Confirm kill"),
              gt("Kill {name} and its process tree?", { name }),
              () => onCloseSession(sess),
            )
          : null}
      </div>
    );
  };

  return (
    <FleetPanel.Root data-testid="fleet-load-panel">
      <FleetPanel.Header>
        <FleetPanel.Title>
          <ActivityIcon />
          <T context="panel heading: CPU and memory use of jobs and processes">Load</T>
          {liveJobs.length > 0 ? (
            <Badge variant="info">
              <T>
                <Var>{liveJobs.length}</Var> live
              </T>
            </Badge>
          ) : null}
        </FleetPanel.Title>
        {finishedJobs.length > 0 ? (
          <Button size="xs" variant="ghost" onClick={() => setShowFinished((v) => !v)}>
            {showFinished
              ? gt("Hide {n} finished", { n: finishedJobs.length })
              : gt("Show {n} finished", { n: finishedJobs.length })}
          </Button>
        ) : null}
      </FleetPanel.Header>
      {shownJobs.length === 0 && sessions.length === 0 ? null : (
        <FleetPanel.Columns className={COLS}>
          <span>
            <T>Job or process</T>
          </span>
          <Tooltip>
            <TooltipTrigger render={<span />}>
              <T>CPU</T>
            </TooltipTrigger>
            <TooltipPopup side="top">{gt("Share of the host's CPU")}</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger render={<span />}>
              <T>Memory</T>
            </TooltipTrigger>
            <TooltipPopup side="top">{gt("Share of the host's memory")}</TooltipPopup>
          </Tooltip>
          <span className={WIDE}>
            <T>Time</T>
          </span>
          <span />
        </FleetPanel.Columns>
      )}
      {shownJobs.length === 0 && sessions.length === 0 ? (
        <FleetPanel.Empty>
          <T>No running jobs or hot processes on this host.</T>
        </FleetPanel.Empty>
      ) : (
        <FleetPanel.Body>
          {shownJobs.length > 0 ? (
            <FleetPanel.Group>
              <T>Jobs</T>
            </FleetPanel.Group>
          ) : null}
          {shownJobs.map(renderJob)}
          {sessions.length > 0 ? (
            <FleetPanel.Group>
              <T>Hot processes</T>
            </FleetPanel.Group>
          ) : null}
          {sessions.map(renderSession)}
        </FleetPanel.Body>
      )}
    </FleetPanel.Root>
  );
}
