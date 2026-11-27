// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Native dependency hold engine: content-bound pre-approval validation and atomic SQLite idempotency.
import * as NodeCrypto from "node:crypto";

import {
  computeReportDigest,
  readRegisteredRepoDependencyFiles,
  resolveRegisteredRepoPrimary,
} from "./depsRepoFiles.ts";
import { guardProtocolOwnerApproval, type DepsEngineOptions } from "./depsRollback.ts";
import { isSqliteUniqueConstraintError, SqliteDepsStore } from "./depsStore.ts";
import {
  ACTIVE_DEP_ATTEMPT_STATES,
  DEP_DAY_S,
  DEP_REPORT_ID_RE,
  DEP_REPO_NAME_RE,
  summarizeDepRepoState,
  type DepReportRecord,
  type DepRepoState,
  type DepRepoSummary,
  type RecordedReportDecision,
} from "./depsTypes.ts";

export interface DepsDecideResult {
  readonly ok: boolean;
  readonly idempotent?: boolean | undefined;
  readonly attemptId?: string | undefined;
  readonly message?: string | undefined;
  readonly error?: string | undefined;
  readonly errorCode?:
    | "invalid_input"
    | "stale_report"
    | "conflict"
    | "active_attempt"
    | "already_merged"
    | "files_changed"
    | "approval_denied"
    | undefined;
}

function filesEqual(
  a: Readonly<Record<string, string>> | undefined,
  b: Readonly<Record<string, string>> | undefined,
): boolean {
  if (!a || !b) return false;
  const keysA = Object.keys(a).toSorted();
  const keysB = Object.keys(b).toSorted();
  if (keysA.length !== keysB.length) return false;
  return keysA.every((k, i) => k === keysB[i] && a[k] === b[k]);
}

function nowSec(fn?: () => number): number {
  return fn ? fn() : Math.floor(Date.now() / 1000);
}

function formatExistingDecision(
  existing: RecordedReportDecision,
  decision: "approve" | "reject",
): DepsDecideResult {
  if (existing.decision === decision) {
    return {
      ok: true,
      idempotent: true,
      ...(existing.attemptId ? { attemptId: existing.attemptId } : {}),
      message: existing.message,
    };
  }
  return {
    ok: false,
    error: `Report ${existing.reportId} was already decided as '${existing.decision}'; scan again before changing decision`,
    errorCode: "conflict",
  };
}

function locateAndValidateReport(
  state: DepRepoState | null,
  reportId: string,
  decision: "approve" | "reject",
  now: number,
):
  | {
      readonly ok: true;
      readonly state: DepRepoState;
      readonly report: DepReportRecord;
      readonly isCheckoutReport: boolean;
    }
  | { readonly ok: false; readonly result: DepsDecideResult } {
  if (!state) {
    return {
      ok: false,
      result: {
        ok: false,
        error: "report is missing, replaced, or older than 24 hours; scan again",
        errorCode: "stale_report",
      },
    };
  }

  let report: DepReportRecord | undefined =
    state.report?.id === reportId ? state.report : undefined;
  let isCheckoutReport = false;
  if (!report && state.checkouts) {
    for (const candidate of Object.values(state.checkouts)) {
      if (candidate.id === reportId) {
        report = candidate;
        isCheckoutReport = true;
        break;
      }
    }
  }

  if (!report || !Number.isFinite(report.created) || report.created < now - DEP_DAY_S) {
    return {
      ok: false,
      result: {
        ok: false,
        error: "report is missing, replaced, or older than 24 hours; scan again",
        errorCode: "stale_report",
      },
    };
  }
  if (state.attempt && ACTIVE_DEP_ATTEMPT_STATES.has(state.attempt.status)) {
    return {
      ok: false,
      result: {
        ok: false,
        error: "an update attempt is active; use its explicit rollback command",
        errorCode: "active_attempt",
      },
    };
  }
  if (state.attempt?.status === "merged" && state.attempt.report?.id === report.id) {
    return {
      ok: false,
      result: {
        ok: false,
        error: "this report was already merged; scan again, do not approve or reject it again",
        errorCode: "already_merged",
      },
    };
  }
  if (decision === "approve") {
    if (isCheckoutReport || report.source?.kind === "checkout") {
      return {
        ok: false,
        result: {
          ok: false,
          error: "checkout reports support reject only; scan main for an update approval",
          errorCode: "invalid_input",
        },
      };
    }
    if (
      report.status !== "pending" ||
      !Array.isArray(report.updates) ||
      report.updates.length === 0
    ) {
      return {
        ok: false,
        result: {
          ok: false,
          error: "there is no complete update list to approve",
          errorCode: "invalid_input",
        },
      };
    }
  }
  return { ok: true, state, report, isCheckoutReport };
}

