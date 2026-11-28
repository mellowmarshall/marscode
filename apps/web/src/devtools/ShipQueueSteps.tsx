/**
 * Pipeline step derivation and state helpers for ship-queue jobs.
 * Matches exact `sq_job.py`, `ship-queue-pipeline.sh`, `ship-queue-ci.sh`, `ship-queue-land.sh`,
 * and DevDeck post-merge (deploy) semantics.
 */
import { msg } from "gt-react";

import { m } from "~/i18n/messages";
import type { ShipQueueJob } from "./devtoolsClient";
import { parseShipJobStartMs, resolveShipJobEndMs } from "./shipJobTiming";

const SAFE_GH_REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
// Log stages a worker reaches only after STARTED (`@t3tools/ship-queue/markers`).
const STARTED_STAGES = new Set([
  "rebase",
  "ci",
  "pr",
  "github",
  "cleanup",
  "post-merge",
  "deploy",
  "deployed",
]);
const MARKER_REBASED_RE = /^REBASED\s+([0-9a-f]{7,40})\b/i;

/** The job's GitHub `owner/name`: its `pr_repo`, else its queue `repo`, which the queue keys by `owner/name`. */
export function resolveShipJobGhRepo(job: ShipQueueJob): string | null {
  for (const candidate of [job.pr_repo, job.repo]) {
    const value = candidate?.trim();
    if (value && SAFE_GH_REPO_RE.test(value)) return value;
  }
  return null;
}

export function buildSafePrUrl(job: ShipQueueJob): string | null {
  const ghRepo = resolveShipJobGhRepo(job);
  if (!ghRepo) return null;
  const prNum = typeof job.pr === "number" ? job.pr : Number(job.pr);
  if (!Number.isInteger(prNum) || prNum <= 0) return null;
  return `https://github.com/${ghRepo}/pull/${prNum}`;
}

export function isShipQueueJobLive(job: ShipQueueJob): boolean {
  const raw = (job.state ?? job.display_state ?? "").toLowerCase();
  return /^(queued|pending|running|active|waiting|ci|pushed|parked|needs-root|deploy)/.test(raw);
}

export function shouldHideRedundantStatusBadge(status: string): boolean {
  return status.trim().toLowerCase() === "running";
}

