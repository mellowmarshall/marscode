import type { ShipQueueJob } from "@t3tools/contracts";
import { msg } from "gt-react";

import { m, type MessageResolver } from "~/i18n/messages";

const JOB_KEY_EPOCH_RE = /^(\d{9,11})-j/u;
const MARKER_AT_RE = /\bat=(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:[+-]\d{2}:?\d{2}|Z)?)/u;
const MARKER_REBASED_RE = /^REBASED\s+([0-9a-f]{7,40})\b/iu;
const SAFE_GH_REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const SAFE_PR_NUM_RE = /^\d{1,10}$/u;

export function isShipQueueJobLive(job: ShipQueueJob): boolean {
  const s = (job.state || job.displayState || "").trim().toLowerCase();
  if (!s) return false;
  if (s === "done" || s === "merged" || s === "cancelled") return false;
  if (s === "failed" || s.includes("fail")) return false;
  return true;
}

export function shouldHideRedundantStatusBadge(displayStatus: string): boolean {
  const normalized = displayStatus.trim().toLowerCase();
  return normalized === "running" || normalized === "waiting" || normalized === "queued";
}

export function buildSafePrUrl(job: ShipQueueJob): string | null {
  if (job.prUrl?.trim()) {
    try {
      const url = new URL(job.prUrl.trim());
      if (url.protocol === "https:" || url.protocol === "http:") {
        return url.toString();
      }
    } catch {
      return null;
    }
    return null;
  }
  const prNum = job.pr ? String(job.pr).trim() : "";
  if (job.prRepo && prNum && SAFE_GH_REPO_RE.test(job.prRepo) && SAFE_PR_NUM_RE.test(prNum)) {
    return `https://github.com/${job.prRepo}/pull/${prNum}`;
  }
  return null;
}

export function parseShipJobStartMs(job: ShipQueueJob): number | null {
  if (job.submittedAt) {
    const parsed = Date.parse(job.submittedAt);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (job.key) {
    const match = JOB_KEY_EPOCH_RE.exec(job.key);
    if (match?.[1]) {
      const sec = Number(match[1]);
      if (Number.isFinite(sec) && sec > 0) return sec * 1000;
    }
  }
  return null;
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
  const marker = job.lastMarker ?? "";
  const atMatch = MARKER_AT_RE.exec(marker);
  if (atMatch?.[1]) {
    const endMs = Date.parse(atMatch[1]);
    if (Number.isFinite(endMs) && endMs >= startMs) {
      return formatDurationSeconds((endMs - startMs) / 1000);
    }
  }
  return null;
}

export function formatShipWhenStamp(raw: string | undefined, nowMs: number): string {
  if (!raw) return "";
  const ts = Date.parse(raw);
  if (!Number.isFinite(ts)) return "";
  const d = new Date(ts);
  const now = new Date(nowMs);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) return `${hh}:${mm}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
}

export function extractShipIssueRefs(
  job: ShipQueueJob,
): ReadonlyArray<{ readonly num: number; readonly url: string | null }> {
  const haystack = `${job.branch ?? ""} ${job.title ?? ""}`;
  const found = new Set<number>();
  const re = /(?:issue[-_#\s]?|#|fixes\s+#|closes\s+#)(\d{1,6})\b/giu;
  for (const match of haystack.matchAll(re)) {
    const n = Number(match[1]);
    if (Number.isInteger(n) && n > 0 && String(n) !== (job.pr ?? "")) {
      found.add(n);
    }
  }
  const safeRepo = job.prRepo && SAFE_GH_REPO_RE.test(job.prRepo) ? job.prRepo : null;
  return [...found].slice(0, 3).map((num) => ({
    num,
    url: safeRepo ? `https://github.com/${safeRepo}/issues/${num}` : null,
  }));
}

function formatActiveCiDetail(
  waiting: string | undefined,
  marker: string | undefined,
  resolve: MessageResolver,
): string | undefined {
  const w = waiting?.trim();
  if (w) return w;
  const raw = marker?.trim();
  if (!raw) return undefined;
  const rebased = MARKER_REBASED_RE.exec(raw);
  if (rebased?.[1]) {
    return resolve(msg("rebased {sha}", { sha: rebased[1].slice(0, 7) }));
  }
  if (/^STARTED\b/iu.test(raw)) return undefined;
  if (/^WAITING_WATCHER\b/iu.test(raw)) return resolve(msg("waiting for watcher"));
  return raw;
}

