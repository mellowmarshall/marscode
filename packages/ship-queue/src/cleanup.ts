// @effect-diagnostics nodeBuiltinImport:off - After a merge: the remote branch, the local branch, and the worktree go; work the lane kept never does.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { git, isAncestor, remoteBranchSha, revParse, worktreeChanges } from "./gitQueries.ts";
import { forgetPushes } from "./rebaseEngine.ts";
import type { JobRecord, ProcessRunner } from "./types.ts";

export interface CleanupResult {
  /** Marker lines, in order; the last is always `CLEANED`. */
  readonly markers: ReadonlyArray<string>;
  readonly log: ReadonlyArray<string>;
  /** A remote branch that is still there once deleted: the job fails, merged. */
  readonly remoteLeft: boolean;
}

/**
 * Removes the merged job's remote branch, worktree, and local branch, then prunes. A worktree with
 * uncommitted work (LEFT_DIRTY) or commits made after the push (LEFT_AHEAD) keeps both.
 */
export async function cleanupMergedJob(
  run: ProcessRunner,
  root: string,
  job: JobRecord,
  pushedTip: string,
): Promise<CleanupResult> {
  const markers: string[] = [];
  const log: string[] = [];
  const { worktree: wt, branch: br, primary } = job;
  if (NodePath.resolve(primary) === NodePath.resolve(wt)) {
    return {
      markers: [
        `CLEANED worktree=${wt} branch=${br} worktree_state=refused branch_state=kept remote_state=kept`,
      ],
      log: [`refusing to clean the primary checkout ${wt}`],
      remoteLeft: false,
    };
  }

  let remoteState = "gone";
  if (await remoteBranchSha(run, primary, job.remote, br)) {
    const del = await git(run, primary, ["push", "-q", job.remote, "--delete", br]);
    if (del.exitCode !== 0) log.push(del.stderr.trim());
    remoteState = (await remoteBranchSha(run, primary, job.remote, br)) ? "left" : "deleted";
  }
  if (remoteState === "deleted") markers.push(`REMOTE_DELETED ${br}`);

  let worktreeState = "removed";
  let branchState = "deleted";
  const localTip = await revParse(run, primary, `refs/heads/${br}`);
  if (localTip && !(await isAncestor(run, primary, localTip, pushedTip))) {
    worktreeState = "kept-ahead";
    branchState = "kept";
    markers.push(
      `LEFT_AHEAD worktree=${wt} branch=${br} (commits made after the push; never removed, the lane decides)`,
    );
  } else if (NodeFS.existsSync(wt)) {
    const dirty = await worktreeChanges(run, wt);
    if (dirty.length > 0) {
      worktreeState = "kept-dirty";
      branchState = "kept";
      markers.push(
        `LEFT_DIRTY worktree=${wt} files=${dirty.length} (work not in the commit; never removed, the lane decides)`,
      );
      log.push(...dirty.slice(0, 20));
    } else {
      const removed = await git(run, primary, ["worktree", "remove", "--force", wt]);
      if (removed.exitCode !== 0) {
        log.push(removed.stderr.trim());
        worktreeState = "left";
        branchState = "kept";
      }
    }
  } else {
    worktreeState = "gone";
  }

  if (branchState === "deleted") {
    if (localTip) {
      const del = await git(run, primary, ["branch", "-D", br]);
      if (del.exitCode !== 0) {
        log.push(del.stderr.trim());
        branchState = "left";
      }
    } else {
      branchState = "gone";
    }
  }
  forgetPushes(root, job.repo, br);
  await git(run, primary, ["worktree", "prune"]);
  markers.push(
    `CLEANED worktree=${wt} branch=${br} worktree_state=${worktreeState} branch_state=${branchState} remote_state=${remoteState}`,
  );
  return { markers, log, remoteLeft: remoteState === "left" };
}
