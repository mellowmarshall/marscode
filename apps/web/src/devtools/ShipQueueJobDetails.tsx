/**
 * Expanded Ship Queue row: the facts the collapsed row lacks (per-step host and time, failure and
 * waiting reasons, the playbook challenge, the post-merge sync, commits) and a capped log excerpt.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { useState, type ReactNode } from "react";

import { Button } from "../components/ui/button";
import type { ShipQueueJob } from "./devtoolsClient";
import { useJobDetail } from "./jobs/jobsStore";
import { isShipQueueJobLive } from "./ShipQueueSteps";
import {
  formatStepDuration,
  shipJobChallenge,
  shipJobSteps,
  shipJobSync,
  shortSha,
} from "./shipQueueJobFacts";
import { TruncatedText } from "./TruncatedText";

function formatClock(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const ts = Date.parse(raw);
  if (!Number.isFinite(ts)) return null;
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function Fact({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <>
      <dt className="whitespace-nowrap text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}

function StepTimings({ job }: { readonly job: ShipQueueJob }) {
  const gt = useGT();
  const steps = shipJobSteps(job);
  if (steps.length === 0) {
    return (
      <p className="self-start text-3xs text-muted-foreground">
        <T>No step timings recorded for this job.</T>
      </p>
    );
  }
  return (
    <table
      className="w-full self-start border-collapse font-mono text-3xs"
      aria-label={gt("Step timings")}
    >
      <thead>
        <tr className="text-left uppercase tracking-wide text-muted-foreground">
          <th className="pb-1 pr-3 font-medium">{gt("Step")}</th>
          <th className="pb-1 pr-3 font-medium">{gt("Host")}</th>
          <th className="pb-1 pr-3 text-right font-medium">{gt("Time")}</th>
          <th className="pb-1 text-right font-medium">{gt("Exit")}</th>
        </tr>
      </thead>
      <tbody>
        {steps.map((step) => {
          const failed = typeof step.exit === "number" && step.exit !== 0;
          return (
            <tr key={step.name} className="border-t border-border/40">
              <td className="py-0.5 pr-3 text-foreground/90">{step.name}</td>
              <td className="py-0.5 pr-3 text-muted-foreground wrap-anywhere">
                {step.host || "-"}
              </td>
              <td className="py-0.5 pr-3 text-right tabular-nums text-foreground/85">
                {formatStepDuration(step.ms) ?? "-"}
              </td>
              <td
                className={
                  failed
                    ? "py-0.5 text-right font-semibold tabular-nums text-destructive"
                    : "py-0.5 text-right tabular-nums text-success"
                }
              >
                {typeof step.exit === "number" ? step.exit : "-"}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function JobFacts({ job }: { readonly job: ShipQueueJob }) {
  const gt = useGT();
  const live = isShipQueueJobLive(job);
  const failed = /fail|cancel/.test((job.state ?? "").toLowerCase());
  const challenge = shipJobChallenge(job);
  const sync = shipJobSync(job);
  const waitingFor = job.waiting_for?.trim().toLowerCase();
  // The queue's current `waiting_for`, then the older free-text fields.
  const waiting =
    [
      waitingFor === "action"
        ? gt("the owner's approval")
        : waitingFor === "challenge"
          ? gt("on hold pending agent review")
          : waitingFor === "watcher"
            ? gt("a watcher")
            : waitingFor || null,
      job.waiting?.trim() || job.ci_wait?.reason?.trim() || null,
    ]
      .filter(Boolean)
      .join(" · ") || null;
  const rebased = shortSha(job.rebased_onto);
  const pushed = shortSha(job.pushed_sha);
  const exits = [
    job.push_exit !== undefined ? gt("push {code}", { code: String(job.push_exit) }) : null,
    job.merge_exit !== undefined ? gt("merge {code}", { code: String(job.merge_exit) }) : null,
  ].filter((part): part is string => part !== null);

  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1 self-start text-2xs">
      {failed && job.reason ? (
        <Fact label={gt("Reason")}>
          <span className="font-mono text-destructive wrap-anywhere">{job.reason}</span>
        </Fact>
      ) : null}
      {live && waiting ? (
        <Fact label={gt("Waiting")}>
          <TruncatedText
            text={waiting}
            variant="code"
            className="truncate font-mono text-3xs text-warning"
          />
        </Fact>
      ) : null}
      {challenge ? (
        <Fact label={gt("Review")}>
          {challenge.kind === "overridden" ? (
            <div className="min-w-0 space-y-0.5">
              <div className="font-medium text-warning">
                {challenge.at
                  ? gt("Resumed after review at {time}", {
                      time: formatClock(challenge.at) ?? challenge.at,
                    })
                  : gt("Resumed after review")}
              </div>
              <TruncatedText
                text={challenge.reason}
                className="line-clamp-2 text-3xs text-muted-foreground"
              />
            </div>
          ) : (
            <span className="font-medium text-warning">
              {live
                ? gt("On hold at {sha}; pending agent review", {
                    sha: challenge.tip.slice(0, 7),
                  })
                : gt("Challenged at {sha}", { sha: challenge.tip.slice(0, 7) })}
            </span>
          )}
        </Fact>
      ) : null}
      {sync ? (
        <Fact label={gt("Post-merge sync")}>
          {sync.exit === 0 ? (
            <span className="text-success">{gt("exit 0")}</span>
          ) : (
            <span
              data-testid="ship-job-sync"
              className={
                sync.merged ? "font-mono text-warning wrap-anywhere" : "font-mono text-destructive"
              }
            >
              {sync.reason
                ? gt("exit {code}: {reason}", { code: sync.exit, reason: sync.reason })
                : gt("exit {code}", { code: sync.exit })}
              {sync.merged && job.pr ? (
                <span className="text-muted-foreground">
                  {` · ${gt("PR #{pr} stays merged", { pr: String(job.pr) })}`}
                </span>
              ) : null}
            </span>
          )}
        </Fact>
      ) : null}
      {exits.length > 0 ? (
        <Fact label={gt("Exits")}>
          <span className="font-mono text-foreground/85">{exits.join(" · ")}</span>
        </Fact>
      ) : null}
      {rebased || pushed ? (
        <Fact label={gt("Commits")}>
          <span className="font-mono text-foreground/85">
            {[
              rebased ? gt("onto {sha}", { sha: rebased }) : null,
              pushed ? gt("pushed {sha}", { sha: pushed }) : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </Fact>
      ) : null}
    </dl>
  );
}

function JobLogExcerpt({
  job,
  environmentId,
  revision,
}: {
  readonly job: ShipQueueJob;
  readonly environmentId: EnvironmentId | null;
  readonly revision: number;
}) {
  const gt = useGT();
  const [expanded, setExpanded] = useState(false);
  const jobId = job.id ? `ship:${job.id}` : null;
  const { detail, loading, error } = useJobDetail(environmentId, jobId, revision);
  const lines = detail?.logTail ?? [];

  return (
    <section className="min-w-0 space-y-1 md:col-span-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-3xs font-medium uppercase tracking-wide text-muted-foreground">
          {lines.length > 0 ? gt("Log · last {count} lines", { count: lines.length }) : gt("Log")}
        </span>
        {lines.length > 0 ? (
          <Button
            size="xs"
            variant="ghost"
            aria-expanded={expanded}
            onClick={() => setExpanded((cur) => !cur)}
          >
            {expanded ? gt("Collapse log") : gt("Expand log")}
          </Button>
        ) : null}
      </div>
      {lines.length > 0 ? (
        // column-reverse keeps the scroll pinned to the newest line without a scroll effect.
        <div
          role="log"
          tabIndex={0}
          aria-label={gt("Job log excerpt")}
          data-testid="ship-job-log"
          data-expanded={expanded}
          className={`flex flex-col-reverse overflow-auto rounded border border-border/60 bg-background/70 px-2 py-1.5 font-mono text-3xs leading-relaxed ${expanded ? "max-h-96" : "max-h-28"}`}
        >
          <div>
            {lines.map((line, idx) => (
              <div
                // oxlint-disable-next-line react/no-array-index-key -- log lines repeat; position is their identity
                key={idx}
                className={
                  line.startsWith(" ")
                    ? "whitespace-pre-wrap text-muted-foreground wrap-anywhere"
                    : "whitespace-pre-wrap text-foreground/90 wrap-anywhere"
                }
              >
                {line}
              </div>
            ))}
          </div>
        </div>
      ) : (
        <p className="text-3xs text-muted-foreground">
          {loading ? gt("Loading log…") : (error ?? gt("No log output for this job."))}
        </p>
      )}
    </section>
  );
}

export function ShipQueueJobDetails({
  job,
  environmentId,
  revision,
}: {
  readonly job: ShipQueueJob;
  readonly environmentId: EnvironmentId | null;
  readonly revision: number;
}) {
  return (
    <div
      data-testid="ship-job-details"
      className="grid gap-x-6 gap-y-3 border-t border-border/50 bg-muted/15 px-6 py-3 md:grid-cols-[minmax(0,24rem)_minmax(0,1fr)]"
    >
      <StepTimings job={job} />
      <JobFacts job={job} />
      <JobLogExcerpt job={job} environmentId={environmentId} revision={revision} />
    </div>
  );
}
