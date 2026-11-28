// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Dependency scan scheduler and shipping-hold gate evaluation.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { defaultScanRepo, resolveRegisteredRepoPrimary } from "./depsRepoFiles.ts";
import { SqliteDepsStore } from "./depsStore.ts";
import {
  ACTIVE_DEP_ATTEMPT_STATES,
  DEP_DAY_S,
  DEP_REPO_NAME_RE,
  type DepReportRecord,
  type DepRepoState,
} from "./depsTypes.ts";
import type { ProcessRunner } from "./types.ts";

export const DEP_RESCAN_INTERVAL_S = 20 * 3600;
export const DEP_RETRY_FAILED_S = 45 * 60;
export const DEP_SCAN_INFLIGHT_S = 1800;

export interface DepsScanOutcome {
  readonly ok: boolean;
  readonly skipped?: boolean | undefined;
  readonly report?: DepReportRecord | undefined;
  readonly error?: string | undefined;
}

export interface DepsScanOptions {
  readonly queueRoot: string;
  readonly nowEpochSec?: (() => number) | undefined;
  readonly run?: ProcessRunner | undefined;
  readonly runRepoScan?:
    | ((repo: string, checkout?: string) => Promise<DepReportRecord>)
    | undefined;
}

function nowSec(fn?: () => number): number {
  return fn ? fn() : Math.floor(Date.now() / 1000);
}

function stableDigest(value: unknown): string {
  return NodeCrypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
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

function clearScanStarted(
  store: SqliteDepsStore,
  repo: string,
  fallback: DepRepoState,
  now: number,
): void {
  store.runInImmediateTransaction(() => {
    const latest = store.getRepoState(repo) ?? fallback;
    if (latest.scanStarted === undefined) return;
    const { scanStarted: _cleared, ...withoutStarted } = latest;
    store.saveRepoState(withoutStarted, now);
  });
}

/** Runs a dependency scan for one repo, respecting `--due` cadence and clearing `scanStarted` on failure. */
export async function scanShipQueueDepsRepo(
  options: DepsScanOptions,
  input: {
    readonly repo: string;
    readonly checkout?: string | undefined;
    readonly due?: boolean | undefined;
  },
): Promise<DepsScanOutcome> {
  if (!DEP_REPO_NAME_RE.test(input.repo)) {
    return { ok: false, error: "Invalid repository name" };
  }
  const now = nowSec(options.nowEpochSec);
  const store = new SqliteDepsStore(options.queueRoot);
  try {
    store.importLegacyJsonIfNeeded(now);

    const claim = store.runInImmediateTransaction(
      ():
        | { readonly status: "skip"; readonly report?: DepReportRecord | undefined }
        | { readonly status: "claimed"; readonly current: DepRepoState } => {
        const current = store.getRepoState(input.repo) ?? { repo: input.repo, holding: false };
        const lastReport = current.report;
        const failed = Boolean(lastReport?.error || lastReport?.status === "unknown");
        if (
          input.due &&
          lastReport &&
          lastReport.created > now - (failed ? DEP_RETRY_FAILED_S : DEP_RESCAN_INTERVAL_S)
        ) {
          return { status: "skip", report: lastReport };
        }
        if (current.attempt && ACTIVE_DEP_ATTEMPT_STATES.has(current.attempt.status)) {
          return { status: "skip", report: lastReport };
        }
        if (current.scanStarted && current.scanStarted > now - DEP_SCAN_INFLIGHT_S) {
          return { status: "skip", report: lastReport };
        }
        store.saveRepoState({ ...current, scanStarted: now }, now);
        return { status: "claimed", current };
      },
    );

    if (claim.status === "skip") {
      return { ok: true, skipped: true, ...(claim.report ? { report: claim.report } : {}) };
    }

    let report: DepReportRecord;
    let scanError: string | undefined;
    try {
      report = options.runRepoScan
        ? await options.runRepoScan(input.repo, input.checkout)
        : await defaultScanRepo({
            queueRoot: options.queueRoot,
            repo: input.repo,
            checkout: input.checkout,
            previousState: claim.current,
            nowEpochSec: now,
            run: options.run,
          });
    } catch (err) {
      scanError = err instanceof Error ? err.message : String(err);
      const idSuffix = stableDigest({ repo: input.repo, errMsg: scanError, at: now }).slice(0, 16);
      report = {
        id: `${input.repo}:${idSuffix}`,
        status: "unknown",
        created: now,
        files: {},
        updates: [],
        error: scanError,
      };
    }

    if (scanError && !claim.current.holding) {
      // Never lock out future scans when a repo cannot be scanned (e.g., unregistered primary).
      clearScanStarted(store, input.repo, claim.current, now);
      return { ok: false, error: scanError, report };
    }

    store.runInImmediateTransaction(() => {
      const latest = store.getRepoState(input.repo) ?? claim.current;
      const { scanStarted: _cleared, ...withoutStarted } = latest;
      if (input.checkout) {
        const keptCheckouts: Record<string, DepReportRecord> = {};
        for (const [k, v] of Object.entries(latest.checkouts ?? {})) {
          if (v.created > now - DEP_DAY_S) keptCheckouts[k] = v;
        }
        keptCheckouts[NodePath.resolve(input.checkout)] = report;
        store.saveRepoState({ ...withoutStarted, checkouts: keptCheckouts }, now);
      } else if (!latest.attempt || !ACTIVE_DEP_ATTEMPT_STATES.has(latest.attempt.status)) {
        const shouldDropMerged =
          latest.attempt?.status === "merged" && latest.attempt.report.id !== report.id;
        const becameHolding = latest.holding || report.status === "clean";
        const next: DepRepoState = {
          ...withoutStarted,
          ...(shouldDropMerged ? { attempt: undefined } : {}),
          report,
          holding: becameHolding,
          ...(becameHolding ? { holdingSince: latest.holdingSince ?? now } : {}),
        };
        store.saveRepoState(next, now);
      } else {
        store.saveRepoState(withoutStarted, now);
      }
    });

    if (scanError) {
      return { ok: false, error: scanError, report };
    }
    return { ok: true, skipped: false, report };
  } finally {
    store.close();
  }
}

/**
 * Scheduler-compatible periodic pass (`Scheduler.register`): scans every registered repo in
 * `<queueRoot>/repos/*` whose report is due for refresh.
 */
export async function scanDueDepsRepos(options: DepsScanOptions): Promise<{
  readonly scanned: ReadonlyArray<string>;
  readonly skipped: ReadonlyArray<string>;
  readonly failed: ReadonlyArray<string>;
}> {
  const reposDir = NodePath.join(options.queueRoot, "repos");
  const scanned: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];
  if (!NodeFS.existsSync(reposDir)) return { scanned, skipped, failed };

  const names = NodeFS.readdirSync(reposDir, { withFileTypes: true })
    .filter(
      (e) =>
        e.isDirectory() &&
        DEP_REPO_NAME_RE.test(e.name) &&
        resolveRegisteredRepoPrimary(options.queueRoot, e.name) !== null,
    )
    .map((e) => e.name)
    .toSorted();

  for (const repo of names) {
    const res = await scanShipQueueDepsRepo(options, { repo, due: true });
    if (!res.ok) failed.push(repo);
    else if (res.skipped) skipped.push(repo);
    else scanned.push(repo);
  }
  return { scanned, skipped, failed };
}

