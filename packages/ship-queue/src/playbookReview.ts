// @effect-diagnostics nodeBuiltinImport:off - Runs the playbook challenge once per rebased head, after the job's CI.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { appendLog, jobBodyPath, jobDir, jobReviewPath } from "./jobStore.ts";
import type { JobRecord, ShipQueueDeps } from "./types.ts";

const reviewTipPath = (root: string, id: string) =>
  NodePath.join(jobDir(root, id), "work", "review-tip");

function readReviewTip(root: string, id: string): string {
  try {
    return NodeFS.readFileSync(reviewTipPath(root, id), "utf8").trim();
  } catch {
    return "";
  }
}

/** A review of an older head is dropped before the gates run, so no watch ever shows it. */
export function forgetStaleReview(root: string, id: string, head: string): void {
  const prior = readReviewTip(root, id);
  if (prior && prior !== head) {
    NodeFS.rmSync(jobReviewPath(root, id), { force: true });
    NodeFS.rmSync(reviewTipPath(root, id), { force: true });
  }
}

/**
 * Runs `playbook challenge` once per rebased head, after CI, so its input holds the job's real CI
 * output. A challenger that throws leaves a NOT RUN report: no review never blocks a job.
 */
export async function reviewHead(
  deps: ShipQueueDeps,
  job: JobRecord,
  rebase: { readonly onto: string; readonly head: string },
): Promise<void> {
  const challenge = deps.declarationChallenge;
  const outFile = jobReviewPath(deps.root, job.id);
  if (!challenge) return;
  if (readReviewTip(deps.root, job.id) === rebase.head && NodeFS.existsSync(outFile)) return;
  NodeFS.rmSync(outFile, { force: true });
  try {
    const res = await challenge({
      jobId: job.id,
      worktree: job.worktree,
      baseSha: rebase.onto,
      tipSha: rebase.head,
      bodyFile: jobBodyPath(deps.root, job.id),
      outFile,
      threadId: job.thread_id,
    });
    if (res.output) appendLog(deps.root, job.id, res.output);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    appendLog(deps.root, job.id, `house declaration-challenge: not run (${why})`);
    if (!NodeFS.existsSync(outFile)) {
      NodeFS.writeFileSync(outFile, `PLAYBOOK REVIEW: NOT RUN\n  ${why}\n`, "utf8");
    }
  } finally {
    NodeFS.mkdirSync(NodePath.dirname(reviewTipPath(deps.root, job.id)), { recursive: true });
    NodeFS.writeFileSync(reviewTipPath(deps.root, job.id), `${rebase.head}\n`, "utf8");
  }
}
