// Native Ship Queue HTTP routes (deps, status, cancel) backed directly by `@t3tools/ship-queue` + SQLite + Scheduler.
import { resolveQueueRoot } from "@t3tools/ship-queue/cli";
import { decideShipQueueDeps, listShipQueueDeps } from "@t3tools/ship-queue/depsEngine";
import { resolveRegisteredRepoPrimary } from "@t3tools/ship-queue/depsRepoFiles";
import { scanDueDepsRepos, scanShipQueueDepsRepo } from "@t3tools/ship-queue/depsScan";
import { DEP_REPORT_ID_RE, DEP_REPO_NAME_RE } from "@t3tools/ship-queue/depsTypes";
import { reconcileDueToolDrift } from "@t3tools/ship-queue/toolDriftReconcile";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as Scheduler from "../scheduling/Scheduler.ts";
import { jsonResponse, readJsonBody } from "./DevtoolsHttpContext.ts";
import type { GuardGrantBroker } from "./GuardGrantBroker.ts";
import { cancelShipQueueJob, getShipQueueStatus } from "./ShipQueueEventStream.ts";

let consoleDepsSeq = 0;

function nextConsoleDepsThreadId(): string {
  consoleDepsSeq += 1;
  return `t3-console-deps-${process.pid}-${consoleDepsSeq}`;
}

export const handleShipQueueRoute = Effect.fn("DevtoolsShipQueueRoutes.handle")(function* (input: {
  readonly method: "GET" | "POST";
  readonly subPath: string;
  readonly broker: GuardGrantBroker;
  readonly session: { readonly method: string; readonly subject: string };
  readonly shipQueueRootOverride?: string | undefined;
}) {
  const { method, subPath, broker, session, shipQueueRootOverride } = input;
  const queueRoot = shipQueueRootOverride ?? resolveQueueRoot(process.env);

  if (method === "GET" && subPath === "/ship-queue/status") {
    const res = yield* Effect.promise(() => getShipQueueStatus());
    return jsonResponse(res, res.ok ? 200 : 503);
  }

  if (method === "GET" && subPath === "/ship-queue/deps") {
    return jsonResponse(listShipQueueDeps(queueRoot));
  }

  if (method === "POST" && subPath === "/ship-queue/deps/decide") {
    const parsed = yield* readJsonBody;
    if (!parsed.ok) return jsonResponse({ error: parsed.error }, parsed.status);
    const reportId = typeof parsed.value.reportId === "string" ? parsed.value.reportId.trim() : "";
    const decision = parsed.value.decision;
    if (!reportId || !DEP_REPORT_ID_RE.test(reportId)) {
      return jsonResponse({ error: "Invalid dependency report ID" }, 400);
    }
    if (decision !== "approve" && decision !== "reject") {
      return jsonResponse({ error: "decision must be 'approve' or 'reject'" }, 400);
    }
    if (!broker.listening) {
      return jsonResponse({ error: "guard grant broker is not listening" }, 503);
    }
    const cwd = process.cwd();
    const threadId = nextConsoleDepsThreadId();
    const reason =
      typeof parsed.value.reason === "string" && parsed.value.reason.trim()
        ? parsed.value.reason.trim()
        : `Dependency decision via T3 Fleet Console (${decision} ${reportId})`;

    // Native TS engine validates report existence, age (<=24h), active attempt, and idempotency
    // BEFORE invoking owner approval (`broker.preapprove`), so invalid/stale/duplicate requests
    // never mint a grant or trigger an owner modal.
    const res = yield* Effect.promise(() =>
      decideShipQueueDeps(
        {
          queueRoot,
          requestOwnerApproval: async (approvalInput) => {
            const grant = broker.preapprove({
              guard: "owner-check",
              command: [...approvalInput.command],
              cwd: approvalInput.cwd,
              reason: approvalInput.reason,
              threadId: approvalInput.threadId ?? threadId,
              ttlMs: 30_000,
              approvedVia: `${session.method}:${session.subject}`,
            });
            return grant.ok
              ? { ok: true, approvedBy: `${session.method}:${session.subject}` }
              : { ok: false, error: grant.error };
          },
        },
        {
          reportId,
          decision,
          cwd,
          reason,
          threadId,
          actor: `${session.method}:${session.subject}`,
        },
      ),
    );
    return jsonResponse(
      {
        ok: res.ok,
        exitCode: res.ok ? 0 : 2,
        data: res.ok
          ? {
              output: res.message ?? "",
              idempotent: res.idempotent === true,
              ...(res.attemptId ? { attemptId: res.attemptId } : {}),
            }
          : null,
        ...(res.error ? { error: res.error } : {}),
        ...(res.errorCode ? { errorCode: res.errorCode } : {}),
      },
      res.ok ? 200 : 400,
    );
  }

  if (method === "POST" && subPath === "/ship-queue/deps/scan") {
    const parsed = yield* readJsonBody;
    if (!parsed.ok) return jsonResponse({ error: parsed.error }, parsed.status);
    const repo = typeof parsed.value.repo === "string" ? parsed.value.repo.trim() : "";
    if (!repo || !DEP_REPO_NAME_RE.test(repo)) {
      return jsonResponse({ error: "Invalid repository name" }, 400);
    }
    if (!resolveRegisteredRepoPrimary(queueRoot, repo)) {
      return jsonResponse(
        {
          ok: false,
          exitCode: 2,
          data: null,
          error: `repository '${repo}' has no registered primary checkout`,
        },
        400,
      );
    }
    // A Renovate lookup can take many minutes: answer once the scan has claimed the repo (or
    // said why it did not), and let the lookup go on; the client polls status for its report.
    const claim = yield* Effect.promise(
      () =>
        new Promise<{
          readonly started: boolean;
          readonly reason?: string;
          readonly error?: string;
        }>((resolve) => {
          scanShipQueueDepsRepo({ queueRoot, onClaim: resolve }, { repo })
            .then((res) =>
              resolve({ started: false, error: res.error ?? "the scan could not start" }),
            )
            .catch((err: unknown) =>
              resolve({ started: false, error: err instanceof Error ? err.message : String(err) }),
            );
        }),
    );
    // No claim at all (the store or the claim failed) is an error, never a skip.
    if (!claim.started && claim.error !== undefined && claim.reason === undefined) {
      return jsonResponse({ ok: false, exitCode: 2, data: null, error: claim.error }, 500);
    }
    return jsonResponse(
      {
        ok: true,
        exitCode: 0,
        data: claim.started
          ? { started: true, repo }
          : { started: false, skipped: true, reason: claim.reason, repo },
      },
      200,
    );
  }

  const cancelMatch = /^\/ship-queue\/jobs\/([0-9]{1,16})\/cancel$/.exec(subPath);
  if (method === "POST" && cancelMatch?.[1]) {
    const res = yield* Effect.promise((signal) => cancelShipQueueJob(cancelMatch[1]!, signal));
    return jsonResponse(res, res.ok ? 200 : 400);
  }

  return null;
});