/** Evaluates whether a job passes the dependency hold gate for `repo` with its committed `files`. */
export function evaluateDepsGate(input: {
  readonly queueRoot: string;
  readonly repo: string;
  readonly jobId: string;
  readonly worktree: string;
  readonly files: Readonly<Record<string, string>>;
  readonly nowEpochSec?: (() => number) | undefined;
}): { readonly allowed: boolean; readonly reason: string } {
  const now = nowSec(input.nowEpochSec);
  const store = new SqliteDepsStore(input.queueRoot);
  try {
    store.importLegacyJsonIfNeeded(now);
    const state = store.getRepoState(input.repo);
    if (!state || !state.holding) {
      return { allowed: true, reason: "hold_inactive" };
    }
    const attempt = state.attempt;
    if (attempt && ACTIVE_DEP_ATTEMPT_STATES.has(attempt.status)) {
      const ok =
        attempt.job === input.jobId &&
        (attempt.status === "ready" ||
          attempt.status === "failed" ||
          attempt.status === "merging") &&
        filesEqual(input.files, attempt.expected);
      return ok
        ? { allowed: true, reason: "approved_updater" }
        : { allowed: false, reason: `active_attempt:${attempt.id}` };
    }
    if (
      state.decision &&
      state.decision.until > now &&
      filesEqual(state.decision.files, input.files)
    ) {
      return { allowed: true, reason: `decision:${state.decision.kind}` };
    }
    if (state.checkoutDecisions?.some((d) => d.until > now && filesEqual(d.files, input.files))) {
      return { allowed: true, reason: "checkout_decision:reject" };
    }
    if (
      state.report?.status === "clean" &&
      state.report.created > now - DEP_DAY_S &&
      filesEqual(state.report.files, input.files)
    ) {
      return { allowed: true, reason: "clean_report" };
    }
    return {
      allowed: false,
      reason: state.report?.id ? `decision_required:${state.report.id}` : "scan_required",
    };
  } finally {
    store.close();
  }
}
