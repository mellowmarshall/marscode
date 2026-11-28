// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - Owner decisions on pending guard requests: once, bundle, and plan grants.
import * as NodeCrypto from "node:crypto";

import { PLAN_GRANT_TTL_MS } from "@t3tools/guard-protocol/plan";
import {
  sanitizeText,
  type GuardGrantScope,
  type PendingGuardRequest,
} from "@t3tools/guard-protocol/protocol";

import type { PendingEntry } from "./GuardBrokerTypes.ts";
import type { GuardGrantStore } from "./GuardGrantStore.ts";

export type PendingDecision = "approved" | "denied" | "expired" | "disconnected";

export interface GuardResolverContext {
  readonly pending: Map<string, PendingEntry>;
  readonly store: GuardGrantStore;
  readonly grantTtlMs: number;
  readonly broadcastGrantsChanged: () => void;
  readonly flushPendingSockets: (
    entry: PendingEntry,
    decision: PendingDecision,
    payload: Record<string, unknown>,
    reason: string,
  ) => void;
  readonly finishPending: (
    entry: PendingEntry,
    decision: PendingDecision,
    payload: Record<string, unknown>,
    reason?: string,
  ) => void;
}

export interface GuardResolveInput {
  readonly decision: "approve" | "deny";
  readonly scope?: GuardGrantScope | undefined;
  readonly reason?: string | undefined;
  readonly approvedVia?: string | undefined;
}

export interface GuardResolveResult {
  readonly found: boolean;
  readonly grantId?: string;
  readonly scope?: GuardGrantScope;
  readonly persisted?: Promise<boolean>;
}

function recordDecisionEvent(
  store: GuardGrantStore,
  req: PendingGuardRequest,
  eventType: "approved" | "denied",
  scope: GuardGrantScope,
  ts: string,
  reason: string,
  grantId?: string,
): void {
  store.recordEvent({
    ts,
    eventType,
    requestId: req.requestId,
    ...(grantId ? { grantId } : {}),
    threadId: req.threadId,
    guard: req.guard,
    scope,
    argvSha256: req.argvSha256,
    command: req.command,
    summary:
      req.bundle?.summary ??
      (req.plan ? `plan of ${req.plan.length} commands` : req.command.slice(0, 3).join(" ")),
    reason,
  });
}

export function resolveGuardRequest(
  ctx: GuardResolverContext,
  requestId: string,
  input: GuardResolveInput,
): GuardResolveResult {
  const entry = ctx.pending.get(requestId);
  if (!entry || entry.settled) return { found: false };
  const req = entry.request;
  const nowIso = new Date().toISOString();

  if (input.decision === "deny") {
    const reason = sanitizeText(input.reason, 400) || "denied by owner in T3 Code";
    recordDecisionEvent(
      ctx.store,
      req,
      "denied",
      req.bundleEligible ? "bundle" : "once",
      nowIso,
      reason,
    );
    ctx.finishPending(entry, "denied", { ok: false, denied: true, error: reason }, reason);
    return { found: true };
  }

  const grantId = `t3g_${NodeCrypto.randomBytes(12).toString("hex")}`;
  const reason = sanitizeText(input.reason, 400) || req.proposedReason || "approved in T3 Code";
  const approvedVia = input.approvedVia ?? "t3-input-request";
  const wantBundle =
    input.scope === "bundle" &&
    ctx.store.canSignBundles &&
    req.threadId.length > 0 &&
    req.bundleEligible === true &&
    req.bundle !== undefined &&
    !req.plan;

  if (wantBundle && req.bundle) {
    entry.settled = true;
    clearTimeout(entry.timer);
    ctx.pending.delete(req.requestId);
    const created = ctx.store.createSignedBundle({
      grantId,
      guard: req.guard,
      threadId: req.threadId,
      cwd: req.cwd,
      bundle: req.bundle,
      reason,
      approvedVia,
      nowIso,
      initialUseCount: entry.sockets.size > 0 ? 1 : 0,
      onPersisted: ctx.broadcastGrantsChanged,
    });
    const persisted = created.persisted.then((ok) => {
      if (!ok) {
        ctx.flushPendingSockets(
          entry,
          "denied",
          { ok: false, denied: false, error: "failed to persist bundle grant" },
          "failed to persist bundle grant",
        );
        return false;
      }
      recordDecisionEvent(ctx.store, req, "approved", "bundle", nowIso, reason, grantId);
      ctx.flushPendingSockets(
        entry,
        "approved",
        {
          ok: true,
          grant_id: grantId,
          scope: "bundle",
          reason,
          approved_by: "human",
          ...(input.approvedVia ? { approved_via: input.approvedVia } : {}),
          signature: created.signature,
          thread_id: req.threadId,
        },
        reason,
      );
      return true;
    });
    return { found: true, grantId, scope: "bundle", persisted };
  }

  if (entry.storeGrant || entry.sockets.size === 0) {
    if (!req.threadId) {
      ctx.finishPending(entry, "denied", {
        ok: false,
        denied: true,
        error: "override requests require a verified thread_id",
      });
      return { found: true };
    }
    if (!ctx.store.canAddOnceGrant(req.plan?.length ?? 1)) {
      ctx.finishPending(entry, "denied", {
        ok: false,
        denied: false,
        error: "too many pre-approved grants pending",
      });
      return { found: true };
    }
    if (req.plan) {
      ctx.store.plans.put({
        grantId,
        entries: req.plan,
        cwd: req.cwd,
        threadId: req.threadId,
        reason,
        approvedVia: input.approvedVia,
        expiresAtMs: Date.now() + PLAN_GRANT_TTL_MS,
      });
    } else {
      ctx.store.putOnceGrant({
        grantId,
        guard: req.guard,
        argvSha256: req.argvSha256,
        cwd: req.cwd,
        reason,
        approvedBy: "human",
        approvedVia: input.approvedVia,
        threadId: req.threadId,
        expiresAtMs: Date.now() + ctx.grantTtlMs,
      });
    }
  }

  recordDecisionEvent(ctx.store, req, "approved", "once", nowIso, reason, grantId);
  ctx.finishPending(
    entry,
    "approved",
    {
      ok: true,
      grant_id: grantId,
      scope: "once",
      reason,
      approved_by: "human",
      ...(input.approvedVia ? { approved_via: input.approvedVia } : {}),
      ...(entry.storeGrant ? { stored: true } : {}),
      thread_id: req.threadId,
    },
    reason,
  );
  return { found: true, grantId, scope: "once" };
}
