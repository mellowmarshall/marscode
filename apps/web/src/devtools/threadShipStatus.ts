/**
 * Resolves live ship-queue status ("shipping" vs "deploying") for a single T3 thread.
 */
import type { DevdeckSessionItem, ShipQueueJob } from "./devtoolsClient";
import { isJobLive, type JobSummary } from "./jobs/jobTypes";
import { parseShipJobStartMs, resolveShipJobEndMs } from "./shipJobTiming";
import { isShipQueueJobLive } from "./ShipQueueSteps";

const DEFAULT_BRANCHES = new Set(["main", "master", "develop", "HEAD"]);
const DEFAULT_JOB_DONE_LINGER_MS = 5 * 60 * 1000;

export type ThreadShipPhase = "shipping" | "deploying" | "hold";

export interface ThreadShipStatus {
  readonly phase: ThreadShipPhase;
  readonly startedAt: string | null;
}

function normPath(p: string | null | undefined): string {
  if (!p) return "";
  return p.replace(/\/+$/, "");
}

function baseName(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx === -1 ? p : p.slice(idx + 1);
}

function repoHintFromPaths(gitCwd: string, dedicatedWorktree: string): string {
  if (gitCwd) return baseName(gitCwd).toLowerCase();
  if (dedicatedWorktree) return baseName(dedicatedWorktree).toLowerCase();
  return "";
}

