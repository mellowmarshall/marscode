// @effect-diagnostics nodeBuiltinImport:off - Post-merge sync hook execution (`ship_post_merge` + `SYNC_EXIT=`), idempotent across crash recovery.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { parseShipDeclaration } from "./declaration.ts";
import { extractBaseStepTree } from "./declarationValidation.ts";
import { currentBranch, git, gitOut, revParse, worktreeChanges } from "./gitQueries.ts";
import { appendLog, jobDir, mark, readLog, updateJob } from "./jobStore.ts";
import { parseSafeStepCommand, runLocalStep } from "./stepRunner.ts";
import type { JobRecord, ProcessRunner, ShipQueueDeps } from "./types.ts";

const FETCH_ATTEMPTS = 3;
const DEFAULT_POST_MERGE_TIMEOUT_MS = 10 * 60_000;
const SYNC_EXIT_RE = /^SYNC_EXIT=(-?\d+)\s*$/m;

function recordSyncExit(root: string, jobId: string, exitCode: number): void {
  updateJob(root, jobId, { sync_exit: exitCode });
  mark(root, jobId, `SYNC_EXIT=${exitCode}`);
}

async function fetchRemoteQuiet(
  run: ProcessRunner,
  cwd: string,
  remote: string,
): Promise<{ readonly ok: boolean; readonly error: string }> {
  let lastError = "";
  for (let attempt = 0; attempt < FETCH_ATTEMPTS; attempt += 1) {
    const res = await git(run, cwd, ["fetch", "-q", remote]);
    if (res.exitCode === 0) return { ok: true, error: "" };
    lastError = `${res.stderr}${res.stdout}`.trim() || `exit ${res.exitCode}`;
  }
  return { ok: false, error: lastError };
}

async function fastForwardPrimaryBase(
  deps: ShipQueueDeps,
  job: JobRecord,
): Promise<{
  readonly baseRef: string;
  readonly baseSha: string;
  readonly fetchFailed: boolean;
} | null> {
  const fetchRes = await fetchRemoteQuiet(deps.run, job.primary, job.remote);
  if (!fetchRes.ok) {
    appendLog(
      deps.root,
      job.id,
      `post-merge fetch ${job.remote} failed after ${FETCH_ATTEMPTS} attempts: ${fetchRes.error}`,
    );
  }
  const baseRef = `${job.remote}/${job.base_branch}`;
  const baseSha =
    (await revParse(deps.run, job.primary, `refs/remotes/${baseRef}`)) ??
    (await revParse(deps.run, job.primary, job.base_branch));
  if (!baseSha) return null;

  if (fetchRes.ok) {
    const branch = await currentBranch(deps.run, job.primary);
    if (branch === job.base_branch && (await worktreeChanges(deps.run, job.primary)).length === 0) {
      const ff = await git(deps.run, job.primary, ["merge", "--ff-only", "-q", baseSha]);
      if (ff.exitCode !== 0 && ff.stderr.trim()) {
        appendLog(
          deps.root,
          job.id,
          `primary checkout ${job.primary} not fast-forwarded: ${ff.stderr.trim()}`,
        );
      }
    }
  }
  return { baseRef, baseSha, fetchFailed: !fetchRes.ok };
}

/**
 * Executes a repository's declared `ship_post_merge` hook after merge cleanup.
 * Idempotent across crash-after-merge recovery: skips execution once `sync_exit` is recorded.
 * Non-zero exits are logged and marked via `SYNC_EXIT=<nonzero>` without marking the merged PR as unmerged.
 */
