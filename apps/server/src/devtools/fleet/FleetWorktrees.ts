/**
 * Native fleet "worktrees" panel: every linked worktree of the T3 projects on this host,
 * with dirty, ahead, merged (via `storageCleanupPullRequestMerged`), stale, and stuck flags.
 */
import * as Effect from "effect/Effect";

import * as GitManager from "../../git/GitManager.ts";
import * as GitWorkflowService from "../../git/GitWorkflowService.ts";
import { storageCleanupPullRequestMerged } from "../../storageCleanup.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import type { FleetWorktreeItem, FleetWorktreeRepo, FleetWorktreesPanel } from "./FleetTypes.ts";

/** A clean, unmerged worktree with no commit for this long is stale. */
const WORKTREE_STALE_AFTER_MS = 14 * 24 * 60 * 60_000;
/** Local work (uncommitted or on no remote) older than this is stuck. */
const WORKTREE_STUCK_AFTER_MS = 3 * 24 * 60 * 60_000;

interface RepoBase {
  readonly remote: string | null;
  readonly defaultBranch: string | null;
  readonly baseSha: string | null;
}

function basename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

export const makeFleetWorktreesCollector = Effect.gen(function* () {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const workflow = yield* GitWorkflowService.GitWorkflowService;
  const gitManager = yield* GitManager.GitManager;

  const run = (operation: string, cwd: string, args: ReadonlyArray<string>) =>
    git
      .execute({ operation, cwd, args, allowNonZeroExit: true, timeoutMs: 15_000 })
      .pipe(Effect.orElseSucceed(() => null));

  const countCommits = Effect.fn("FleetWorktrees.countCommits")(function* (
    cwd: string,
    args: ReadonlyArray<string>,
  ) {
    const res = yield* run("FleetWorktrees.revListCount", cwd, ["rev-list", "--count", ...args]);
    if (res === null || res.exitCode !== 0) return null;
    const n = Number(res.stdout.trim());
    return Number.isInteger(n) && n >= 0 ? n : null;
  });

  const readRepoBase = Effect.fn("FleetWorktrees.readRepoBase")(function* (repoRoot: string) {
    const remote = yield* workflow
      .resolvePrimaryRemoteName(repoRoot)
      .pipe(Effect.orElseSucceed(() => null));
    if (remote === null) return { remote, defaultBranch: null, baseSha: null } satisfies RepoBase;
    const defaultBranch = yield* workflow
      .resolveDefaultBranchName(repoRoot, remote)
      .pipe(Effect.orElseSucceed(() => null));
    if (defaultBranch === null) return { remote, defaultBranch, baseSha: null } satisfies RepoBase;
    const base = yield* git
      .resolveCommit({ cwd: repoRoot, revision: `refs/remotes/${remote}/${defaultBranch}` })
      .pipe(Effect.orElseSucceed(() => null));
    return { remote, defaultBranch, baseSha: base?.commitSha ?? null } satisfies RepoBase;
  });

  const readWorktree = Effect.fn("FleetWorktrees.readWorktree")(function* (
    path: string,
    base: RepoBase,
    nowMs: number,
  ) {
    const head = yield* run("FleetWorktrees.head", path, ["log", "-1", "--format=%H%x00%cI"]);
    if (head === null || head.exitCode !== 0) return null;
    const [headSha = "", lastCommitAt = ""] = head.stdout.trim().split("\0");
    if (!headSha) return null;
    const branchRes = yield* run("FleetWorktrees.branch", path, [
      "symbolic-ref",
      "--quiet",
      "--short",
      "HEAD",
    ]);
    const branch = branchRes?.exitCode === 0 ? branchRes.stdout.trim() : "";
    const statusRes = yield* run("FleetWorktrees.status", path, ["status", "--porcelain"]);
    const dirty = statusRes?.exitCode === 0 && statusRes.stdout.trim().length > 0;

    let ahead: number | null = null;
    let integrated = false;
    if (base.baseSha !== null) {
      ahead = yield* countCommits(path, [`${base.baseSha}..${headSha}`]);
      const ancestor = yield* run("FleetWorktrees.integrated", path, [
        "merge-base",
        "--is-ancestor",
        headSha,
        base.baseSha,
      ]);
      integrated = ancestor?.exitCode === 0;
    }
    const unpushed =
      base.remote === null ? null : yield* countCommits(path, [headSha, "--not", "--remotes"]);

    let merged = false;
    if (branch && base.defaultBranch !== null && branch !== base.defaultBranch) {
      const pullRequest = yield* gitManager
        .branchPullRequest({ cwd: path, branch }, { includeHeadRepository: true })
        .pipe(Effect.orElseSucceed(() => null));
      merged = storageCleanupPullRequestMerged(pullRequest, {
        branch,
        defaultBranch: base.defaultBranch,
        headSha,
        integrated,
      });
    }

    const lastCommitMs = Date.parse(lastCommitAt);
    const idleMs = Number.isFinite(lastCommitMs) ? nowMs - lastCommitMs : 0;
    const stale = !dirty && !merged && idleMs > WORKTREE_STALE_AFTER_MS;
    const hasLocalWork = dirty || (unpushed ?? 0) > 0;
    const stuck = !merged && hasLocalWork && idleMs > WORKTREE_STUCK_AFTER_MS;
    return {
      path,
      branch,
      ...(dirty ? { dirty: true } : {}),
      ...(ahead !== null && ahead > 0 ? { ahead } : {}),
      ...(unpushed !== null && unpushed > 0 ? { unpushed } : {}),
      ...(merged ? { merged: true } : {}),
      stale,
      ...(stuck ? { stuck: true } : {}),
      last_commit_at: lastCommitAt,
    } satisfies FleetWorktreeItem;
  });

  /**
   * Reads the linked worktrees of each project's repository; primary checkouts are left out.
   * `git worktree list` names the primary first, so roots in one repository share it.
   */
  const collect = Effect.fn("FleetWorktrees.collect")(function* (input: {
    readonly projectRoots: ReadonlyArray<string>;
    readonly nowMs: number;
  }) {
    const repos: FleetWorktreeRepo[] = [];
    const seenPrimaries = new Set<string>();
    for (const root of input.projectRoots) {
      const paths = yield* git
        .listWorktreePaths(root)
        .pipe(Effect.orElseSucceed((): string[] => []));
      const [repoRoot, ...linked] = paths;
      if (repoRoot === undefined || seenPrimaries.has(repoRoot)) continue;
      seenPrimaries.add(repoRoot);
      if (linked.length === 0) continue;
      const base = yield* readRepoBase(repoRoot);
      const items: FleetWorktreeItem[] = [];
      for (const path of linked.toSorted()) {
        const item = yield* readWorktree(path, base, input.nowMs);
        if (item !== null) items.push(item);
      }
      if (items.length > 0) repos.push({ repo: basename(repoRoot), root: repoRoot, items });
    }
    repos.sort((a, b) => a.root.localeCompare(b.root));

    const all = repos.flatMap((r) => r.items);
    return {
      total: all.length,
      dirty: all.filter((i) => i.dirty).length,
      stale: all.filter((i) => i.stale).length,
      merged: all.filter((i) => i.merged).length,
      stuck: all.filter((i) => i.stuck).length,
      repos,
    } satisfies FleetWorktreesPanel;
  });

  return { collect } as const;
});