export function matchThreadJobs(
  jobs: ReadonlyArray<ShipQueueJob>,
  threadId: string,
  branch: string | null,
  dedicatedWorktree: string,
  gitCwd: string,
): ReadonlyArray<ShipQueueJob> {
  const repoHint = repoHintFromPaths(gitCwd, dedicatedWorktree);
  return jobs.filter((job) => {
    if (job.thread_id) return job.thread_id === threadId;
    if (dedicatedWorktree && job.worktree && normPath(job.worktree) === dedicatedWorktree) {
      return true;
    }
    if (branch && !DEFAULT_BRANCHES.has(branch) && job.branch === branch) {
      const jobPrimary = normPath(job.primary);
      // When both checkouts have known paths, require an exact checkout match (never leak across twin basenames).
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

function hasSyncExit(job: ShipQueueJob): boolean {
  if (typeof job.sync_exit === "number") return Number.isFinite(job.sync_exit);
  if (typeof job.sync_exit === "string") return job.sync_exit.trim() !== "";
  return false;
}

function resolveJobStartedAt(job: ShipQueueJob): string | null {
  const startMs = parseShipJobStartMs(job);
  if (startMs === null) return null;
  return job.submitted_at && Date.parse(job.submitted_at) === startMs
    ? job.submitted_at
    : new Date(startMs).toISOString();
}

/**
 * Classifies a live ship-queue job into "deploying" (in the repo's post-merge deploy step,
 * between `POST_MERGE job=` and `SYNC_EXIT=`) or "shipping" (any other live phase).
 * Returns `null` for completed, failed, or cancelled jobs.
 */
export function resolveShipJobPhase(job: ShipQueueJob): ThreadShipPhase | null {
  if (!isShipQueueJobLive(job)) return null;
  if ((job.waiting_for ?? "").trim().toLowerCase() === "challenge") return "hold";
  const rawState = (job.state ?? "").trim().toLowerCase();
  const rawDisplay = (job.display_state ?? "").trim().toLowerCase();
  const rawStage = (job.stage ?? "").trim().toLowerCase();
  if (!hasSyncExit(job)) {
    const marker = (job.last_marker ?? "").trim();
    if (
      rawStage === "deploy" ||
      rawStage === "deploying" ||
      /^POST_MERGE\b/i.test(marker) ||
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
  const matched = matchThreadJobs(
    input.jobs,
    input.threadId,
    input.branch,
    normPath(input.worktreePath),
    normPath(input.gitCwd),
  );
  let holdJob: ShipQueueJob | null = null;
  let shippingJob: ShipQueueJob | null = null;
  for (const job of matched) {
    const phase = resolveShipJobPhase(job);
    if (phase === "deploying") {
      return { phase: "deploying", startedAt: resolveJobStartedAt(job) };
    }
    if (phase === "hold" && holdJob === null) {
      holdJob = job;
    } else if (phase === "shipping" && shippingJob === null) {
      shippingJob = job;
    }
  }
  if (holdJob !== null) {
    return { phase: "hold", startedAt: resolveJobStartedAt(holdJob) };
  }
  if (shippingJob !== null) {
    return { phase: "shipping", startedAt: resolveJobStartedAt(shippingJob) };
  }
  return null;
}

export function shipJobKey(job: ShipQueueJob): string {
  return job.id || job.key || `${job.repo ?? "repo"}:${job.branch ?? "job"}`;
}

/** A finished job's end (`ended_at`, else its marker's zoned `at=`), else its start. */
function resolveShipJobCompletedMs(job: ShipQueueJob): number | null {
  return resolveShipJobEndMs(job) ?? parseShipJobStartMs(job);
}

function isShipJobCancelled(job: ShipQueueJob): boolean {
  const state = (job.state ?? job.display_state ?? "").trim().toLowerCase();
  if (state === "cancelled") return true;
  const reason = (job.reason ?? "").trim().toLowerCase();
  if (reason.startsWith("cancelled")) return true;
  return /^FAILED\s+reason=cancelled\b/i.test((job.last_marker ?? "").trim());
}

function isShipJobFailed(job: ShipQueueJob): boolean {
  if (isShipJobCancelled(job)) return false;
  const state = (job.state ?? job.display_state ?? "").trim().toLowerCase();
  return state === "failed" || state.includes("fail");
}

function isShipJobDone(job: ShipQueueJob): boolean {
  const state = (job.state ?? job.display_state ?? "").trim().toLowerCase();
  return state === "done" || state === "merged";
}

function shipJobRecencyMs(job: ShipQueueJob): number {
  return resolveShipJobCompletedMs(job) ?? 0;
}

/** Returns live thread ship jobs, else the latest failed job (until dismissed) or done job for 5m. */
export function selectVisibleThreadShipJobs(
  threadJobs: ReadonlyArray<ShipQueueJob>,
  nowMs: number,
  dismissedKeys?: ReadonlySet<string>,
  lingerMs: number = DEFAULT_JOB_DONE_LINGER_MS,
): {
  readonly jobs: ReadonlyArray<ShipQueueJob>;
  readonly lingerUntilMs: number | null;
} {
  if (threadJobs.length === 0) return { jobs: [], lingerUntilMs: null };
  const live = threadJobs
    .filter(isShipQueueJobLive)
    .toSorted((a, b) => shipJobRecencyMs(b) - shipJobRecencyMs(a));
  if (live.length > 0) return { jobs: live, lingerUntilMs: null };
  const latest = threadJobs.toSorted((a, b) => shipJobRecencyMs(b) - shipJobRecencyMs(a))[0];
  if (!latest || dismissedKeys?.has(shipJobKey(latest))) return { jobs: [], lingerUntilMs: null };
  if (isShipJobFailed(latest)) return { jobs: [latest], lingerUntilMs: null };
  if (isShipJobDone(latest) && lingerMs > 0) {
    const completedMs = resolveShipJobCompletedMs(latest);
    if (completedMs !== null && nowMs < completedMs + lingerMs) {
      return { jobs: [latest], lingerUntilMs: completedMs + lingerMs };
    }
  }
  return { jobs: [], lingerUntilMs: null };
}

/** Returns live MCP jobs for the thread, else the latest failed/exited (until dismissed) or done job for 5m. */
export function selectVisibleThreadManagedJobs(
  threadJobs: ReadonlyArray<JobSummary>,
  nowMs: number,
  dismissedIds?: ReadonlySet<string>,
  lingerMs: number = DEFAULT_JOB_DONE_LINGER_MS,
): {
  readonly jobs: ReadonlyArray<JobSummary>;
  readonly lingerUntilMs: number | null;
  readonly hiddenLiveCount: number;
} {
  if (threadJobs.length === 0) return { jobs: [], lingerUntilMs: null, hiddenLiveCount: 0 };
  const live = threadJobs
    .filter(isJobLive)
    .toSorted((a, b) => Date.parse(b.timing.startedAt) - Date.parse(a.timing.startedAt));
  if (live.length > 0) {
    return {
      jobs: live.slice(0, 3),
      lingerUntilMs: null,
      hiddenLiveCount: Math.max(0, live.length - 3),
    };
  }
  const latest = threadJobs.toSorted(
    (a, b) =>
      Date.parse(b.timing.endedAt ?? b.timing.startedAt) -
      Date.parse(a.timing.endedAt ?? a.timing.startedAt),
  )[0];
  if (!latest || dismissedIds?.has(latest.id)) {
    return { jobs: [], lingerUntilMs: null, hiddenLiveCount: 0 };
  }
  if (latest.state === "cancelled") {
    return { jobs: [], lingerUntilMs: null, hiddenLiveCount: 0 };
  }
  if (latest.state === "failed" || (latest.state === "exited" && Boolean(latest.anomaly))) {
    return { jobs: [latest], lingerUntilMs: null, hiddenLiveCount: 0 };
  }
  if ((latest.state === "done" || latest.state === "exited") && lingerMs > 0) {
    const endMs = Date.parse(latest.timing.endedAt ?? latest.timing.startedAt);
    if (Number.isFinite(endMs) && nowMs < endMs + lingerMs) {
      return { jobs: [latest], lingerUntilMs: endMs + lingerMs, hiddenLiveCount: 0 };
    }
  }
  return { jobs: [], lingerUntilMs: null, hiddenLiveCount: 0 };
}

function isPathInside(candidate: string | undefined, root: string): boolean {
  if (!candidate || !root) return false;
  const c = normPath(candidate);
  return c === root || c.startsWith(`${root}/`);
}

export function isActionableDevdeckSession(s: DevdeckSessionItem): boolean {
  const managed = (s.managed ?? "").trim().toLowerCase();
  const kind = (s.kind ?? "").trim().toLowerCase();
  const name = (s.name ?? "").trim().toLowerCase();
  // Filter out non-actionable passive "Observed" background daemon stubs.
  if (
    !s.close_allowed &&
    (managed === "observed" || kind === "observed" || name.startsWith("observed"))
  ) {
    return false;
  }
  return true;
}

export function matchThreadSessions(
  sessions: ReadonlyArray<DevdeckSessionItem>,
  branch: string | null,
  dedicatedWorktree: string,
  gitCwd: string,
): ReadonlyArray<DevdeckSessionItem> {
  const repoHint = repoHintFromPaths(gitCwd, dedicatedWorktree);
  return sessions.filter((s) => {
    if (!isActionableDevdeckSession(s)) return false;
    if (dedicatedWorktree && s.cwd && isPathInside(s.cwd, dedicatedWorktree)) return true;
    if (branch && !DEFAULT_BRANCHES.has(branch) && s.branch === branch) {
      if (s.cwd && gitCwd) return isPathInside(s.cwd, gitCwd);
      if (!repoHint) return false;
      const proj = (s.project ?? "").toLowerCase();
      return proj === repoHint || proj.endsWith(`/${repoHint}`);
    }
    return false;
  });
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

export function formatCompactMem(bytes: number | undefined): string {
  if (!bytes || !Number.isFinite(bytes)) return "";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)}G`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)}M`;
  return `${Math.round(bytes / 1024)}K`;
}

export function normalizeDirectoryPath(path: string | null | undefined): string {
  return path ? path.replace(/\/+$/, "") : "";
}
