// @effect-diagnostics nodeBuiltinImport:off - Detach threads whose worktrees and branches were reaped by completed ship-queue jobs.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { ShipQueueBridgeUpdate } from "./ShipQueueBridge.ts";
import type { JobSummary } from "./types.ts";

const MAX_PROCESSED_JOB_IDS = 500;

export interface DetachableThread {
  readonly id: string;
  readonly projectId?: string | undefined;
  readonly worktreePath: string | null;
  readonly branch: string | null;
}

export interface ShipQueueWorktreeDetacherOptions {
  readonly findThreadsByWorktreePath: (
    worktreePath: string,
  ) => Promise<ReadonlyArray<DetachableThread>>;
  readonly getThreadById?: (threadId: string) => Promise<DetachableThread | null>;
  readonly isBranchRemoved?: (input: {
    readonly threadId: string;
    readonly projectId?: string | undefined;
    readonly branch: string;
  }) => Promise<boolean>;
  readonly detachThread: (input: {
    readonly threadId: string;
    readonly expectedWorktreePath: string;
    readonly expectedBranch: string | null;
  }) => Promise<void>;
  readonly pathExists?: (path: string) => boolean;
}

export class ShipQueueWorktreeDetacher {
  private readonly options: ShipQueueWorktreeDetacherOptions;
  private readonly pathExists: (path: string) => boolean;
  private readonly processedJobIds = new Set<string>();
  private readonly inFlightJobIds = new Set<string>();
  private disposed = false;

  constructor(options: ShipQueueWorktreeDetacherOptions) {
    this.options = options;
    this.pathExists = options.pathExists ?? ((target) => NodeFS.existsSync(target));
  }

  handleUpdate(update: ShipQueueBridgeUpdate): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const candidates: JobSummary[] = [];
    for (const id of update.changedIds) {
      const job = update.jobs.get(id);
      if (
        job &&
        job.kind === "ship" &&
        job.state === "done" &&
        !this.processedJobIds.has(job.id) &&
        !this.inFlightJobIds.has(job.id)
      ) {
        this.inFlightJobIds.add(job.id);
        candidates.push(job);
      }
    }
    if (candidates.length === 0) return Promise.resolve();
    return this.processCandidates(candidates);
  }

  dispose(): void {
    this.disposed = true;
    this.processedJobIds.clear();
    this.inFlightJobIds.clear();
  }

  private markProcessed(jobId: string): void {
    this.processedJobIds.add(jobId);
    while (this.processedJobIds.size > MAX_PROCESSED_JOB_IDS) {
      const oldest = this.processedJobIds.values().next().value;
      if (oldest === undefined) break;
      this.processedJobIds.delete(oldest);
    }
  }

  private async processCandidates(candidates: ReadonlyArray<JobSummary>): Promise<void> {
    for (const job of candidates) {
      try {
        if (this.disposed) return;
        const rawWorktree = job.binding.worktreePath?.trim();
        if (!rawWorktree) continue;
        const resolvedWorktree = NodePath.resolve(rawWorktree);
        if (this.pathExists(resolvedWorktree)) continue;
        await this.detachMatchingThreads(
          rawWorktree,
          resolvedWorktree,
          job.binding.branch?.trim(),
          job.binding.threadId,
        );
        this.markProcessed(job.id);
      } catch {
        // Best-effort; leave unmarked so a transient lookup failure can retry.
      } finally {
        this.inFlightJobIds.delete(job.id);
      }
    }
  }

  private async detachMatchingThreads(
    rawWorktree: string,
    resolvedWorktree: string,
    jobBranch: string | undefined,
    boundThreadId: string | undefined,
  ): Promise<void> {
    const matched = new Map<string, DetachableThread>();
    const pathsToQuery =
      resolvedWorktree === rawWorktree ? [rawWorktree] : [rawWorktree, resolvedWorktree];
    for (const queryPath of pathsToQuery) {
      const threads = await this.options.findThreadsByWorktreePath(queryPath);
      for (const thread of threads) {
        if (thread.worktreePath !== null) {
          matched.set(thread.id, thread);
        }
      }
    }
    if (boundThreadId && !matched.has(boundThreadId) && this.options.getThreadById) {
      const bound = await this.options.getThreadById(boundThreadId);
      if (
        bound !== null &&
        bound.worktreePath !== null &&
        NodePath.resolve(bound.worktreePath) === resolvedWorktree
      ) {
        matched.set(bound.id, bound);
      }
    }
    for (const thread of matched.values()) {
      if (this.disposed || thread.worktreePath === null) return;
      if (jobBranch && thread.branch !== jobBranch) continue;
      if (thread.branch !== null && this.options.isBranchRemoved) {
        const removed = await this.options.isBranchRemoved({
          threadId: thread.id,
          projectId: thread.projectId,
          branch: thread.branch,
        });
        if (!removed) continue;
      }
      try {
        await this.options.detachThread({
          threadId: thread.id,
          expectedWorktreePath: thread.worktreePath,
          expectedBranch: thread.branch,
        });
      } catch {
        // Ignore CAS conflicts or active-session rejections.
      }
    }
  }
}
