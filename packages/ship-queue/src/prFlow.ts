// @effect-diagnostics nodeBuiltinImport:off - Push, pull request, and merge phases of a job: each records its exit as a marker.
import * as NodeFS from "node:fs";

import { git } from "./gitQueries.ts";
import { appendLog, jobBodyPath, mark, updateJob } from "./jobStore.ts";
import { markerValue } from "./markers.ts";
import { recordPush } from "./rebaseEngine.ts";
import type { JobRecord, ShipQueueDeps } from "./types.ts";

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
