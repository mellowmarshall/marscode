/**
 * Per-host MCP Bounded Jobs & Killable Processes panel inside Fleet Console -> Machines.
 * Every shown job and process is killable/stoppable. Drops passive Observed stubs and Ship Queue duplicates.
 */
import { useState } from "react";
import { T, Var, useGT } from "gt-react";
import { CpuIcon, FlameIcon, Maximize2Icon, TerminalIcon, XCircleIcon } from "lucide-react";

import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import type { DevdeckSessionItem } from "./devtoolsClient";
import type { MergedFleetHost } from "./devdeckTypes";
import {
  formatJobBytes,
  formatJobElapsed,
  isHostJob,
  isJobLive,
  jobKindLabel,
  jobStateBadgeVariant,
  type JobSummary,
} from "./jobs/jobTypes";

function normalizeHostToken(raw: string | undefined): string {
  return (raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/^dev-/, "")
    .replace(/\.local$/, "")
    .replace(/[^a-z0-9]+/g, "");
}

function jobMatchesFleetHost(job: JobSummary, host: MergedFleetHost): boolean {
  const jh = normalizeHostToken(job.binding.host);
  if (!jh) return host.isLocal;
  const tokens = new Set(
    [host.id, host.shortName, host.probeHostName ?? "", ...host.members]
      .map(normalizeHostToken)
      .filter(Boolean),
  );
  return tokens.has(jh);
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

  const hostJobs = allHostJobs
    .filter((j) => isHostJob(j) && jobMatchesFleetHost(j, host))
    .toSorted((a, b) => {
      const la = isJobLive(a) ? 0 : 1;
      const lb = isJobLive(b) ? 0 : 1;
      if (la !== lb) return la - lb;
      return Date.parse(b.timing.startedAt) - Date.parse(a.timing.startedAt);
    })
    .slice(0, 12);

  const actionableSessions = host.sessions.filter(isActionableFleetSession);
  const liveJobCount = hostJobs.filter(isJobLive).length;

  return (
    <section className="overflow-hidden rounded-lg border border-border/70 bg-card/40">
      <div className="flex items-center justify-between gap-2 border-b border-border/60 bg-muted/20 px-3 py-2">
        <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
          <CpuIcon className="size-3.5 text-muted-foreground" />
          <T>Host Jobs & Processes</T>
          {liveJobCount > 0 ? (
            <Badge size="sm" variant="secondary">
              <T>
                <Var>{liveJobCount}</Var> live
              </T>
            </Badge>
          ) : null}
        </div>
        <span className="font-mono text-3xs text-muted-foreground">
          {gt("{jobs} jobs · {procs} procs", {
            jobs: hostJobs.length,
            procs: actionableSessions.length,
          })}
        </span>
      </div>

      {hostJobs.length === 0 && actionableSessions.length === 0 ? (
        <div className="px-3 py-4 text-xs text-muted-foreground">
          <T>No bounded jobs or hot processes on this host.</T>
        </div>
      ) : (
        <div className="divide-y divide-border/50">
          {hostJobs.map((job) => {
            const live = isJobLive(job);
            const pct = job.progress ? Math.round(job.progress.fraction * 100) : null;
            const elapsed = formatJobElapsed(job.timing, nowMs);
            const lastLine = job.recentTail?.at(-1);
            const cancelling = busyKeys.has(`job:${job.id}`);

            const selected = selectedJobId === job.id;
            return (
              <div
                key={job.id}
                data-selected={selected ? "true" : undefined}
                className={
                  selected
                    ? "space-y-1.5 bg-muted/40 px-3 py-2.5 text-xs"
                    : "space-y-1.5 px-3 py-2.5 text-xs hover:bg-muted/20"
                }
              >
                <div className="flex items-start justify-between gap-2">
                  <button
                    type="button"
                    className="min-w-0 flex-1 cursor-pointer space-y-0.5 text-left"
                    onClick={() => onInspectJob(job.id)}
                  >
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge size="sm" variant="outline">
                        {jobKindLabel(job.kind)}
                      </Badge>
                      <Badge size="sm" variant={jobStateBadgeVariant(job.state)}>
                        {job.phaseLabel}
                      </Badge>
                      <span className="truncate font-medium text-foreground">{job.title}</span>
                    </div>
                    {job.subtitle ? (
                      <div className="truncate text-3xs text-muted-foreground">{job.subtitle}</div>
                    ) : null}
                  </button>
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
                    {live && job.cancellable ? (
                      confirmKillId === `job:${job.id}` ? (
                        <>
                          <Button size="xs" variant="ghost" onClick={() => setConfirmKillId(null)}>
                            <T>Cancel</T>
                          </Button>
                          <Button
                            size="xs"
                            variant="destructive"
                            disabled={cancelling || job.state === "cancelling"}
                            onClick={() => {
                              setConfirmKillId(null);
                              onCancelJob(job.id);
                            }}
                          >
                            <T>Confirm stop</T>
                          </Button>
                        </>
                      ) : (
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={cancelling || job.state === "cancelling"}
                          aria-label={gt("Stop thread for {title}", { title: job.title })}
                          title={gt("Stop owning thread and all its running background commands")}
                          onClick={() => setConfirmKillId(`job:${job.id}`)}
                        >
                          <XCircleIcon className="mr-1 size-3 text-destructive" />
                          <T>Stop thread</T>
                        </Button>
                      )
                    ) : null}
                  </div>
                </div>

                {job.progress ? (
                  <div className="flex items-center gap-2">
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-info"
                        style={{ width: `${Math.max(0, Math.min(100, pct ?? 0))}%` }}
                      />
                    </div>
                    <span className="font-mono text-3xs text-muted-foreground tabular-nums">
                      {`${pct ?? 0}%`}
                    </span>
                  </div>
                ) : null}

                {lastLine ? (
                  <div className="flex items-center gap-1.5 truncate rounded bg-background/70 px-2 py-1 font-mono text-3xs text-muted-foreground">
                    <TerminalIcon className="size-2.5 shrink-0" />
                    <span className="truncate">{lastLine}</span>
                  </div>
                ) : null}
              </div>
            );
          })}

          {actionableSessions.map((sess) => {
            const sid = sess.id || `${sess.pid ?? 0}:${sess.name ?? "proc"}`;
            const watchdog = isWatchdogTree(sess);
            const confirming = confirmKillId === sid;
            const killing = busyKeys.has(`sess:${sid}`);
            const cpuText =
              typeof sess.cpu_pct === "number" && sess.cpu_pct >= 1
                ? `${Math.round(sess.cpu_pct)}%`
                : "";
            const memText =
              typeof sess.mem_bytes === "number" && sess.mem_bytes > 0
                ? formatJobBytes(sess.mem_bytes)
                : "";
            const canKill = host.isLocal && Boolean(sess.id && sess.close_allowed);

            return (
              <div
                key={sid}
                className="flex items-center justify-between gap-2 px-3 py-2 text-xs hover:bg-muted/20"
              >
                <div className="flex min-w-0 items-center gap-2">
                  {watchdog || sess.runaway ? (
                    <FlameIcon className="size-3.5 shrink-0 text-destructive" />
                  ) : (
                    <span className="size-2 shrink-0 rounded-full bg-warning" />
                  )}
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate font-medium text-foreground">
                        {sess.name || sess.kind || sid}
                      </span>
                      {sess.managed ? (
                        <Badge size="sm" variant="outline">
                          {sess.managed}
                        </Badge>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap gap-x-2 font-mono text-3xs text-muted-foreground tabular-nums">
                      {sess.pid ? <span>{`PID ${sess.pid}`}</span> : null}
                      {sess.project ? <span>{sess.project}</span> : null}
                      {sess.endpoint ? <span>{sess.endpoint}</span> : null}
                      {cpuText ? <span>{cpuText}</span> : null}
                      {memText ? <span>{memText}</span> : null}
                    </div>
                  </div>
                </div>

                {canKill ? (
                  <div className="flex shrink-0 items-center gap-1">
                    {watchdog && !confirming ? (
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={killing}
                        onClick={() => setConfirmKillId(sid)}
                      >
                        <T>Kill -9</T>
                      </Button>
                    ) : confirming ? (
                      <>
                        <Button size="xs" variant="ghost" onClick={() => setConfirmKillId(null)}>
                          <T>Cancel</T>
                        </Button>
                        <Button
                          size="xs"
                          variant="destructive"
                          disabled={killing}
                          onClick={() => {
                            setConfirmKillId(null);
                            onCloseSession(sess);
                          }}
                        >
                          <T>Confirm kill</T>
                        </Button>
                      </>
                    ) : (
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={killing}
                        onClick={() => onCloseSession(sess)}
                      >
                        <XCircleIcon className="mr-1 size-3 text-destructive" />
                        <T>Kill</T>
                      </Button>
                    )}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
