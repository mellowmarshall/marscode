// @effect-diagnostics nodeBuiltinImport:off - Rebases a job's branch onto the base the remote has now, refusing foreign remote tips.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { git, gitOut, isAncestor, remoteBranchSha } from "./gitQueries.ts";
import { repoKey } from "./jobStore.ts";
import type { JobRecord, ProcessRunner } from "./types.ts";

const FETCH_ATTEMPTS = 3;

export type RebaseResult =
  | {
      readonly ok: true;
      readonly onto: string;
      readonly head: string;
      readonly oneline: string;
      /** The remote branch tip the rebase verified as the lane's own: the push's lease. */
      readonly remoteTip: string | null;
    }
  | {
      readonly ok: false;
      readonly reason: "fetch_failed" | "foreign_remote_tip" | "rebase_conflict";
      readonly detail: string;
      readonly conflicts: ReadonlyArray<string>;
    };

const pushedRecordPath = (root: string, repo: string, branch: string) =>
  NodePath.join(root, "repos", repoKey(repo), "pushed", branch.replace(/[^A-Za-z0-9._-]/g, "_"));

/** Every sha the queue pushed for a branch: after a rebase the old tip is the lane's own, not foreign. */
export function recordPush(root: string, repo: string, branch: string, sha: string): void {
  const file = pushedRecordPath(root, repo, branch);
  if (queuePushed(root, repo, branch, sha)) return;
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  NodeFS.appendFileSync(file, `${sha}\n`);
}

export function queuePushed(root: string, repo: string, branch: string, sha: string): boolean {
  try {
    return NodeFS.readFileSync(pushedRecordPath(root, repo, branch), "utf8")
      .split("\n")
      .includes(sha);
  } catch {
    return false;
  }
}

export function forgetPushes(root: string, repo: string, branch: string): void {
  NodeFS.rmSync(pushedRecordPath(root, repo, branch), { force: true });
}

/**
 * Reads the remote branch tip once. It is foreign when it points at commits this checkout lacks,
 * the queue never pushed, and that are not patch-equal to the local branch: someone else's work.
 * The same read is the push's lease, so a push racing in after it is never overwritten.
 */
async function inspectRemoteTip(
  run: ProcessRunner,
  root: string,
  job: JobRecord,
  onto: string,
): Promise<{ readonly tip: string | null; readonly foreign: boolean }> {
  const tip = await remoteBranchSha(run, job.worktree, job.remote, job.branch);
  if (!tip) return { tip: null, foreign: false };
  if ((await git(run, job.worktree, ["cat-file", "-e", `${tip}^{commit}`])).exitCode !== 0) {
    await git(run, job.worktree, ["fetch", "-q", job.remote, tip]);
  }
  if (await isAncestor(run, job.worktree, tip, job.branch)) return { tip, foreign: false };
  if (queuePushed(root, job.repo, job.branch, tip)) return { tip, foreign: false };
  const cherry = await gitOut(run, job.worktree, ["cherry", job.branch, tip, onto]);
  if (cherry !== null && !cherry.split("\n").some((line) => line.startsWith("+"))) {
    return { tip, foreign: false };
  }
  return { tip, foreign: true };
}

export async function rebaseJob(
  run: ProcessRunner,
  root: string,
  job: JobRecord,
): Promise<RebaseResult> {
  const fail = (
    reason: "fetch_failed" | "foreign_remote_tip" | "rebase_conflict",
    detail: string,
    conflicts: ReadonlyArray<string> = [],
  ): RebaseResult => ({ ok: false, reason, detail, conflicts });
  await git(run, job.worktree, ["rebase", "--abort"]);
  // Worktrees share one .git; a fetch racing another lane's fails on a ref lock, not a conflict.
  let fetched = false;
  let fetchErr = "";
  for (let attempt = 0; attempt < FETCH_ATTEMPTS && !fetched; attempt += 1) {
    const res = await git(run, job.worktree, ["fetch", "-q", job.remote]);
    fetched = res.exitCode === 0;
    fetchErr = res.stderr.trim();
  }
  if (!fetched) return fail("fetch_failed", `fetch failed ${FETCH_ATTEMPTS} times: ${fetchErr}`);
  const onto = await gitOut(run, job.worktree, [
    "rev-parse",
    "-q",
    "--verify",
    `refs/remotes/${job.remote}/${job.base_branch}^{commit}`,
  ]);
  if (!onto) return fail("fetch_failed", `cannot read ${job.remote}/${job.base_branch}`);

  const remote = await inspectRemoteTip(run, root, job, onto);
  if (remote.foreign) {
    return fail(
      "foreign_remote_tip",
      `${job.remote}/${job.branch} is at ${remote.tip}: commits this checkout lacks and the queue never pushed; resolve by hand`,
    );
  }
  if (remote.tip) recordPush(root, job.repo, job.branch, remote.tip);

  const rebase = await git(run, job.worktree, ["rebase", "-q", onto]);
  if (rebase.exitCode !== 0) {
    const conflicts =
      (await gitOut(run, job.worktree, ["diff", "--name-only", "--diff-filter=U"]))
        ?.split("\n")
        .filter(Boolean) ?? [];
    await git(run, job.worktree, ["rebase", "--abort"]);
    return fail(
      "rebase_conflict",
      conflicts.length > 0
        ? `rebase conflict onto ${onto}: ${conflicts.join(", ")}`
        : `rebase onto ${onto} failed: ${rebase.stderr.trim()}`,
      conflicts,
    );
  }
  const head = await gitOut(run, job.worktree, ["rev-parse", "HEAD"]);
  const oneline = await gitOut(run, job.worktree, ["log", "--oneline", "-1"]);
  if (!head) return fail("rebase_conflict", "HEAD unreadable after the rebase");
  return { ok: true, onto, head, oneline: oneline ?? head, remoteTip: remote.tip };
}
