/** DevDeck-style hairline Ship Queue table row with inline step strip and expandable job facts. */
import type { EnvironmentId } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleDotIcon,
  ExternalLinkIcon,
  TriangleAlertIcon,
  XCircleIcon,
} from "lucide-react";

import { PullRequestGlyph } from "../components/pullRequest/pullRequestIcons";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import type { ShipQueueJob } from "./devtoolsClient";
import { openFleetConsole } from "./devtoolsStore";
import { shipJobCiHost, shipJobRepoName, shipJobSync } from "./shipQueueJobFacts";
import { ShipQueueJobDetails } from "./ShipQueueJobDetails";
import {
  buildSafePrUrl,
  deriveShipJobSteps,
  formatShipJobElapsed,
  isShipQueueJobLive,
  resolveShipJobDisplayState,
  resolveShipJobGhRepo,
  shipQueueStatusVariant,
  shouldHideRedundantStatusBadge,
} from "./ShipQueueSteps";
import { TruncatedText } from "./TruncatedText";

/** Shared by the table header (`ShipQueuePanel`) and every row. */
export const SHIP_QUEUE_GRID_COLUMNS =
  "grid grid-cols-[1.25rem_3.75rem_7.5rem_4rem_minmax(0,1fr)_5.75rem_4.5rem_2rem] gap-2";

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
  const safeRepo = resolveShipJobGhRepo(job);
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
        if (step.state === "warning") {
          return (
            <span
              key={step.id}
              className="inline-flex items-center gap-0.5 font-medium text-warning"
            >
              <TriangleAlertIcon className="size-2.5" />
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

function SyncWarning({ job }: { readonly job: ShipQueueJob }) {
  const gt = useGT();
  const sync = shipJobSync(job);
  if (!sync || sync.exit === 0 || !sync.merged) return null;
  const text = sync.reason
    ? gt("post-merge sync exit {code}: {reason}", { code: sync.exit, reason: sync.reason })
    : gt("post-merge sync exit {code}", { code: sync.exit });
  return (
    <div className="flex min-w-0 items-center gap-1 font-mono text-3xs text-warning">
      <TriangleAlertIcon className="size-2.5 shrink-0" />
      <TruncatedText as="span" text={text} variant="code" className="min-w-0 truncate" />
    </div>
  );
}

export function ShipQueueTableRow({
  job,
  revision,
  environmentId,
  depHeld = false,
  expanded,
  nowMs,
  cancelling,
  onToggleExpand,
  onCancel,
  onOpenThread,
}: {
  readonly job: ShipQueueJob;
  readonly revision: number;
  readonly environmentId: EnvironmentId | null;
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
  const repoName = shipJobRepoName(job);
  const ciHost = shipJobCiHost(job);

  return (
    <div data-testid="ship-queue-row" className="border-b border-border/60 last:border-b-0">
      <div
        className={`${SHIP_QUEUE_GRID_COLUMNS} items-start px-3 py-2.5 text-xs hover:bg-muted/20`}
      >
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

        <div className="min-w-0 space-y-0.5 font-mono">
          <div className="text-2xs text-foreground/85 wrap-anywhere">{repoName ?? "-"}</div>
          {ciHost ? (
            <button
              type="button"
              data-testid="ship-queue-ci-host"
              className="block max-w-full text-left text-3xs text-muted-foreground wrap-anywhere hover:text-foreground hover:underline"
              aria-label={gt("CI host {host}", { host: ciHost })}
              onClick={() => openFleetConsole({ section: "machines", host: ciHost })}
            >
              {ciHost}
            </button>
          ) : null}
        </div>

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
          ) : job.pr !== undefined && String(job.pr).trim() !== "" ? (
            <span className="font-mono text-2xs text-foreground/85">{`#${job.pr}`}</span>
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
            <div className="truncate font-mono text-3xs text-muted-foreground">{job.branch}</div>
          ) : null}
          {live || status.toLowerCase().includes("fail") ? (
            <ShipQueueInlineSteps job={job} />
          ) : (
            <SyncWarning job={job} />
          )}
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
        <ShipQueueJobDetails job={job} environmentId={environmentId} revision={revision} />
      ) : null}
    </div>
  );
}