/** Reads every repo's dependency summary directly from SQLite (importing legacy state.json if present). */
export function listShipQueueDeps(
  queueRoot: string,
  nowEpochSec?: () => number,
): { readonly queueRoot: string; readonly repos: ReadonlyArray<DepRepoSummary> } {
  const store = new SqliteDepsStore(queueRoot);
  try {
    const now = nowSec(nowEpochSec);
    const states = store.listRepoStates(now);
    return {
      queueRoot,
      repos: states.map((s) => summarizeDepRepoState(s, now)),
    };
  } finally {
    store.close();
  }
}

/**
 * Decides a dependency report idempotently per `reportId`.
 * Validates report existence, age, `origin/main` drift, and content digest BEFORE owner approval,
 * then commits fresh state atomically inside `BEGIN IMMEDIATE`.
 */
export async function decideShipQueueDeps(
  options: DepsEngineOptions,
  input: {
    readonly reportId: string;
    readonly decision: "approve" | "reject";
    readonly cwd: string;
    readonly reason?: string | undefined;
    readonly threadId?: string | undefined;
    readonly actor?: string | undefined;
  },
): Promise<DepsDecideResult> {
  if (!DEP_REPORT_ID_RE.test(input.reportId)) {
    return { ok: false, error: "Invalid dependency report ID", errorCode: "invalid_input" };
  }
  const repo = input.reportId.split(":", 1)[0] ?? "";
  if (!DEP_REPO_NAME_RE.test(repo)) {
    return { ok: false, error: "Invalid repository name", errorCode: "invalid_input" };
  }

  const now = nowSec(options.nowEpochSec);
  const store = new SqliteDepsStore(options.queueRoot);
  try {
    store.importLegacyJsonIfNeeded(now);

    const existing = store.getDecisionByReportId(input.reportId);
    if (existing) return formatExistingDecision(existing, input.decision);

    const checked = locateAndValidateReport(
      store.getRepoState(repo),
      input.reportId,
      input.decision,
      now,
    );
    if (!checked.ok) return checked.result;
    const { report, isCheckoutReport } = checked;

    const fileReader =
      options.readCurrentFiles ??
      (resolveRegisteredRepoPrimary(options.queueRoot, repo)
        ? (r: string, ref: string) =>
            readRegisteredRepoDependencyFiles({
              queueRoot: options.queueRoot,
              repo: r,
              ref,
              run: options.run,
            })
        : undefined);

    if (fileReader && report.files && Object.keys(report.files).length > 0) {
      // Main reports always validate against live `origin/main` to catch post-scan drift.
      const ref =
        !isCheckoutReport && report.source?.kind !== "checkout"
          ? "origin/main"
          : (report.source?.commit ?? "HEAD");
      let currentFiles: Readonly<Record<string, string>>;
      try {
        currentFiles = await fileReader(repo, ref);
      } catch (err) {
        return {
          ok: false,
          error: `cannot verify current dependency files at ${ref}: ${err instanceof Error ? err.message : String(err)}`,
          errorCode: "files_changed",
        };
      }
      if (!filesEqual(currentFiles, report.files)) {
        return {
          ok: false,
          error: "report dependency files differ from current main; scan again before deciding",
          errorCode: "files_changed",
        };
      }
    }

    const reportDigest = computeReportDigest(report);
    const approveFn = options.requestOwnerApproval ?? guardProtocolOwnerApproval;
    const reason =
      input.reason?.trim() || `Dependency decision (${input.decision} ${input.reportId})`;
    const approval = await approveFn({
      action: "decide",
      reportId: input.reportId,
      repo,
      decision: input.decision,
      reportDigest,
      command: ["ship-queue", "deps", "decide", input.reportId, input.decision, reportDigest],
      cwd: input.cwd,
      reason,
      threadId: input.threadId,
    });
    if (!approval.ok) {
      return {
        ok: false,
        error: approval.error ?? "host guard refused the human decision",
        errorCode: "approval_denied",
      };
    }

    const actor = input.actor ?? approval.approvedBy ?? "human";
    const commitNow = nowSec(options.nowEpochSec);
    try {
      return store.runInImmediateTransaction((): DepsDecideResult => {
        const raced = store.getDecisionByReportId(input.reportId);
        if (raced) return formatExistingDecision(raced, input.decision);

        const fresh = locateAndValidateReport(
          store.getRepoState(repo),
          input.reportId,
          input.decision,
          commitNow,
        );
        if (!fresh.ok) return fresh.result;
        if (computeReportDigest(fresh.report) !== reportDigest) {
          return {
            ok: false,
            error: "report changed while awaiting owner approval; scan and decide again",
            errorCode: "files_changed",
          };
        }

        let nextState: DepRepoState;
        let attemptId: string | null = null;
        let message: string;
        if (input.decision === "reject") {
          if (fresh.isCheckoutReport) {
            const kept = (fresh.state.checkoutDecisions ?? []).filter((d) => d.until > commitNow);
            nextState = {
              ...fresh.state,
              holding: true,
              checkoutDecisions: [
                ...kept,
                {
                  kind: "reject",
                  until: commitNow + DEP_DAY_S,
                  files: fresh.report.files ?? {},
                  report: fresh.report.id,
                },
              ],
            };
            message = "Deferred for 24 hours, for this checkout's dependency set only.";
          } else {
            const { attempt: _dropped, ...rest } = fresh.state;
            nextState = {
              ...rest,
              holding: true,
              decision: {
                kind: "reject",
                until: commitNow + DEP_DAY_S,
                files: fresh.report.files ?? {},
              },
            };
            message = "Deferred for 24 hours. Normal shipping checks still apply.";
          }
        } else {
          const token = options.makeAttemptToken
            ? options.makeAttemptToken()
            : NodeCrypto.randomBytes(8).toString("hex");
          attemptId = `${repo}:${token}`;
          const { decision: _dropped, ...rest } = fresh.state;
          nextState = {
            ...rest,
            holding: true,
            attempt: {
              id: attemptId,
              status: "preparing",
              created: commitNow,
              report: fresh.report,
            },
          };
          message = `Approved ${attemptId}; shipping stays blocked.`;
        }

        const decisionRecord: RecordedReportDecision = {
          reportId: input.reportId,
          repo,
          decision: input.decision,
          attemptId,
          decidedAt: commitNow,
          actor,
          reason,
          message,
        };
        store.appendAudit({
          repo,
          action: input.decision,
          targetId: input.reportId,
          reason,
          actor,
          nowEpochSec: commitNow,
        });
        store.insertDecisionRow(decisionRecord);
        store.saveRepoState(nextState, commitNow);
        return {
          ok: true,
          idempotent: false,
          ...(attemptId ? { attemptId } : {}),
          message,
        };
      });
    } catch (err) {
      if (isSqliteUniqueConstraintError(err)) {
        const winner = store.getDecisionByReportId(input.reportId);
        if (winner) return formatExistingDecision(winner, input.decision);
      }
      throw err;
    }
  } finally {
    store.close();
  }
}