/**
 * Registers the periodic ship-queue dependency scan and bounded CI host tool-drift
 * convergence loops with MarsCode's `Scheduler` when present.
 */
export const registerShipQueueDepsScheduler = Effect.fn(
  "DevtoolsShipQueueRoutes.registerScheduler",
)(function* (queueRootOverride?: string) {
  const schedulerOpt = yield* Effect.serviceOption(Scheduler.Scheduler);
  if (Option.isNone(schedulerOpt)) return;
  const queueRoot = queueRootOverride ?? resolveQueueRoot(process.env);
  yield* schedulerOpt.value.register(
    "ship-queue-deps-scan",
    Effect.promise(() => scanDueDepsRepos({ queueRoot })).pipe(Effect.asVoid),
  );
  const marscodeRootOpt = yield* Config.String("MARSCODE_ROOT").pipe(
    Config.option,
    Effect.orElseSucceed(() => Option.none<string>()),
  );
  const marscodeRoot = Option.isSome(marscodeRootOpt)
    ? marscodeRootOpt.value.trim() || undefined
    : undefined;
  yield* schedulerOpt.value.register(
    "ship-queue-tool-drift-reconcile",
    Effect.promise(() =>
      reconcileDueToolDrift({
        queueRoot,
        marscodeRoot,
      }),
    ).pipe(Effect.asVoid),
  );
});
