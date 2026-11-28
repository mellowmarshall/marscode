// @effect-diagnostics nodeBuiltinImport:off - Binds a trusted ship-queue worker's grant check to one job record's thread, worktree, branch, and digest.
import { normalizeRepoSlug } from "@t3tools/guard-protocol/digests";
import type { GuardBundleSpec } from "@t3tools/guard-protocol/protocol";
import { isTrustedShipQueueSubmit } from "@t3tools/host-guards/ship-queue-submit-trust";
import { isRecordedQueueWorker } from "@t3tools/host-guards/t3-server-trust";
import { resolveQueueRoot } from "@t3tools/ship-queue/cli";
import { isEnded, isJobId, readJob } from "@t3tools/ship-queue/jobStore";

import { bundleKeyOf } from "./GuardBrokerTypes.ts";
import type { GuardJobBindings } from "./GuardJobBindings.ts";
import { canonicalCwd } from "./GuardSocketPath.ts";

const SHIP_QUEUE_GUARD = "ship-queue";
export interface QueueWorkerTrust {
  readonly queueRoot: string;
  /** Whether a kernel-verified peer PID is a recorded, trusted ship-queue worker of `queueRoot`. */
  readonly isTrustedWorker: (pid: number) => boolean;
  /** Whether a peer PID is the installed `ship-queue submit <worktree> <branch>` process. */
  readonly isTrustedSubmitter: (pid: number, worktree: string, branch: string) => boolean;
}

export function defaultQueueWorkerTrust(queueRoot?: string): QueueWorkerTrust {
  const root = queueRoot ?? resolveQueueRoot(process.env);
  return {
    queueRoot: root,
    isTrustedWorker: (pid) => isRecordedQueueWorker(root, pid),
    isTrustedSubmitter: (pid, worktree, branch) =>
      isTrustedShipQueueSubmit(pid, { queueRoot: root, worktree, branch }),
  };
}

export type QueueWorkerVerdict =
  | { readonly ok: true; readonly threadId: string }
  | { readonly ok: false; readonly error: string };

/**
 * Workers only check grants, for the thread bound to the job at submit. Trust comes from the
 * kernel peer after the connection's one request line, so an earlier `exec` swap is seen; a
 * handed-off fd can at worst spend the job's grant early (accepted denial of service).
 */
export function verifyQueueWorkerJob(
  trust: QueueWorkerTrust,
  bindings: GuardJobBindings,
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
  const binding = bindings.get(input.jobId);
  if (!binding) return { ok: false, error: "job is not bound to a verified thread" };
  if (input.guard !== SHIP_QUEUE_GUARD) {
    return { ok: false, error: "queue workers may only check ship-queue grants" };
  }
  const worktree = canonicalCwd(job.worktree);
  if (binding.worktree !== worktree || binding.branch !== job.branch) {
    return { ok: false, error: "job record does not match its verified binding" };
  }
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
  return { ok: true, threadId: binding.threadId };
}