function formatDurationSeconds(totalSeconds: number): string {
  const secs = Math.max(0, Math.floor(totalSeconds));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  if (mins < 60) {
    return `${mins}m ${String(remSecs).padStart(2, "0")}s`;
  }
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hours}h ${String(remMins).padStart(2, "0")}m`;
}

export function formatShipJobElapsed(job: ShipQueueJob, nowMs: number): string | null {
  const startMs = parseShipJobStartMs(job);
  if (startMs === null) return null;
  if (isShipQueueJobLive(job)) {
    return formatDurationSeconds((nowMs - startMs) / 1000);
  }
  const endMs = resolveShipJobEndMs(job);
  return endMs !== null && endMs >= startMs
    ? formatDurationSeconds((endMs - startMs) / 1000)
    : null;
}

function formatActiveCiDetail(
  waiting: string | undefined,
  marker: string | undefined,
): string | undefined {
  const w = waiting?.trim();
  if (w) return w;
  const raw = marker?.trim();
  if (!raw) return undefined;
  const rebased = MARKER_REBASED_RE.exec(raw);
  if (rebased?.[1]) {
    return m(msg("rebased {sha}"), { sha: rebased[1].slice(0, 7) });
  }
  if (/^STARTED\b/i.test(raw)) return undefined;
  if (/^WAITING_WATCHER\b/i.test(raw)) return m(msg("waiting for watcher"));
  return raw;
}

export function resolveShipJobDisplayState(job: ShipQueueJob): string {
  const raw = (job.display_state ?? job.state ?? "unknown").trim();
  const lower = raw.toLowerCase();
  const stageLower = (job.stage ?? "").trim().toLowerCase();
  const syncExit = exitNum(job.sync_exit);
  if (isShipQueueJobLive(job)) {
    // Match DevDeck: "deploying" only from POST_MERGE until SYNC_EXIT=,
    // never merely from MERGE_EXIT=0; after SYNC_EXIT= while still live, show "post-merge".
    if (stageLower === "deployed" || syncExit === 0) {
      return "post-merge";
    }
    const marker = (job.last_marker ?? "").trim();
    if (
      syncExit === null &&
      (stageLower === "deploy" ||
        stageLower === "deploying" ||
        /^POST_MERGE\b/i.test(marker) ||
        lower.startsWith("deploy"))
    ) {
      return "deploying";
    }
  } else if (lower.startsWith("deploy")) {
    return "deploying";
  }
  return raw || "unknown";
}

export function shipQueueStatusVariant(
  status: string,
): "info" | "success" | "warning" | "error" | "secondary" | "outline" {
  const s = status.toLowerCase();
  if (/fail|error|refus|cancel/.test(s)) return "error";
  if (/done|merged|pass/.test(s)) return "success";
  if (/wait|queue|park|hold|root|approv/.test(s)) return "warning";
  if (/run|active|ci|merge|deploy|ship|push/.test(s)) return "info";
  return "outline";
}

/**
 * `warning`: the step failed after the job's outcome was already settled (a merged PR's post-merge sync).
 * `stopped`: the job was cancelled or superseded there, with no recorded step failing.
 */
export type StepState =
  | "done"
  | "active"
  | "waiting"
  | "warning"
  | "stopped"
  | "failed"
  | "pending";

const STOPPED_REASONS = new Set(["cancelled", "superseded"]);
const CI_STEP_NAME = "ship_ci";

export interface DerivedShipStep {
  readonly id: string;
  readonly label: string;
  readonly state: StepState;
  readonly detail?: string | undefined;
  readonly badge?: string | undefined;
  readonly href?: string | undefined;
}

function exitNum(value: number | string | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function isTruthyFlag(value: boolean | number | string | undefined): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

export function deriveShipJobSteps(
  job: ShipQueueJob,
  labels: {
    readonly queued: string;
    readonly watcher: string;
    readonly ci: string;
    readonly push: string;
    readonly pr: string;
    readonly merge: string;
    readonly land: string;
  },
): ReadonlyArray<DerivedShipStep> {
  const rawState = (job.state ?? "").toLowerCase();
  const isDone = rawState === "done";
  const isFailed = rawState === "failed" || rawState === "cancelled";
  const isQueued = rawState === "queued";
  const isParked = !isDone && !isFailed && Boolean(job.parked?.for);
  const needsRoot =
    !isDone &&
    !isFailed &&
    Boolean(job.needs_root?.request) &&
    Array.isArray(job.needs_root?.hosts) &&
    job.needs_root.hosts.length > 0;
  const marker = job.last_marker ?? "";
  const reason = job.reason ?? "";

  const pushExit = exitNum(job.push_exit);
  const mergeExit = exitNum(job.merge_exit);
  const syncExit = exitNum(job.sync_exit);
  const prUrl = buildSafePrUrl(job);
  const hasPr = job.pr !== undefined && String(job.pr).trim() !== "";
  const isRetryingRound2 = rawState === "running" && mergeExit === 75;
  const lowerReason = reason.toLowerCase();
  const isPrFailureReason =
    !lowerReason.startsWith("merge ") &&
    !lowerReason.includes("(merged)") &&
    /(?:^|[\s_-])pr(?:_|\s|$)/i.test(lowerReason);
  // First- or second-round PR failure (e.g. `pr_head_stale` after push_exit=0).
  const isFailedPr = isFailed && pushExit === 0 && isPrFailureReason;
  // Round 1 sets merge_exit=75 then loops back to phase_push/CI; if Round 2 fails before
  // phase_merge runs again, reason does NOT start with "merge ", so Round-1 push/PR/merge fields may be stale.
  const isFailedRound2BeforeMerge =
    isFailed && mergeExit === 75 && !lowerReason.startsWith("merge ");
  const isFailedRound2Ci =
    isFailedRound2BeforeMerge && !isFailedPr && (pushExit === null || pushExit === 0);

  const reachedPostCi =
    !isFailedRound2Ci && (pushExit !== null || hasPr || mergeExit !== null || isDone);
  const ciPassed = reachedPostCi || (isTruthyFlag(job.ci_done) && !isFailed);
  const started =
    !isParked &&
    !isQueued &&
    (rawState === "running" ||
      ciPassed ||
      isTruthyFlag(job.ci_done) ||
      Boolean(job.route?.host) ||
      Boolean(job.rebased_onto) ||
      (job.steps?.length ?? 0) > 0 ||
      STARTED_STAGES.has((job.stage ?? "").trim().toLowerCase()) ||
      marker.startsWith("STARTED") ||
      marker.startsWith("REBASED"));
  const waitingWatcher =
    !isParked &&
    (rawState === "waiting_watcher" ||
      (!started && !isDone && !isFailed && marker.startsWith("WAITING_WATCHER")));

  const states: StepState[] = [
    "done",
    "pending",
    "pending",
    "pending",
    "pending",
    "pending",
    "pending",
  ];

  if (isParked) {
    states[0] = "waiting";
  } else if (isQueued) {
    states[0] = "active";
  } else if (
    isFailed &&
    !started &&
    !waitingWatcher &&
    !reachedPostCi &&
    !reason.includes("watcher")
  ) {
    states[0] = "failed";
  } else {
    states[0] = "done";
  }

  if (waitingWatcher) {
    states[1] = "waiting";
  } else if (started || ciPassed || isDone) {
    states[1] = "done";
  } else if (isFailed && reason.includes("watcher")) {
    states[1] = "failed";
  }

  if (ciPassed && !isRetryingRound2) {
    states[2] = "done";
  } else if (needsRoot) {
    states[2] = "waiting";
  } else if ((started || isRetryingRound2) && !isFailed) {
    states[2] = "active";
  } else if (isFailed && started && !reachedPostCi) {
    states[2] = "failed";
  }

  if (isFailedRound2Ci) {
    // Round-2 CI failed before push/merge; Round-1 push/PR/merge exits are stale.
  } else if (pushExit !== null && pushExit !== 0) {
    states[3] = "failed";
  } else if ((pushExit === 0 || hasPr || mergeExit !== null || isDone) && !isRetryingRound2) {
    states[3] = "done";
  } else if (ciPassed && !isFailed && !isDone && !isRetryingRound2) {
    states[3] = "active";
  }

  if (isFailedRound2Ci) {
    // keep PR pending after Round-2 CI failure
  } else if (isFailedPr) {
    states[4] = "failed";
  } else if (hasPr && states[3] !== "failed") {
    states[4] = "done";
  } else if (pushExit === 0 && !isFailed && !isDone) {
    states[4] = "active";
  } else if (isFailed && pushExit === 0 && !hasPr && mergeExit === null) {
    states[4] = "failed";
  }

  if (isFailedRound2Ci || isFailedPr || states[3] === "failed") {
    // keep Merge Gate pending when failure occurred in CI, Push, or Pull Request
  } else if (mergeExit === 0 || syncExit !== null || isDone) {
    states[5] = "done";
  } else if (isRetryingRound2) {
    states[5] = "waiting";
  } else if (mergeExit !== null && mergeExit !== 0) {
    states[5] = "failed";
  } else if (hasPr && !isFailed && !isDone) {
    states[5] = "active";
  } else if (isFailed && hasPr) {
    states[5] = "failed";
  }

  // Match DevDeck: a repo with no post-merge step never shows Deploy,
  // and Deploy turns done ONLY on SYNC_EXIT=0 (or stage === "deployed"), never merely from DONE.
  const stageLower = (job.stage ?? "").trim().toLowerCase();
  const hasPostMergeMarker = /^POST_MERGE\b/i.test(marker.trim()) || job.post_merge === true;
  const hasDeployStep =
    syncExit !== null ||
    stageLower === "deploy" ||
    stageLower === "deploying" ||
    stageLower === "deployed" ||
    hasPostMergeMarker ||
    rawState.startsWith("deploy");

  if (hasDeployStep) {
    if (syncExit !== null && syncExit !== 0) {
      // The PR stays merged whatever the sync does: a done job's failed sync is a warning, not a failure.
      states[6] = isDone ? "warning" : "failed";
    } else if (syncExit === 0 || (stageLower === "deployed" && !isFailed)) {
      states[6] = "done";
    } else if (isFailed) {
      states[6] = "failed";
    } else if (!isDone) {
      states[6] = "active";
    }
  }

  // Ensure a failed/cancelled job (e.g. remote_branch_left / pre_cleanup_failed / post-merge cancel
  // on a repo with no Deploy step) never shows every rendered step green (M2).
  const renderedStepCount = hasDeployStep ? 7 : 6;
  if (isFailed && !states.slice(0, renderedStepCount).includes("failed")) {
    let lastReached = 0;
    for (let i = renderedStepCount - 1; i >= 0; i -= 1) {
      if (states[i] !== "pending") {
        lastReached = i;
        break;
      }
    }
    states[lastReached] = "failed";
  }

  // A job cancelled or superseded while every recorded step passed did not fail: it stopped at the
  // stage after the last one that passed (a passed ship_ci step means CI passed).
  const recordedSteps = job.steps ?? [];
  const stopped =
    isFailed &&
    (rawState === "cancelled" || STOPPED_REASONS.has(lowerReason.trim())) &&
    recordedSteps.every((step) => step.exit === 0);
  if (stopped) {
    if (states[2] === "failed" && recordedSteps.some((step) => step.name === CI_STEP_NAME)) {
      states[2] = "done";
      states[3] = "stopped";
    }
    for (let i = 0; i < states.length; i += 1) {
      if (states[i] === "failed") states[i] = "stopped";
    }
  }

  const hostBadge = job.route?.host ? String(job.route.host) : undefined;
  const prBadge = hasPr ? `#${job.pr}` : undefined;

  const steps: DerivedShipStep[] = [
    {
      id: "queued",
      label: labels.queued,
      state: states[0]!,
      detail: isParked
        ? m(msg("parked: {reason}"), { reason: job.parked?.for ?? "" })
        : states[0] === "failed"
          ? reason || undefined
          : undefined,
    },
    {
      id: "watcher",
      label: labels.watcher,
      state: states[1]!,
      detail:
        states[1] === "failed"
          ? reason || undefined
          : typeof job.watchers === "number" && job.watchers > 0
            ? m(msg("{count} active"), { count: job.watchers })
            : undefined,
    },
    {
      id: "ci",
      label: labels.ci,
      state: states[2]!,
      badge: hostBadge,
      detail: needsRoot
        ? m(msg("waiting for root grant"))
        : states[2] === "active"
          ? formatActiveCiDetail(job.waiting, marker)
          : states[2] === "failed"
            ? reason || undefined
            : undefined,
    },
    {
      id: "push",
      label: labels.push,
      state: states[3]!,
      detail:
        states[3] === "failed"
          ? reason || m(msg("exit {code}"), { code: pushExit ?? "" })
          : undefined,
    },
    {
      id: "pr",
      label: labels.pr,
      state: states[4]!,
      badge: prBadge,
      href: prUrl ?? undefined,
      detail: states[4] === "failed" ? reason || undefined : undefined,
    },
    {
      id: "merge",
      label: labels.merge,
      state: states[5]!,
      detail: isRetryingRound2
        ? m(msg("base moved; retrying round 2"))
        : states[5] === "active"
          ? job.waiting || undefined
          : states[5] === "failed"
            ? reason || m(msg("exit {code}"), { code: mergeExit ?? "" })
            : !hasDeployStep && isFailed && mergeExit === 0
              ? reason || undefined
              : undefined,
    },
  ];
  if (hasDeployStep) {
    const syncDetail =
      syncExit !== null && syncExit !== 0
        ? job.sync_reason
          ? m(msg("exit {code}: {reason}"), { code: syncExit, reason: job.sync_reason })
          : m(msg("exit {code}"), { code: syncExit })
        : undefined;
    steps.push({
      id: "land",
      label: labels.land,
      state: states[6]!,
      detail:
        states[6] === "warning"
          ? syncDetail
          : states[6] === "failed"
            ? (syncDetail ?? (reason || m(msg("exit {code}"), { code: syncExit ?? "" })))
            : undefined,
    });
  }
  return stopped
    ? steps.map((step) => (step.state === "stopped" ? { ...step, detail: reason } : step))
    : steps;
}
