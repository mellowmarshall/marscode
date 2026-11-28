// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Serialized per-repo merge queue: one job of a repo lands at a time, in submit order.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { cleanupMergedJob } from "./cleanup.ts";
import { houseStages, protectedDiffDigest } from "./houseGate.ts";
import {
  appendLog,
  cancelRequested,
  endJob,
  failJob,
  hasLiveWatcher,
  isEnded,
  jobBodyPath,
  jobDir,
  jobReviewPath,
  listJobIds,
  mark,
  readJob,
  requestCancel,
  requireJob,
  updateJob,
} from "./jobStore.ts";
import { markerValue } from "./markers.ts";
import { runPostMergeSync } from "./postMergeSync.ts";
import { mergePhase, postReviewComment, pullRequestPhase, pushPhase } from "./prFlow.ts";
import { sameProcess } from "./processIdentity.ts";
import { releaseRepoLock, repoLockHolder, tryAcquireRepoLock } from "./processLocks.ts";
import { rebaseJob } from "./rebaseEngine.ts";
import type { JobRecord, ShipQueueDeps } from "./types.ts";
import { jobMatchesWorkerVersion, readCurrentWorkerVersion } from "./workerVersion.ts";

export type JobStep = "ended" | "blocked";

export interface DueWorkResult {
  readonly ended: ReadonlyArray<string>;
  readonly blocked: ReadonlyArray<string>;
  /** Repos whose landing lock another live worker holds. */
  readonly busyRepos: ReadonlyArray<string>;
}

/** How often a job parked on an owner action re-checks its grant (read-only) on the worker's tick. */
const ACTION_RECHECK_MS = 10_000;
const lastActionCheck = new Map<string, string>();

/**
 * A parked job resumes on its own once the owner's grant lands: the worker peeks (never
 * consumes) the grant for the digest it waits on, so no watch re-arm is needed and no rebase
 * runs while nothing changed.
 */
async function ownerActionGranted(deps: ShipQueueDeps, job: JobRecord): Promise<boolean> {
  const now = deps.clock.now();
  const last = lastActionCheck.get(job.id);
  if (last !== undefined && elapsedMs(last, now) < ACTION_RECHECK_MS) return false;
  lastActionCheck.set(job.id, now);
  if (!job.rebased_onto || !job.action_digest) return true;
  const bundle = deps.guard.inspect({
    worktree: job.worktree,
    branch: job.branch,
    baseRef: job.rebased_onto,
  });
  if (!bundle || protectedDiffDigest(bundle) !== job.action_digest) return true;
  const grant = await deps.guard.check({
    worktree: job.worktree,
    branch: job.branch,
    bundle,
    jobId: job.id,
    consume: false,
  });
  if (grant.ok) lastActionCheck.delete(job.id);
  return grant.ok;
}

function elapsedMs(from: string | undefined, to: string): number {
  const a = from ? Date.parse(from) : Number.NaN;
  const b = Date.parse(to);
  return Number.isFinite(a) && Number.isFinite(b) ? b - a : 0;
}

/** Open jobs grouped by repo, each group in submit (id) order. */
export function openJobsByRepo(root: string): Map<string, JobRecord[]> {
  const byRepo = new Map<string, JobRecord[]>();
  for (const id of listJobIds(root, { open: true })) {
    const job = readJob(root, id);
    if (!job || isEnded(job)) continue;
    byRepo.set(job.repo, [...(byRepo.get(job.repo) ?? []), job]);
  }
  return byRepo;
}

/** Whether any open job in `root` is eligible to be advanced by a worker running `selfVersion`. */
export function hasOpenJobsForWorker(
  root: string,
  selfVersion?: string | undefined,
  currentVersion?: string | undefined,
): boolean {
  const effectiveCurrent = currentVersion ?? readCurrentWorkerVersion(root)?.version;
  for (const jobs of openJobsByRepo(root).values()) {
    for (const job of jobs) {
      if (jobMatchesWorkerVersion(job, selfVersion, effectiveCurrent)) return true;
    }
  }
  return false;
}

