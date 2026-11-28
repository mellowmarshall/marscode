// @effect-diagnostics nodeBuiltinImport:off - Binds a trusted ship-queue worker's grant check to one job record's thread, worktree, branch, and digest.
import { normalizeRepoSlug } from "@t3tools/guard-protocol/digests";
import type { GuardBundleSpec } from "@t3tools/guard-protocol/protocol";
import { isRecordedQueueWorker } from "@t3tools/host-guards/t3-server-trust";
import { resolveQueueRoot } from "@t3tools/ship-queue/cli";
import { isEnded, isJobId, readJob } from "@t3tools/ship-queue/jobStore";

import { bundleKeyOf } from "./GuardBrokerTypes.ts";
import { canonicalCwd } from "./GuardSocketPath.ts";

const SHIP_QUEUE_GUARD = "ship-queue";

export interface QueueWorkerTrust {
  readonly queueRoot: string;
  /** Whether a kernel-verified peer PID is a recorded, trusted ship-queue worker of `queueRoot`. */
  readonly isTrustedWorker: (pid: number) => boolean;
}

export function defaultQueueWorkerTrust(queueRoot?: string): QueueWorkerTrust {
  const root = queueRoot ?? resolveQueueRoot(process.env);
  return { queueRoot: root, isTrustedWorker: (pid) => isRecordedQueueWorker(root, pid) };
}

export type QueueWorkerVerdict =
  | { readonly ok: true; readonly threadId: string }
  | { readonly ok: false; readonly error: string };

/**
 * A worker may only check (never request) grants, and only for the thread its job recorded,
 * with the job's own worktree, branch, and the protected-diff digest the job is waiting on.
 */
export function verifyQueueWorkerJob(
  trust: QueueWorkerTrust,
  input: {
    readonly peerPid: number | undefined;
    readonly jobId: string;
    readonly guard: string;
    readonly command: ReadonlyArray<string>;
    readonly cwd: string;
    readonly bundle: GuardBundleSpec | undefined;
  },
): QueueWorkerVerdict {
  if (!input.peerPid || !trust.isTrustedWorker(input.peerPid)) {
    return { ok: false, error: "caller is not a trusted ship-queue worker" };
  }
  if (!isJobId(input.jobId)) return { ok: false, error: "invalid job_id" };
  const job = readJob(trust.queueRoot, input.jobId);
  if (!job || isEnded(job)) return { ok: false, error: "job is not open" };
  const threadId = job.thread_id?.trim() ?? "";
  if (!threadId) return { ok: false, error: "job has no recorded thread" };
  if (input.guard !== SHIP_QUEUE_GUARD) {
    return { ok: false, error: "queue workers may only check ship-queue grants" };
  }
  const worktree = canonicalCwd(job.worktree);
  const [tool, sub, cmdWorktree, cmdBranch, ...extra] = input.command;
  if (
    tool !== SHIP_QUEUE_GUARD ||
    sub !== "submit" ||
    extra.length > 0 ||
    canonicalCwd(cmdWorktree ?? "") !== worktree ||
    cmdBranch !== job.branch ||
    input.cwd !== worktree
  ) {
    return { ok: false, error: "grant check does not match the job's worktree and branch" };
  }
  if (
    !input.bundle ||
    input.bundle.branch !== job.branch ||
    normalizeRepoSlug(input.bundle.repo) !== normalizeRepoSlug(job.repo)
  ) {
    return { ok: false, error: "grant check does not match the job's repo and branch" };
  }
  if (!job.action_digest || bundleKeyOf(SHIP_QUEUE_GUARD, input.bundle) !== job.action_digest) {
    return { ok: false, error: "protected diff digest does not match the job" };
  }
  return { ok: true, threadId };
}
