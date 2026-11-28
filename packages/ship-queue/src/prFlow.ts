// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Push, pull request, review comment, and merge phases of a job: each records its exit as a marker.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { postOverrideComment } from "./challengeGate.ts";
import { git } from "./gitQueries.ts";
import { appendLog, jobBodyPath, jobDir, jobReviewPath, mark, updateJob } from "./jobStore.ts";
import { markerValue } from "./markers.ts";
import { runMergeGate } from "./mergeGate.ts";
import { recordPush } from "./rebaseEngine.ts";
import { readBaseDeclaration, runMergeStep } from "./shipSteps.ts";
import type { JobRecord, ShipQueueDeps } from "./types.ts";

const MAX_REVIEW_COMMENT_CHARS = 60_000;

export function formatReviewComment(tipSha: string, jobId: string, reviewText: string): string {
  const body = reviewText.slice(0, MAX_REVIEW_COMMENT_CHARS).trimEnd();
  let fence = "```";
  while (body.includes(fence)) fence += "`";
  return `Playbook review of ${tipSha.slice(0, 12)} (ship-queue job ${jobId}):\n\n${fence}text\n${body}\n${fence}\n`;
}

async function reviewContainsSecret(
  deps: ShipQueueDeps,
  cwd: string,
  text: string,
): Promise<boolean> {
  try {
    const res = await deps.run({
      command: "gitleaks",
      args: ["stdin", "--no-banner", "--redact", "--exit-code", "1"],
      cwd,
      stdin: text,
      timeoutMs: 15_000,
    });
    return res.exitCode === 1;
  } catch {
    return false;
  }
}

