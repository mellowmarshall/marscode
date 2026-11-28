// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Broker-held job id -> verified submitter thread, accepted only from the job's own submit process.
import { isEnded, isJobId, readJob } from "@t3tools/ship-queue/jobStore";

import type { QueueWorkerTrust } from "./GuardQueueWorker.ts";
import { canonicalCwd } from "./GuardSocketPath.ts";

const MAX_JOB_BINDINGS = 1024;
const BIND_WINDOW_MS = 120_000;
/** A job still open after this long is stale; its binding goes so the table cannot fill for good. */
export const JOB_BINDING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface JobBinding {
  readonly threadId: string;
  readonly worktree: string;
  readonly branch: string;
  readonly boundAtMs: number;
}

type BindResult = { readonly ok: true } | { readonly ok: false; readonly error: string };

/**
 * job id -> the submitter's kernel-verified thread, worktree and branch. The job file is
 * agent-writable, so it never decides whose grants a worker may use. First binding wins and an
 * active binding is never evicted to admit another; a binding goes when its job ends, is gone,
 * or turns stale (checked when a worker asks and when the table is full). It lives in memory: after a restart a job has none and fails closed.
 */
export class GuardJobBindings {
  private readonly bindings = new Map<string, JobBinding>();

  get size(): number {
    return this.bindings.size;
  }

  /** Drops bindings whose job ended, no longer exists, or outlived `JOB_BINDING_MAX_AGE_MS`. */
  prune(queueRoot: string, nowMs = Date.now()): void {
    for (const [jobId, binding] of this.bindings) {
      if (nowMs - binding.boundAtMs > JOB_BINDING_MAX_AGE_MS) {
        this.bindings.delete(jobId);
        continue;
      }
      const job = readJob(queueRoot, jobId);
      if (!job || isEnded(job)) this.bindings.delete(jobId);
    }
  }

  /** Accepts a bind only from the job's own fresh `ship-queue submit` process. */
  bind(
    trust: QueueWorkerTrust,
    input: {
      readonly peerPid: number | undefined;
      readonly threadId: string;
      readonly jobId: string;
      readonly worktree: string;
      readonly branch: string;
    },
    nowMs = Date.now(),
  ): BindResult {
    if (!isJobId(input.jobId)) return { ok: false, error: "invalid job_id" };
    if (!input.threadId) return { ok: false, error: "binding a job requires a verified thread" };
    if (this.bindings.has(input.jobId)) return { ok: false, error: "job is already bound" };
    const job = readJob(trust.queueRoot, input.jobId);
    if (!job || isEnded(job)) return { ok: false, error: "job is not open" };
    const submittedMs = Date.parse(job.submitted_at);
    if (
      !Number.isFinite(submittedMs) ||
      nowMs - submittedMs > BIND_WINDOW_MS ||
      submittedMs > nowMs + 5_000
    ) {
      return { ok: false, error: "job was not just submitted" };
    }
    const worktree = canonicalCwd(job.worktree);
    if (worktree !== canonicalCwd(input.worktree) || job.branch !== input.branch) {
      return { ok: false, error: "bind does not match the job's worktree and branch" };
    }
    if (!input.peerPid || !trust.isTrustedSubmitter(input.peerPid, worktree, job.branch)) {
      return { ok: false, error: "caller is not this job's ship-queue submit" };
    }
    if (this.bindings.size >= MAX_JOB_BINDINGS) this.prune(trust.queueRoot, nowMs);
    if (this.bindings.size >= MAX_JOB_BINDINGS) {
      return { ok: false, error: "too many job bindings" };
    }
    this.bindings.set(input.jobId, {
      threadId: input.threadId,
      worktree,
      branch: job.branch,
      boundAtMs: nowMs,
    });
    return { ok: true };
  }

  get(jobId: string, nowMs = Date.now()): JobBinding | undefined {
    const binding = this.bindings.get(jobId);
    if (binding && nowMs - binding.boundAtMs > JOB_BINDING_MAX_AGE_MS) {
      this.bindings.delete(jobId);
      return undefined;
    }
    return binding;
  }

  /** Removes the binding of a job that ended. */
  release(jobId: string): void {
    this.bindings.delete(jobId);
  }
}
