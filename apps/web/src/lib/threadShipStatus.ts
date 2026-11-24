import type { ShipQueueJob } from "@t3tools/contracts";

import { isShipQueueJobLive, parseShipJobStartMs } from "./shipQueueSteps";

const DEFAULT_BRANCHES = new Set(["main", "master", "develop", "HEAD"]);
const MARKER_AT_RE = /\bat=(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:[+-]\d{2}:?\d{2}|Z)?)/u;
const DEFAULT_SHIP_LINGER_MS = 5 * 60 * 1000;

export type ThreadShipPhase = "shipping" | "deploying";

export interface ThreadShipStatus {
  readonly phase: ThreadShipPhase;
  readonly startedAt: string | null;
}

export function normalizeDirectoryPath(path: string | null | undefined): string {
  return path ? path.replace(/\/+$/u, "") : "";
}

function repoHintFromPaths(gitCwd: string, dedicatedWorktree: string): string {
  const path = gitCwd || dedicatedWorktree;
  if (!path) return "";
  const parts = path.split("/").filter(Boolean);
  return (parts[parts.length - 1] ?? "").toLowerCase();
}

export function matchThreadShipJobs(
  jobs: ReadonlyArray<ShipQueueJob>,
  threadId: string,
  branch: string | null,
  dedicatedWorktree: string,
  gitCwd: string,
): ReadonlyArray<ShipQueueJob> {
  const repoHint = repoHintFromPaths(gitCwd, dedicatedWorktree);
  return jobs.filter((job) => {
    if (job.threadId) return job.threadId === threadId;
    if (
      dedicatedWorktree &&
      job.worktree &&
      normalizeDirectoryPath(job.worktree) === dedicatedWorktree
    ) {
      return true;
    }
    if (branch && !DEFAULT_BRANCHES.has(branch) && job.branch === branch) {
      const jobPrimary = normalizeDirectoryPath(job.primary);
      if (jobPrimary && gitCwd) {
        return jobPrimary === gitCwd;
      }
      if (!repoHint) return true;
      const jobRepo = (job.repo ?? "").toLowerCase();
      return jobRepo === repoHint || jobRepo.endsWith(`/${repoHint}`);
    }
    return false;
  });
}

function resolveJobStartedAt(job: ShipQueueJob): string | null {
  const startMs = parseShipJobStartMs(job);
  return startMs !== null ? new Date(startMs).toISOString() : null;
}

function resolveShipJobPhase(job: ShipQueueJob): ThreadShipPhase | null {
  if (!isShipQueueJobLive(job)) return null;
  const rawState = job.state.trim().toLowerCase();
  const rawDisplay = (job.displayState ?? "").trim().toLowerCase();
  const rawStage = (job.stage ?? "").trim().toLowerCase();
  if ((job.syncExit ?? null) === null) {
    const marker = (job.lastMarker ?? "").trim();
    if (
      rawStage === "deploy" ||
      rawStage === "deploying" ||
      /^POST_MERGE\b/iu.test(marker) ||
      rawState === "deploy" ||
      rawState === "deploying" ||
      rawDisplay === "deploy" ||
      rawDisplay === "deploying"
    ) {
      return "deploying";
    }
  }
  return "shipping";
}

export function resolveThreadShipStatus(input: {
  readonly jobs: ReadonlyArray<ShipQueueJob>;
  readonly threadId: string;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly gitCwd: string | null;
}): ThreadShipStatus | null {
  const matched = matchThreadShipJobs(
    input.jobs,
    input.threadId,
    input.branch,
    normalizeDirectoryPath(input.worktreePath),
    normalizeDirectoryPath(input.gitCwd),
  );
  let shippingJob: ShipQueueJob | null = null;
  for (const job of matched) {
    const phase = resolveShipJobPhase(job);
    if (phase === "deploying") {
      return { phase: "deploying", startedAt: resolveJobStartedAt(job) };
    }
    if (phase === "shipping" && shippingJob === null) {
      shippingJob = job;
    }
  }
  if (shippingJob !== null) {
    return { phase: "shipping", startedAt: resolveJobStartedAt(shippingJob) };
  }
  return null;
}

export function shipJobKey(job: ShipQueueJob): string {
  return job.id || job.key || `${job.repo ?? "repo"}:${job.branch ?? "job"}`;
}

function resolveShipJobCompletedMs(job: ShipQueueJob): number | null {
  const marker = job.lastMarker ?? "";
  const atMatch = MARKER_AT_RE.exec(marker);
  if (atMatch?.[1]) {
    const endMs = Date.parse(atMatch[1]);
    if (Number.isFinite(endMs)) return endMs;
  }
  return parseShipJobStartMs(job);
}

function isShipJobCancelled(job: ShipQueueJob): boolean {
  const state = (job.state || job.displayState || "").trim().toLowerCase();
  if (state === "cancelled") return true;
  const reason = (job.reason ?? "").trim().toLowerCase();
  if (reason.startsWith("cancelled")) return true;
  return /^FAILED\s+reason=cancelled\b/iu.test((job.lastMarker ?? "").trim());
}

function isShipJobFailed(job: ShipQueueJob): boolean {
  if (isShipJobCancelled(job)) return false;
  const state = (job.state || job.displayState || "").trim().toLowerCase();
  return state === "failed" || state.includes("fail");
}

function isShipJobDone(job: ShipQueueJob): boolean {
  const state = (job.state || job.displayState || "").trim().toLowerCase();
  return state === "done" || state === "merged";
}

function shipJobRecencyMs(job: ShipQueueJob): number {
  return resolveShipJobCompletedMs(job) ?? parseShipJobStartMs(job) ?? 0;
}

export function selectVisibleThreadShipJobs(
  threadJobs: ReadonlyArray<ShipQueueJob>,
  nowMs: number,
  dismissedKeys?: ReadonlySet<string>,
  lingerMs: number = DEFAULT_SHIP_LINGER_MS,
): {
  readonly jobs: ReadonlyArray<ShipQueueJob>;
  readonly lingerUntilMs: number | null;
} {
  if (threadJobs.length === 0) return { jobs: [], lingerUntilMs: null };
  const live = threadJobs
    .filter(isShipQueueJobLive)
    .toSorted((a, b) => (parseShipJobStartMs(b) ?? 0) - (parseShipJobStartMs(a) ?? 0));
  if (live.length > 0) return { jobs: live, lingerUntilMs: null };

  const latest = threadJobs.toSorted((a, b) => shipJobRecencyMs(b) - shipJobRecencyMs(a))[0];
  if (!latest) return { jobs: [], lingerUntilMs: null };
  if (dismissedKeys?.has(shipJobKey(latest))) return { jobs: [], lingerUntilMs: null };
  if (isShipJobCancelled(latest)) return { jobs: [], lingerUntilMs: null };
  if (isShipJobFailed(latest)) return { jobs: [latest], lingerUntilMs: null };
  if (isShipJobDone(latest) && lingerMs > 0) {
    const completedMs = resolveShipJobCompletedMs(latest);
    if (completedMs !== null && nowMs < completedMs + lingerMs) {
      return { jobs: [latest], lingerUntilMs: completedMs + lingerMs };
    }
  }
  return { jobs: [], lingerUntilMs: null };
}

export function addBoundedDismiss(set: Set<string>, key: string): ReadonlySet<string> {
  set.add(key);
  while (set.size > 200) {
    const first = set.values().next().value;
    if (first === undefined) break;
    set.delete(first);
  }
  return new Set(set);
}
