// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Content-bound guard-protocol owner approval and atomic dependency attempt rollback.
import { checkGuardGrant, requestGuardGrant } from "@t3tools/guard-protocol/client";

import { computeReportDigest } from "./depsRepoFiles.ts";
import { SqliteDepsStore } from "./depsStore.ts";
import { DEP_DAY_S, DEP_REPORT_ID_RE } from "./depsTypes.ts";
import type { ProcessRunner } from "./types.ts";

export interface OwnerApprovalInput {
  readonly action: "decide" | "rollback";
  readonly reportId: string;
  readonly repo: string;
  readonly decision?: "approve" | "reject" | undefined;
  readonly reportDigest: string;
  readonly command: ReadonlyArray<string>;
  readonly cwd: string;
  readonly reason: string;
  readonly threadId?: string | undefined;
}

export interface OwnerApprovalResult {
  readonly ok: boolean;
  readonly approvedBy?: string | undefined;
  readonly error?: string | undefined;
}

/** Injectable content-bound owner approval hook (default uses `@t3tools/guard-protocol/client`). */
export type OwnerApprovalFn = (input: OwnerApprovalInput) => Promise<OwnerApprovalResult>;

export interface DepsEngineOptions {
  readonly queueRoot: string;
  readonly nowEpochSec?: (() => number) | undefined;
  readonly run?: ProcessRunner | undefined;
  readonly requestOwnerApproval?: OwnerApprovalFn | undefined;
  readonly readCurrentFiles?:
    | ((repo: string, ref: string) => Promise<Readonly<Record<string, string>>>)
    | undefined;
  readonly makeAttemptToken?: (() => string) | undefined;
}

/** Default owner approval wired directly to `@t3tools/guard-protocol` (`owner-check` content-bound command grant). */
export const guardProtocolOwnerApproval: OwnerApprovalFn = async (input) => {
  const checked = await checkGuardGrant({
    guard: "owner-check",
    command: input.command,
    cwd: input.cwd,
    threadId: input.threadId,
  });
  if (checked.ok) {
    return { ok: true, approvedBy: checked.approvedBy ?? "human" };
  }
  const refusal =
    input.action === "rollback"
      ? `Owner approval required to rollback dependency attempt ${input.reportId}`
      : `Owner approval required to ${input.decision ?? "decide"} dependency report ${input.reportId}`;
  const requested = await requestGuardGrant({
    guard: "owner-check",
    command: input.command,
    cwd: input.cwd,
    refusal,
    proposedReason: input.reason,
    threadId: input.threadId,
  });
  if (requested.ok) {
    return { ok: true, approvedBy: requested.approvedBy ?? "human" };
  }
  return {
    ok: false,
    error: requested.error ?? requested.reason ?? "owner approval denied or unavailable",
  };
};

function nowSec(fn?: () => number): number {
  return fn ? fn() : Math.floor(Date.now() / 1000);
}

/** Rolls back an active dependency update attempt with explicit rollback approval and atomic SQLite commit. */
export async function rollbackShipQueueDepsAttempt(
  options: DepsEngineOptions,
  input: {
    readonly attemptId: string;
    readonly reason: string;
    readonly cwd: string;
    readonly threadId?: string | undefined;
    readonly actor?: string | undefined;
  },
): Promise<{
  readonly ok: boolean;
  readonly message?: string | undefined;
  readonly error?: string | undefined;
}> {
  if (input.reason.trim().length < 12) {
    return { ok: false, error: "give a rollback reason of at least 12 characters" };
  }
  if (!DEP_REPORT_ID_RE.test(input.attemptId)) {
    return { ok: false, error: "Invalid attempt ID" };
  }
  const repo = input.attemptId.split(":", 1)[0] ?? "";
  const store = new SqliteDepsStore(options.queueRoot);
  try {
    const preState = store.getRepoState(repo);
    const preAttempt = preState?.attempt;
    if (!preState || !preAttempt || preAttempt.id !== input.attemptId) {
      return { ok: false, error: "unknown attempt" };
    }
    if (preAttempt.status === "merging" || preAttempt.status === "merged") {
      return { ok: false, error: "rollback is refused during the merge drill and after merge" };
    }
    if (preAttempt.status === "cancelled") {
      return { ok: true, message: "Already rolled back." };
    }

    const reportDigest = computeReportDigest(preAttempt.report);
    const approveFn = options.requestOwnerApproval ?? guardProtocolOwnerApproval;
    const approval = await approveFn({
      action: "rollback",
      reportId: input.attemptId,
      repo,
      reportDigest,
      command: ["ship-queue", "deps", "rollback", input.attemptId, reportDigest],
      cwd: input.cwd,
      reason: input.reason.trim(),
      threadId: input.threadId,
    });
    if (!approval.ok) {
      return { ok: false, error: approval.error ?? "host guard refused rollback" };
    }

    const commitNow = nowSec(options.nowEpochSec);
    return store.runInImmediateTransaction(() => {
      const freshState = store.getRepoState(repo);
      const freshAttempt = freshState?.attempt;
      if (!freshState || !freshAttempt || freshAttempt.id !== input.attemptId) {
        return { ok: false, error: "unknown attempt" };
      }
      if (freshAttempt.status === "merging" || freshAttempt.status === "merged") {
        return { ok: false, error: "rollback is refused during the merge drill and after merge" };
      }
      if (freshAttempt.status === "cancelled") {
        return { ok: true, message: "Already rolled back." };
      }
      store.appendAudit({
        repo,
        action: "rollback",
        targetId: input.attemptId,
        reason: input.reason.trim(),
        actor: input.actor ?? approval.approvedBy ?? "human",
        nowEpochSec: commitNow,
      });
      store.saveRepoState(
        {
          ...freshState,
          attempt: { ...freshAttempt, status: "cancelled" },
          decision: {
            kind: "rollback",
            until: commitNow + DEP_DAY_S,
            files: freshAttempt.report.files ?? {},
          },
        },
        commitNow,
      );
      return {
        ok: true,
        message:
          "Attempt cancelled. Shipping may resume for 24 hours with the original dependencies.",
      };
    });
  } finally {
    store.close();
  }
}