export async function runPostMergeSync(
  deps: ShipQueueDeps,
  job: JobRecord,
  pr: number,
): Promise<void> {
  if (typeof job.sync_exit === "number") return;

  const existingMatch = SYNC_EXIT_RE.exec(readLog(deps.root, job.id));
  if (existingMatch?.[1] !== undefined) {
    const parsedExit = Number.parseInt(existingMatch[1], 10);
    if (Number.isFinite(parsedExit)) {
      updateJob(deps.root, job.id, { sync_exit: parsedExit });
      return;
    }
  }

  let stepTree: string | null = null;
  try {
    const base = await fastForwardPrimaryBase(deps, job);
    if (!base) return;

    const confText =
      (await gitOut(deps.run, job.primary, ["show", `${base.baseSha}:.tree-guard.conf`])) ?? "";
    if (!confText.trim()) return;
    const playbookText =
      (await gitOut(deps.run, job.primary, ["show", `${base.baseSha}:playbook.json`])) ?? "";
    const decl = parseShipDeclaration(confText, playbookText, ".tree-guard.conf");
    const cmdline = decl.postMerge.trim();
    if (!cmdline) return;

    mark(deps.root, job.id, `POST_MERGE job=${job.id}`);

    if (base.fetchFailed) {
      appendLog(
        deps.root,
        job.id,
        `post-merge sync aborted: remote fetch failed; refusing to sync stale ${base.baseRef} (PR #${pr} remains merged)`,
      );
      recordSyncExit(deps.root, job.id, 1);
      return;
    }

    const safeCmd = parseSafeStepCommand(cmdline);
    if (!safeCmd.ok) {
      appendLog(
        deps.root,
        job.id,
        `post-merge refused: ${safeCmd.error} (PR #${pr} remains merged)`,
      );
      recordSyncExit(deps.root, job.id, 1);
      return;
    }

    stepTree = NodePath.join(jobDir(deps.root, job.id), "work", "post-merge-tree");
    const postMergeOnlyDecl = {
      ...parseShipDeclaration(""),
      postMerge: cmdline,
      stepTree: decl.stepTree,
    };
    const extracted = await extractBaseStepTree({
      run: deps.run,
      primary: job.primary,
      baseSha: base.baseSha,
      decl: postMergeOnlyDecl,
      destDir: stepTree,
    });
    if (!extracted.ok) {
      appendLog(
        deps.root,
        job.id,
        `post-merge extract failed: ${extracted.error ?? "unknown error"} (PR #${pr} remains merged)`,
      );
      recordSyncExit(deps.root, job.id, 1);
      return;
    }

    const res = await runLocalStep({
      mode: "post-merge",
      ctx: {
        jobId: job.id,
        repo: job.repo,
        primary: job.primary,
        worktree: job.worktree,
        branch: job.branch,
        baseRef: base.baseRef,
        baseSha: base.baseSha,
        ontoSha: job.rebased_onto,
        tipSha: job.pushed_sha ?? job.head_sha,
        ghRepo: decl.ghRepo || job.repo,
        queueRoot: deps.root,
        stepTree,
        dataRoot: process.env.SHIP_QUEUE_DATA_ROOT?.trim() ?? "",
        pr,
        worktreeRoot: decl.worktreeRoot || undefined,
      },
      cmdline,
      cwd: job.primary,
      timeoutMs: deps.postMergeTimeoutMs ?? DEFAULT_POST_MERGE_TIMEOUT_MS,
      run: deps.run,
    });

    const combined = `${res.stdout}${res.stderr}`.trim();
    if (combined) appendLog(deps.root, job.id, combined);
    if (res.exitCode !== 0) {
      appendLog(
        deps.root,
        job.id,
        `post-merge sync exited ${res.exitCode} (PR #${pr} remains merged)`,
      );
    }
    recordSyncExit(deps.root, job.id, res.exitCode);
  } catch (err) {
    appendLog(
      deps.root,
      job.id,
      `post-merge sync error: ${err instanceof Error ? err.message : String(err)} (PR #${pr} remains merged)`,
    );
    recordSyncExit(deps.root, job.id, 1);
  } finally {
    if (stepTree) {
      NodeFS.rmSync(stepTree, { recursive: true, force: true });
    }
  }
}