export function resolveShipJobDisplayState(job: ShipQueueJob): string {
  const raw = (job.displayState ?? job.state ?? "unknown").trim();
  const lower = raw.toLowerCase();
  const stageLower = (job.stage ?? "").trim().toLowerCase();
  const syncExit = job.syncExit ?? null;
  if (isShipQueueJobLive(job)) {
    if (stageLower === "deployed" || syncExit === 0) {
      return "post-merge";
    }
    const marker = (job.lastMarker ?? "").trim();
    if (
      syncExit === null &&
      (stageLower === "deploy" ||
        stageLower === "deploying" ||
        /^POST_MERGE\b/iu.test(marker) ||
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
  if (/fail|error|refus|cancel/u.test(s)) return "error";
  if (/done|merged|pass/u.test(s)) return "success";
  if (/wait|queue|park|hold|root|approv/u.test(s)) return "warning";
  if (/run|active|ci|merge|deploy|ship|push/u.test(s)) return "info";
  return "outline";
}

export type ShipStepState = "done" | "active" | "waiting" | "failed" | "pending";

export interface DerivedShipStep {
  readonly id: string;
  readonly label: string;
  readonly state: ShipStepState;
  readonly detail?: string | undefined;
  readonly badge?: string | undefined;
  readonly href?: string | undefined;
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
  resolve: MessageResolver = m,
): ReadonlyArray<DerivedShipStep> {
  const rawState = job.state.toLowerCase();
  const isDone = rawState === "done";
  const isFailed = rawState === "failed" || rawState === "cancelled";
  const isQueued = rawState === "queued";
  const isParked = !isDone && !isFailed && Boolean(job.parkedFor);
  const needsRoot =
    !isDone &&
    !isFailed &&
    Boolean(job.needsRootRequest) &&
    Array.isArray(job.needsRootHosts) &&
    job.needsRootHosts.length > 0;
  const marker = job.lastMarker ?? "";
  const reason = job.reason ?? "";

  const pushExit = job.pushExit ?? null;
  const mergeExit = job.mergeExit ?? null;
  const syncExit = job.syncExit ?? null;
  const prUrl = buildSafePrUrl(job);
  const hasPr = Boolean(job.pr?.trim());
  const isRetryingRound2 = rawState === "running" && mergeExit === 75;
  const lowerReason = reason.toLowerCase();
  const isPrFailureReason =
    !lowerReason.startsWith("merge ") &&
    !lowerReason.includes("(merged)") &&
    /(?:^|[\s_-])pr(?:_|\s|$)/iu.test(lowerReason);
  const isFailedPr = isFailed && pushExit === 0 && isPrFailureReason;
  const isFailedRound2BeforeMerge =
    isFailed && mergeExit === 75 && !lowerReason.startsWith("merge ");
  const isFailedRound2Ci =
    isFailedRound2BeforeMerge && !isFailedPr && (pushExit === null || pushExit === 0);

  const reachedPostCi =
    !isFailedRound2Ci && (pushExit !== null || hasPr || mergeExit !== null || isDone);
  const ciPassed = reachedPostCi || (job.ciDone === true && !isFailed);
  const started =
    !isParked &&
    !isQueued &&
    (rawState === "running" ||
      ciPassed ||
      pushExit !== null ||
      hasPr ||
      mergeExit !== null ||
      Boolean(job.routeHost) ||
      marker.startsWith("STARTED") ||
      marker.startsWith("REBASED"));
  const waitingWatcher =
    !isParked &&
    (rawState === "waiting_watcher" ||
      (!started && !isDone && !isFailed && marker.startsWith("WAITING_WATCHER")));

  const states: ShipStepState[] = [
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
    // Keep PR pending after Round-2 CI failure.
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
    // Keep Merge Gate pending when failure occurred in CI, Push, or Pull Request.
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

  const stageLower = (job.stage ?? "").trim().toLowerCase();
  const hasPostMergeMarker = /^POST_MERGE\b/iu.test(marker.trim()) || job.postMerge === true;
  const hasDeployStep =
    syncExit !== null ||
    stageLower === "deploy" ||
    stageLower === "deploying" ||
    stageLower === "deployed" ||
    hasPostMergeMarker ||
    rawState.startsWith("deploy");

  if (hasDeployStep) {
    if (syncExit !== null && syncExit !== 0) {
      states[6] = "failed";
    } else if (syncExit === 0 || (stageLower === "deployed" && !isFailed)) {
      states[6] = "done";
    } else if (isFailed) {
      states[6] = "failed";
    } else if (!isDone) {
      states[6] = "active";
    }
  }

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

  const steps: DerivedShipStep[] = [
    {
      id: "queued",
      label: labels.queued,
      state: states[0]!,
      detail: isParked
        ? resolve(msg("parked: {reason}", { reason: job.parkedFor ?? "" }))
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
            ? resolve(msg("{count} active", { count: job.watchers }))
            : undefined,
    },
    {
      id: "ci",
      label: labels.ci,
      state: states[2]!,
      badge: job.routeHost,
      detail: needsRoot
        ? resolve(msg("waiting for root grant"))
        : states[2] === "active"
          ? formatActiveCiDetail(job.waiting, marker, resolve)
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
          ? reason || resolve(msg("exit {code}", { code: String(pushExit ?? "") }))
          : undefined,
    },
    {
      id: "pr",
      label: labels.pr,
      state: states[4]!,
      badge: hasPr ? `#${job.pr}` : undefined,
      href: prUrl ?? undefined,
      detail: states[4] === "failed" ? reason || undefined : undefined,
    },
    {
      id: "merge",
      label: labels.merge,
      state: states[5]!,
      detail: isRetryingRound2
        ? resolve(msg("base moved; retrying round 2"))
        : states[5] === "active"
          ? job.waiting || undefined
          : states[5] === "failed"
            ? reason || resolve(msg("exit {code}", { code: String(mergeExit ?? "") }))
            : !hasDeployStep && isFailed && mergeExit === 0
              ? reason || undefined
              : undefined,
    },
  ];

  if (hasDeployStep) {
    steps.push({
      id: "land",
      label: labels.land,
      state: states[6]!,
      detail:
        states[6] === "failed"
          ? reason || resolve(msg("exit {code}", { code: String(syncExit ?? "") }))
          : undefined,
    });
  }
  return steps;
}