async function awaitWatcher(deps: ShipQueueDeps, job: JobRecord): Promise<JobStep | "go"> {
  if (hasLiveWatcher(deps.root, job.id, deps.isProcessAlive)) {
    if (job.waiting_for === "watcher" && job.state !== "queued") {
      mark(deps.root, job.id, `WATCHER_BACK job=${job.id} at=${deps.clock.now()}`);
    }
    return "go";
  }
  const now = deps.clock.now();
  if (job.waiting_for !== "watcher") {
    const seconds = Math.round(deps.watcherWaitMs / 1000);
    mark(deps.root, job.id, `WAITING_WATCHER job=${job.id} (up to ${seconds}s)`);
    updateJob(deps.root, job.id, { waiting_for: "watcher", waiting_since: now });
    return "blocked";
  }
  if (elapsedMs(job.waiting_since, now) >= deps.watcherWaitMs) {
    failJob(deps.root, job.id, "no_watcher", deps.clock);
    return "ended";
  }
  return "blocked";
}

async function runMergedHooks(deps: ShipQueueDeps, job: JobRecord, pr: number): Promise<void> {
  for (const hook of deps.onMerged ?? []) {
    try {
      await hook({ job, pr });
    } catch (err) {
      appendLog(
        deps.root,
        job.id,
        `post-merge hook failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/** After the merge a cancel or a lost watcher can undo nothing: cleanup, hooks, then DONE. */
async function finishMergedJob(
  deps: ShipQueueDeps,
  job: JobRecord,
  pr: number,
  pushedTip: string,
): Promise<JobStep> {
  const cleanup = await cleanupMergedJob(deps.run, deps.root, job, pushedTip);
  if (cleanup.log.length > 0) appendLog(deps.root, job.id, cleanup.log.join("\n"));
  for (const line of cleanup.markers) mark(deps.root, job.id, line);
  if (cleanup.remoteLeft) {
    failJob(deps.root, job.id, `remote_branch_left pr=${pr} (merged)`, deps.clock);
    return "ended";
  }
  await runPostMergeSync(deps, requireJob(deps.root, job.id), pr);
  await runMergedHooks(deps, requireJob(deps.root, job.id), pr);
  endJob(
    deps.root,
    job.id,
    { state: "done", line: `DONE job=${job.id} pr=${pr} at=${deps.clock.now()}` },
    deps.clock,
  );
  return "ended";
}

/**
 * Whether a job's PR already landed: its record says so, or the forge does. The forge covers a
 * worker that died between the merge and recording it; a forge it cannot ask leaves it waiting.
 */
async function mergedAlready(deps: ShipQueueDeps, job: JobRecord): Promise<boolean | null> {
  if (!job.pr) return false;
  if (job.merge_exit === 0) return true;
  try {
    return await deps.forge.isPullRequestMerged({
      cwd: job.primary,
      repo: job.repo,
      number: job.pr,
    });
  } catch (err) {
    appendLog(
      deps.root,
      job.id,
      `cannot read the state of PR #${job.pr}; retrying: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/** Advances one job as far as it can go now: to its end, or to a wait (watcher, owner action). */
export async function runJob(deps: ShipQueueDeps, id: string): Promise<JobStep> {
  let job = requireJob(deps.root, id);
  if (isEnded(job)) return "ended";
  const merged = await mergedAlready(deps, job);
  if (merged === null) return "blocked";
  const mergedPr = merged ? job.pr : undefined;
  if (mergedPr) {
    if (job.merge_exit !== 0) {
      appendLog(deps.root, id, `PR #${mergedPr} merged before this worker recorded it; recovering`);
      job = updateJob(deps.root, id, { merge_exit: 0 });
      mark(deps.root, id, "MERGE_EXIT=0");
    }
    return finishMergedJob(deps, job, mergedPr, job.pushed_sha ?? job.head_sha);
  }
  const cancelled = () => {
    if (!cancelRequested(deps.root, id)) return false;
    failJob(deps.root, id, "cancelled", deps.clock);
    return true;
  };
  const stop = (reason: string): JobStep => {
    if (!cancelled()) failJob(deps.root, id, reason, deps.clock);
    return "ended";
  };
  if (cancelled()) return "ended";

  // The watch that started the job exits on ACTION_REQUIRED by design; the owner's approval
  // (and the thread notice the broker sends) is what resumes it, not a re-armed watch.
  const parkedOnAction = job.state === "waiting" && job.waiting_for === "action";
  if (parkedOnAction) {
    if (!(await ownerActionGranted(deps, job))) return "blocked";
    appendLog(deps.root, id, `owner approval landed at ${deps.clock.now()}; resuming`);
  } else {
    const watcher = await awaitWatcher(deps, job);
    if (watcher !== "go") return watcher;
  }
  if (job.state === "queued") {
    const versionPatch =
      deps.workerVersion && (!job.worker_version || !job.worker_entry)
        ? {
            worker_version: deps.workerVersion.version,
            worker_entry: deps.workerVersion.entryPath,
          }
        : {};
    job = updateJob(deps.root, id, {
      state: "running",
      waiting_for: undefined,
      waiting_since: undefined,
      worker: deps.self,
      ...versionPatch,
    });
    mark(deps.root, id, `STARTED job=${id} branch=${job.branch} at=${deps.clock.now()}`);
  }

  const rebase = await rebaseJob(deps.run, deps.root, job);
  if (!rebase.ok) {
    appendLog(deps.root, id, rebase.detail);
    const files = rebase.conflicts.length > 0 ? ` files=${rebase.conflicts.join(",")}` : "";
    return stop(`${rebase.reason}${files}`);
  }
  if (job.rebased_onto !== rebase.onto || job.waiting_for !== "action") {
    mark(deps.root, id, `REBASED ${markerValue(rebase.oneline)}`);
  }
  job = updateJob(deps.root, id, { rebased_onto: rebase.onto });
  if (cancelled()) return "ended";

  const outFile = jobReviewPath(deps.root, id);
  const workDir = NodePath.join(jobDir(deps.root, id), "work");
  const reviewTipPath = NodePath.join(workDir, "review-tip");
  const priorTip = (() => {
    try {
      return NodeFS.readFileSync(reviewTipPath, "utf8").trim();
    } catch {
      return "";
    }
  })();
  if (priorTip && priorTip !== rebase.head) {
    NodeFS.rmSync(outFile, { force: true });
    NodeFS.rmSync(reviewTipPath, { force: true });
  }

  const house = await houseStages(deps, job, rebase.onto);
  if (house.kind === "fail") return stop(house.reason);
  if (house.kind === "action") {
    updateJob(deps.root, id, { state: "waiting", waiting_for: "action" });
    return "blocked";
  }
  job = updateJob(deps.root, id, { state: "running", waiting_for: undefined, worker: deps.self });
  if (cancelled()) return "ended";

  const alreadyReviewed = priorTip === rebase.head && NodeFS.existsSync(outFile);
  const challengePromise: Promise<void> =
    deps.declarationChallenge && !alreadyReviewed
      ? (async () => {
          NodeFS.rmSync(outFile, { force: true });
          try {
            const challenge = await deps.declarationChallenge!({
              jobId: id,
              worktree: job.worktree,
              baseSha: rebase.onto,
              tipSha: rebase.head,
              bodyFile: jobBodyPath(deps.root, id),
              outFile,
              threadId: job.thread_id,
            });
            if (challenge.output) appendLog(deps.root, id, challenge.output);
          } catch (err) {
            const why = err instanceof Error ? err.message : String(err);
            appendLog(deps.root, id, `house declaration-challenge: advisory (${why})`);
            if (!NodeFS.existsSync(outFile)) {
              NodeFS.writeFileSync(outFile, `PLAYBOOK REVIEW: NOT RUN\n  ${why}\n`, "utf8");
            }
          } finally {
            NodeFS.mkdirSync(workDir, { recursive: true });
            NodeFS.writeFileSync(reviewTipPath, `${rebase.head}\n`, "utf8");
          }
        })()
      : Promise.resolve();

  const push = await pushPhase(deps, job, rebase.head, rebase.remoteTip);
  if (!push.ok) {
    await challengePromise;
    return stop(push.reason);
  }
  if (cancelled()) {
    await challengePromise;
    return "ended";
  }

  const pr = await pullRequestPhase(deps, requireJob(deps.root, id));
  await challengePromise;
  if (!pr.ok) return stop(pr.reason);
  await postReviewComment(deps, requireJob(deps.root, id), pr.value, rebase.head);
  if (cancelled()) return "ended";

  const merge = await mergePhase(deps, requireJob(deps.root, id), pr.value, rebase.head);
  if (!merge.ok) return stop(merge.reason);

  return finishMergedJob(deps, requireJob(deps.root, id), pr.value, rebase.head);
}

async function drainRepo(
  deps: ShipQueueDeps,
  repo: string,
  ended: string[],
  blocked: string[],
): Promise<void> {
  const selfVersion = deps.workerVersion?.version;
  for (;;) {
    const head = openJobsByRepo(deps.root).get(repo)?.[0];
    if (!head) return;
    const currentVersion = readCurrentWorkerVersion(deps.root)?.version;
    if (!jobMatchesWorkerVersion(head, selfVersion, currentVersion)) return;
    let step: JobStep;
    try {
      step = await runJob(deps, head.id);
    } catch (err) {
      failJob(
        deps.root,
        head.id,
        `internal: ${err instanceof Error ? err.message : String(err)}`,
        deps.clock,
      );
      step = "ended";
    }
    if (step === "blocked") {
      blocked.push(head.id);
      return;
    }
    ended.push(head.id);
  }
}

/**
 * One pass of due work, shaped for `Scheduler.register`: each repo's queue is drained in order
 * under its landing lock until it empties or its head job waits. Repos run concurrently, and
 * version-pinned workers only advance jobs matching their pinned runtime version.
 */
export async function runDueWork(deps: ShipQueueDeps): Promise<DueWorkResult> {
  const ended: string[] = [];
  const blocked: string[] = [];
  const busyRepos: string[] = [];
  const selfVersion = deps.workerVersion?.version;
  const currentVersion = readCurrentWorkerVersion(deps.root)?.version;
  await Promise.all(
    [...openJobsByRepo(deps.root).entries()].map(async ([repo, jobs]) => {
      const head = jobs[0];
      if (!head || !jobMatchesWorkerVersion(head, selfVersion, currentVersion)) {
        return;
      }
      if (!tryAcquireRepoLock(deps.root, repo, deps.self, deps.isProcessAlive)) {
        busyRepos.push(repo);
        return;
      }
      try {
        await drainRepo(deps, repo, ended, blocked);
      } finally {
        releaseRepoLock(deps.root, repo, deps.self);
      }
    }),
  );
  return { ended, blocked, busyRepos };
}

/**
 * Cancels a job. The flag is written first; the job then ends here only under the repo's landing
 * lock, so no worker runs it meanwhile. A worker holding the lock ends it at its next phase, and a
 * merged job is past cancelling.
 */
export function cancelJob(
  deps: ShipQueueDeps,
  id: string,
): { readonly ok: boolean; readonly message: string } {
  const job = readJob(deps.root, id);
  if (!job) return { ok: false, message: `no such job: ${id}` };
  if (isEnded(job)) return { ok: false, message: `job ${id} already ended (${job.state})` };
  if (job.merge_exit === 0) {
    return { ok: false, message: `job ${id} is merged; it finishes its cleanup and cannot cancel` };
  }
  appendLog(deps.root, id, `cancel requested at ${deps.clock.now()}`);
  requestCancel(deps.root, id);
  const pending = { ok: true, message: `job ${id}: cancel requested; it stops at its next phase` };
  const holder = repoLockHolder(deps.root, job.repo);
  // Inside the worker that holds the lock, the worker itself observes the flag.
  if (holder && sameProcess(holder, deps.self)) return pending;
  if (!tryAcquireRepoLock(deps.root, job.repo, deps.self, deps.isProcessAlive)) return pending;
  try {
    const fresh = readJob(deps.root, id);
    if (!fresh || isEnded(fresh)) return { ok: true, message: `job ${id}: already ended` };
    if (fresh.merge_exit === 0) return pending;
    failJob(deps.root, id, "cancelled", deps.clock);
    return { ok: true, message: `job ${id}: cancelled` };
  } finally {
    releaseRepoLock(deps.root, job.repo, deps.self);
  }
}
