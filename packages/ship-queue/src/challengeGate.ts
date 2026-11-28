// @effect-diagnostics nodeBuiltinImport:off globalDate:off - The playbook challenge as a merge gate: a CHALLENGED review waits for the agent to fix or override.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  appendLog,
  failJob,
  isEnded,
  jobBodyPath,
  jobDir,
  jobReviewPath,
  mark,
  readJob,
  updateJob,
} from "./jobStore.ts";
import { markerValue } from "./markers.ts";
import { releaseRepoLock, tryAcquireRepoLock } from "./processLocks.ts";
import type { Clock, JobRecord, ShipQueueDeps } from "./types.ts";

const MAX_REASON_CHARS = 1_000;

export type ReviewVerdict = "pass" | "challenged" | "none";

/** The report's `PLAYBOOK REVIEW: <label>`: a failing label challenges; no review never does. */
export function reviewVerdict(report: string): ReviewVerdict {
  const label = /^PLAYBOOK REVIEW: (.+)$/m.exec(report)?.[1]?.trim() ?? "";
  if (label === "PASS") return "pass";
  if (label === "CHALLENGED" || label === "REJECTED BUDGET REASON") return "challenged";
  return "none";
}

export const overrideRequestPath = (root: string, id: string) =>
  NodePath.join(jobDir(root, id), "override");

export function isParkedOnChallenge(job: JobRecord): boolean {
  return job.state === "waiting" && job.waiting_for === "challenge";
}

/**
 * `ship-queue override JOB --reason WHY`: the agent ships past its CHALLENGED review. The
 * request is a file beside the job, like a cancel, and the worker takes it on its next tick.
 */
export function requestChallengeOverride(
  root: string,
  id: string,
  rawReason: string,
  clock: Clock,
): { readonly ok: boolean; readonly message: string } {
  const job = readJob(root, id);
  if (!job) return { ok: false, message: `no such job: ${id}` };
  if (isEnded(job)) return { ok: false, message: `job ${id} already ended (${job.state})` };
  if (!isParkedOnChallenge(job)) {
    return { ok: false, message: `job ${id} is not waiting on a CHALLENGED playbook review` };
  }
  const reason = markerValue(rawReason).slice(0, MAX_REASON_CHARS);
  if (!reason) return { ok: false, message: "an override needs a written --reason" };
  NodeFS.writeFileSync(
    overrideRequestPath(root, id),
    `${JSON.stringify({ reason, at: clock.now() })}\n`,
  );
  return {
    ok: true,
    message: `job ${id}: override recorded; it resumes on its own. Follow it: ship-queue watch ${id}`,
  };
}

export function overrideBodySection(reason: string): string {
  return `## Playbook challenge overridden\n\n${reason}\n`;
}

const CHALLENGE_WAIT_MS = 60 * 60_000;

/** `git patch-id` of the job's change on its base: what an override covers, across rebases. */
async function changePatchId(deps: ShipQueueDeps, job: JobRecord, onto: string, tip: string) {
  const res = await deps.run({
    command: "bash",
    args: ["-c", 'git diff --no-color "$1" "$2" | git patch-id --stable', "--", onto, tip],
    cwd: job.worktree,
  });
  return res.exitCode === 0 ? (res.stdout.trim().split(/\s+/)[0] ?? "") : "";
}

/** A PR opened before the override never got the body section, so it gets the reason as a comment. */
export async function postOverrideComment(
  deps: ShipQueueDeps,
  job: JobRecord,
  pr: number,
): Promise<void> {
  const override = job.challenge_override;
  if (!override || !deps.forge.commentOnPullRequest) return;
  const key = `${pr}.${override.at.replace(/[^0-9A-Za-z]/g, "")}`;
  const posted = NodePath.join(jobDir(deps.root, job.id), "work", `override-posted.${key}`);
  if (NodeFS.existsSync(posted)) return;
  try {
    await deps.forge.commentOnPullRequest({
      cwd: job.worktree,
      repo: job.repo,
      number: pr,
      body: overrideBodySection(override.reason),
    });
    NodeFS.mkdirSync(NodePath.dirname(posted), { recursive: true });
    NodeFS.writeFileSync(posted, "");
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    appendLog(deps.root, job.id, `override: could not comment on PR #${pr}: ${why}`);
  }
}