/** Posts `declaration-challenge.txt` once per reviewed tip onto the PR (advisory, never fatal). */
export async function postReviewComment(
  deps: ShipQueueDeps,
  job: JobRecord,
  pr: number,
  tipSha: string,
): Promise<void> {
  if (!deps.forge.commentOnPullRequest) return;
  const reviewFile = jobReviewPath(deps.root, job.id);
  let reviewText = "";
  try {
    reviewText = NodeFS.readFileSync(reviewFile, "utf8").trim();
  } catch {
    return;
  }
  if (!reviewText) return;
  const workDir = NodePath.join(jobDir(deps.root, job.id), "work");
  const markerPath = NodePath.join(workDir, `review-posted.${tipSha}`);
  if (NodeFS.existsSync(markerPath)) return;
  if (await reviewContainsSecret(deps, job.worktree, reviewText)) {
    appendLog(deps.root, job.id, `review: withheld from PR #${pr}: secret scanner flagged output`);
    return;
  }
  try {
    await deps.forge.commentOnPullRequest({
      cwd: job.worktree,
      repo: job.repo,
      number: pr,
      body: formatReviewComment(tipSha, job.id, reviewText),
    });
    NodeFS.mkdirSync(workDir, { recursive: true });
    NodeFS.writeFileSync(markerPath, "");
    appendLog(deps.root, job.id, `review: posted on PR #${pr}`);
  } catch (err) {
    appendLog(
      deps.root,
      job.id,
      `review: could not post on PR #${pr}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export type PhaseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string };

/**
 * Pushes the rebased head with a lease on the tip the remote had when the rebase read it, so a
 * push racing someone else's never overwrites their commits.
 */
export async function pushPhase(
  deps: ShipQueueDeps,
  job: JobRecord,
  head: string,
  expectedRemoteTip: string | null,
): Promise<PhaseResult<string>> {
  const lease = `--force-with-lease=refs/heads/${job.branch}:${expectedRemoteTip ?? ""}`;
  const res = await git(deps.run, job.worktree, [
    "push",
    "--porcelain",
    lease,
    job.remote,
    `${head}:refs/heads/${job.branch}`,
  ]);
  appendLog(deps.root, job.id, `${res.stdout}${res.stderr}`);
  updateJob(deps.root, job.id, {
    push_exit: res.exitCode,
    ...(res.exitCode === 0 ? { pushed_sha: head } : {}),
  });
  mark(deps.root, job.id, `PUSH_EXIT=${res.exitCode}`);
  if (res.exitCode !== 0) return { ok: false, reason: "push" };
  recordPush(deps.root, job.repo, job.branch, head);
  return { ok: true, value: head };
}

export async function pullRequestPhase(
  deps: ShipQueueDeps,
  job: JobRecord,
): Promise<PhaseResult<number>> {
  if (job.pr) return { ok: true, value: job.pr };
  try {
    const existing = await deps.forge.findOpenPullRequest({
      cwd: job.worktree,
      repo: job.repo,
      head: job.branch,
    });
    if (existing) await postOverrideComment(deps, job, existing.number);
    const pr =
      existing ??
      (await deps.forge.createPullRequest({
        cwd: job.worktree,
        repo: job.repo,
        head: job.branch,
        base: job.base_branch,
        title: job.title,
        body: NodeFS.readFileSync(jobBodyPath(deps.root, job.id), "utf8"),
      }));
    updateJob(deps.root, job.id, { pr: pr.number });
    mark(deps.root, job.id, `PR=${pr.number}`);
    return { ok: true, value: pr.number };
  } catch (err) {
    appendLog(deps.root, job.id, err instanceof Error ? err.message : String(err));
    return { ok: false, reason: "pr_create" };
  }
}

const MAX_MERGE_RETRIES = 5;
const TRANSIENT_WAIT_MS = 60_000;

export type LandResult =
  | { readonly kind: "merged" }
  | { readonly kind: "retry" }
  | { readonly kind: "fail"; readonly reason: string };

/**
 * Runs the declared `ship_merge_gate`, then merges through the repo's declared `ship_merge` when it
 * has one, else through the forge. A gate waiting for a CI host, or a declared merge's 75 (base
 * moved) or 76 (transient), leaves the job to land again next tick.
 */
export async function landPhase(
  deps: ShipQueueDeps,
  job: JobRecord,
  pr: number,
  rebase: { readonly onto: string; readonly head: string },
): Promise<LandResult> {
  const decl = await readBaseDeclaration(deps, job, rebase.onto);
  if (decl) {
    const gate = await runMergeGate(deps, job, decl, rebase, pr);
    if (gate.kind === "wait") return { kind: "retry" };
    if (gate.kind === "fail") return { kind: "fail", reason: gate.reason };
  }
  if (!decl?.merge.trim()) {
    const merged = await mergePhase(deps, job, pr, rebase.head);
    return merged.ok ? { kind: "merged" } : { kind: "fail", reason: merged.reason };
  }
  const out = await runMergeStep(deps, job, decl, rebase, pr);
  appendLog(deps.root, job.id, out.output);
  if (out.kind === "retry") {
    const retries = (job.merge_retries ?? 0) + 1;
    if (retries > MAX_MERGE_RETRIES) {
      return {
        kind: "fail",
        reason: `merge pr=${pr}: ship_merge exit ${out.exit} ${retries} times`,
      };
    }
    const backoff =
      out.exit === 76
        ? { retry_after: new Date(Date.parse(deps.clock.now()) + TRANSIENT_WAIT_MS).toISOString() }
        : {};
    updateJob(deps.root, job.id, { merge_retries: retries, ...backoff });
    const why = out.exit === 75 ? "the base moved" : "a transient forge failure";
    appendLog(deps.root, job.id, `ship_merge exit ${out.exit} (${why}); the job lands again`);
    return { kind: "retry" };
  }
  const exit = out.kind === "merged" ? 0 : out.exit;
  updateJob(deps.root, job.id, { merge_exit: exit });
  mark(deps.root, job.id, `MERGE_EXIT=${exit}`);
  if (out.kind === "merged") return { kind: "merged" };
  const why = markerValue(out.why).slice(0, 200);
  return { kind: "fail", reason: `merge pr=${pr}${why ? `: ${why}` : ""}` };
}

export async function mergePhase(
  deps: ShipQueueDeps,
  job: JobRecord,
  pr: number,
  head: string,
): Promise<PhaseResult<void>> {
  let exitCode: number;
  let message: string;
  try {
    ({ exitCode, message } = await deps.forge.mergePullRequest({
      cwd: job.worktree,
      repo: job.repo,
      number: pr,
      headSha: head,
      title: job.title,
    }));
  } catch (err) {
    exitCode = 1;
    message = err instanceof Error ? err.message : String(err);
  }
  appendLog(deps.root, job.id, message);
  updateJob(deps.root, job.id, { merge_exit: exitCode });
  mark(deps.root, job.id, `MERGE_EXIT=${exitCode}`);
  if (exitCode !== 0) {
    const first = markerValue(message.split("\n")[0] ?? "").slice(0, 200);
    return { ok: false, reason: `merge pr=${pr}${first ? `: ${first}` : ""}` };
  }
  return { ok: true, value: undefined };
}
