/** DevDeck-style hairline Ship Queue table row with inline step strip and expandable vertical tracker. */
import { T, Var, useGT } from "gt-react";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleDotIcon,
  ExternalLinkIcon,
  XCircleIcon,
} from "lucide-react";

import { PullRequestGlyph } from "../components/pullRequest/pullRequestIcons";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import type { ShipQueueJob } from "./devtoolsClient";
import { openFleetConsole } from "./devtoolsStore";
import {
  buildSafePrUrl,
  deriveShipJobSteps,
  formatShipJobElapsed,
  isShipQueueJobLive,
  resolveShipJobDisplayState,
  shipQueueStatusVariant,
  shouldHideRedundantStatusBadge,
} from "./ShipQueueSteps";
import { ShipQueueVerticalTracker } from "./ShipQueueVerticalTracker";

const SAFE_GH_REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

function extractIssueRefs(
  job: ShipQueueJob,
): ReadonlyArray<{ readonly num: number; readonly url: string | null }> {
  const haystack = `${job.branch ?? ""} ${job.title ?? ""}`;
  const found = new Set<number>();
  const re = /(?:issue[-_#\s]?|#|fixes\s+#|closes\s+#)(\d{1,6})\b/gi;
  for (const match of haystack.matchAll(re)) {
    const n = Number(match[1]);
    if (Number.isInteger(n) && n > 0 && String(n) !== String(job.pr ?? "")) {
      found.add(n);
    }
  }
  const safeRepo = job.pr_repo && SAFE_GH_REPO_RE.test(job.pr_repo) ? job.pr_repo : null;
  return [...found].slice(0, 3).map((num) => ({
    num,
    url: safeRepo ? `https://github.com/${safeRepo}/issues/${num}` : null,
  }));
}

function formatWhenStamp(raw: string | undefined): string {
  if (!raw) return "";
  const ts = Date.parse(raw);
  if (!Number.isFinite(ts)) return "";
  const d = new Date(ts);
  const now = new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) return `${hh}:${mm}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
}

function ShipQueueInlineSteps({ job }: { readonly job: ShipQueueJob }) {
  const gt = useGT();
  const steps = deriveShipJobSteps(job, {
    queued: gt("queued"),
    watcher: gt("watcher"),
    ci: gt("CI"),
    push: gt("push"),
    pr: gt("PR"),
    merge: gt("merge"),
    land: gt("deploy"),
  });
  return (
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 font-mono text-3xs">
      {steps.map((step) => {
        if (step.state === "done") {
          return (
            <span key={step.id} className="inline-flex items-center gap-0.5 text-muted-foreground">
              <CheckIcon className="size-2.5 text-success" />
              <span>{step.label}</span>
            </span>
          );
        }
        if (step.state === "active") {
          return (
            <span
              key={step.id}
              className="inline-flex items-center gap-1 font-semibold text-foreground"
            >
              <CircleDotIcon className="size-2.5 animate-pulse text-info-foreground" />
              <span>{step.label}</span>
            </span>
          );
        }
        if (step.state === "waiting") {
          return (
            <span key={step.id} className="inline-flex items-center gap-1 font-medium text-warning">
              <span>{step.label}</span>
            </span>
          );
        }
        if (step.state === "failed") {
          return (
            <span
              key={step.id}
              className="inline-flex items-center gap-0.5 font-semibold text-destructive"
            >
              <XCircleIcon className="size-2.5" />
              <span>{step.label}</span>
            </span>
          );
        }
        return (
          <span key={step.id} className="text-muted-foreground/45">
            {step.label}
          </span>
        );
      })}
    </div>
  );
}

export function ShipQueueTableRow({
  job,
  depHeld = false,
  expanded,
  nowMs,
  cancelling,
  onToggleExpand,
  onCancel,
  onOpenThread,
}: {
  readonly job: ShipQueueJob;
  readonly depHeld?: boolean;
  readonly expanded: boolean;
  readonly nowMs: number;
  readonly cancelling: boolean;
  readonly onToggleExpand: () => void;
  readonly onCancel: () => void;
  readonly onOpenThread?: (() => void) | undefined;
}) {
  const gt = useGT();
  const id = job.id ?? `${job.repo ?? "repo"}:${job.branch ?? "job"}`;
  const live = isShipQueueJobLive(job);
  const cancellable = /^[0-9]{1,16}$/.test(id) && live;
  const status = resolveShipJobDisplayState(job);
  const hideStatus = shouldHideRedundantStatusBadge(status);
  const prUrl = buildSafePrUrl(job);
  const issueRefs = extractIssueRefs(job);
  const elapsed = formatShipJobElapsed(job, nowMs);
  const when = formatWhenStamp(job.submitted_at);

  return (
    <div className="border-b border-border/60 last:border-b-0">
      <div className="grid grid-cols-[1.25rem_4.5rem_5.5rem_4rem_minmax(0,1fr)_5.75rem_4.5rem_2rem] items-start gap-2 px-3 py-2.5 text-xs hover:bg-muted/20">
        <button
          type="button"
          className="mt-0.5 text-muted-foreground hover:text-foreground"
          aria-label={expanded ? gt("Collapse job details") : gt("Expand job details")}
          onClick={onToggleExpand}
        >
          {expanded ? (
            <ChevronDownIcon className="size-3.5" />
          ) : (
            <ChevronRightIcon className="size-3.5" />
          )}
        </button>

        <button
          type="button"
          className="truncate text-left font-mono font-medium text-foreground tabular-nums hover:underline"
          onClick={onToggleExpand}
        >
          {`#${id}`}
        </button>

        <span className="truncate font-mono text-2xs text-muted-foreground">{job.repo ?? "-"}</span>

        <div className="min-w-0">
          {prUrl ? (
            <a
              href={prUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-0.5 font-mono text-2xs text-info-foreground hover:underline"
            >
              <PullRequestGlyph.pullRequest className="size-3 shrink-0" />
              <span>{`#${job.pr}`}</span>
            </a>
          ) : (
            <span className="font-mono text-2xs text-muted-foreground/50">-</span>
          )}
        </div>

        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              className="min-w-0 truncate text-left font-medium text-foreground hover:underline"
              onClick={onToggleExpand}
            >
              {job.title || job.branch || id}
            </button>
            {issueRefs.map((ref) =>
              ref.url ? (
                <a
                  key={ref.num}
                  href={ref.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex shrink-0 items-center gap-0.5 font-mono text-3xs text-muted-foreground hover:text-info-foreground hover:underline"
                >
                  <span>{`#${ref.num}`}</span>
                  <ExternalLinkIcon className="size-2.5" />
                </a>
              ) : (
                <span key={ref.num} className="font-mono text-3xs text-muted-foreground">
                  {`#${ref.num}`}
                </span>
              ),
            )}
          </div>
          {job.branch ? (
            <div className="flex flex-wrap items-center gap-2 font-mono text-3xs text-muted-foreground">
              <span className="truncate">{job.branch}</span>
              {job.route?.host ? (
                <button
                  type="button"
                  className="rounded border border-border/70 bg-muted/30 px-1 py-px text-3xs text-muted-foreground hover:text-foreground"
                  onClick={() =>
                    openFleetConsole({ section: "machines", host: job.route?.host ?? null })
                  }
                >
                  {job.route.host}
                </button>
              ) : null}
            </div>
          ) : null}
          {live || status.toLowerCase().includes("fail") ? (
            <ShipQueueInlineSteps job={job} />
          ) : null}
        </div>

        <div className="flex flex-col items-end gap-0.5">
          {depHeld ? (
            <Badge size="sm" variant="warning">
              <T>Approval</T>
            </Badge>
          ) : !hideStatus ? (
            <Badge size="sm" variant={shipQueueStatusVariant(status)}>
              {status}
            </Badge>
          ) : null}
          {depHeld && onOpenThread ? (
            <button
              type="button"
              className="font-mono text-3xs text-info-foreground hover:underline"
              onClick={onOpenThread}
            >
              <T>Open thread</T>
            </button>
          ) : elapsed ? (
            <span className="font-mono text-3xs text-muted-foreground tabular-nums">{elapsed}</span>
          ) : null}
        </div>

        <div className="text-right font-mono text-3xs text-muted-foreground tabular-nums">
          {when || "-"}
        </div>

        <div className="flex justify-end">
          {cancellable ? (
            <Button
              size="xs"
              variant="ghost"
              disabled={cancelling}
              aria-label={gt("Cancel ship job #{id}", { id })}
              onClick={onCancel}
            >
              <XCircleIcon className="size-3.5 text-destructive" />
            </Button>
          ) : null}
        </div>
      </div>

      {expanded ? (
        <div className="border-t border-border/50 bg-muted/15 px-6 py-3">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <ShipQueueVerticalTracker job={job} />
            <div className="space-y-1.5 text-2xs">
              {job.reason ? (
                <div className="rounded border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 font-mono text-destructive">
                  {job.reason}
                </div>
              ) : null}
              {job.last_marker ? (
                <div className="rounded border border-border/60 bg-background/70 px-2.5 py-1.5 font-mono text-3xs text-muted-foreground">
                  {job.last_marker}
                </div>
              ) : null}
              {job.waiting ? (
                <div className="font-mono text-3xs text-muted-foreground">
                  <T>
                    Waiting: <Var>{job.waiting}</Var>
                  </T>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