/**
 * Takes a pending override: the job log, the record, and the PR body all carry its reason. The
 * house stages run again, so §16 hygiene reads the body with the reason in it before the PR
 * phase makes it public.
 */
export function takeChallengeOverride(deps: ShipQueueDeps, job: JobRecord): boolean {
  const file = overrideRequestPath(deps.root, job.id);
  let request: { readonly reason?: unknown; readonly at?: unknown };
  try {
    request = JSON.parse(NodeFS.readFileSync(file, "utf8")) as typeof request;
  } catch {
    return false;
  }
  const reason = typeof request.reason === "string" ? markerValue(request.reason) : "";
  NodeFS.rmSync(file, { force: true });
  if (!reason) return false;
  const at = typeof request.at === "string" ? request.at : deps.clock.now();
  const bodyFile = jobBodyPath(deps.root, job.id);
  const body = NodeFS.readFileSync(bodyFile, "utf8").trimEnd();
  NodeFS.writeFileSync(bodyFile, `${body}\n\n${overrideBodySection(reason)}`, "utf8");
  updateJob(deps.root, job.id, {
    challenge_override: { reason, at, patch: job.challenged_patch, comment: Boolean(job.pr) },
    challenged_tip: undefined,
    challenged_patch: undefined,
    house_tip: undefined,
    state: "running",
    waiting_for: undefined,
    waiting_since: undefined,
  });
  mark(deps.root, job.id, `OVERRIDDEN job=${job.id} reason=${reason}`);
  return true;
}

/** A challenged job the agent never answered stops holding its repo's queue. */
export function challengeUnanswered(deps: ShipQueueDeps, job: JobRecord): boolean {
  const since = job.waiting_since ? Date.parse(job.waiting_since) : Number.NaN;
  const now = Date.parse(deps.clock.now());
  return Number.isFinite(since) && Number.isFinite(now) && now - since >= CHALLENGE_WAIT_MS;
}

/**
 * After the review: a CHALLENGED verdict parks the job, unless the agent overrode a review of
 * this same change (a rebase keeps it; a new commit does not). Anything else, a missing review
 * included, goes on.
 */
export async function challengeGate(
  deps: ShipQueueDeps,
  job: JobRecord,
  rebase: { readonly onto: string; readonly head: string },
): Promise<"go" | "wait"> {
  const reportPath = jobReviewPath(deps.root, job.id);
  let report = "";
  try {
    report = NodeFS.readFileSync(reportPath, "utf8");
  } catch {
    return "go";
  }
  if (reviewVerdict(report) !== "challenged") return "go";
  const patch = await changePatchId(deps, job, rebase.onto, rebase.head);
  const override = job.challenge_override;
  if (override && patch && override.patch === patch) {
    appendLog(
      deps.root,
      job.id,
      `playbook review CHALLENGED ${rebase.head.slice(0, 12)}; shipping on the agent's override: ${override.reason}`,
    );
    return "go";
  }
  updateJob(deps.root, job.id, {
    state: "waiting",
    waiting_for: "challenge",
    waiting_since: deps.clock.now(),
    challenged_tip: rebase.head,
    challenged_patch: patch || undefined,
  });
  mark(deps.root, job.id, `CHALLENGED job=${job.id} report=${reportPath}`);
  return "wait";
}

/**
 * A resubmit of a challenged job's branch replaces it: the old job ends under its repo's landing
 * lock, so no worker is advancing it meanwhile. False when another worker holds the lock.
 */
export function supersedeChallengedJob(deps: ShipQueueDeps, job: JobRecord): boolean {
  if (!tryAcquireRepoLock(deps.root, job.repo, deps.self, deps.isProcessAlive)) return false;
  try {
    const fresh = readJob(deps.root, job.id);
    if (!fresh || isEnded(fresh)) return true;
    if (!isParkedOnChallenge(fresh)) return false;
    appendLog(deps.root, job.id, `superseded by a new submit of ${job.branch}`);
    failJob(deps.root, job.id, "superseded", deps.clock);
    return true;
  } finally {
    releaseRepoLock(deps.root, job.repo, deps.self);
  }
}
