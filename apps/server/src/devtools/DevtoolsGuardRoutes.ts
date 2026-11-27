import * as Effect from "effect/Effect";
import type { HttpServerRequest, HttpServerResponse } from "effect/http";

import type { GuardGrantBroker } from "./GuardGrantBroker.ts";
import { normalizeExceptions } from "@t3tools/playbook/bypass";

export interface GuardRouteHelpers {
  readonly jsonResponse: (body: unknown, status?: number) => HttpServerResponse.HttpServerResponse;
  readonly readJsonBody: Effect.Effect<
    | { readonly ok: true; readonly value: Record<string, unknown>; readonly raw?: string }
    | { readonly ok: false; readonly error: string; readonly status: number },
    never,
    HttpServerRequest.HttpServerRequest
  >;
  readonly session: { readonly method: string; readonly subject: string };
}

export function isGuardPrivilegedRoute(method: "GET" | "POST", subPath: string): boolean {
  return (
    subPath === "/guards/pending" ||
    subPath === "/guards/grants" ||
    subPath === "/guards/preapprove" ||
    /^\/guards\/requests\/[A-Za-z0-9_-]+\/resolve$/.test(subPath) ||
    (method === "POST" && /^\/guards\/grants\/[^/?#]+\/revoke$/.test(subPath))
  );
}

export const handleGuardRoute = Effect.fn("DevtoolsGuardRoutes.handle")(function* (
  method: "GET" | "POST",
  subPath: string,
  url: URL,
  broker: GuardGrantBroker,
  helpers: GuardRouteHelpers,
): Effect.fn.Return<
  HttpServerResponse.HttpServerResponse | null,
  never,
  HttpServerRequest.HttpServerRequest
> {
  if (method === "GET" && subPath === "/guards/pending") {
    return helpers.jsonResponse({
      listening: broker.listening,
      pending: broker.listPending(),
    });
  }

  if (method === "GET" && subPath === "/guards/grants") {
    const grants = yield* Effect.promise(() => broker.listActiveGrants());
    return helpers.jsonResponse({
      listening: broker.listening,
      grants,
    });
  }

  const revokeMatch = /^\/guards\/grants\/([^/?#]+)\/revoke$/.exec(subPath);
  if (method === "POST" && revokeMatch?.[1]) {
    const grantId = decodeURIComponent(revokeMatch[1]);
    const revoked = yield* Effect.promise(() =>
      broker.revokeGrant(grantId, `${helpers.session.method}:${helpers.session.subject}`),
    );
    if (!revoked) {
      return helpers.jsonResponse({ error: "Active grant not found or already revoked" }, 404);
    }
    return helpers.jsonResponse({ ok: true, grantId, revoked: true });
  }

  if (method === "GET" && subPath === "/guards/audit") {
    const limit = Number(url.searchParams.get("limit") ?? "50");
    const entries = yield* Effect.promise(() =>
      broker.readCombinedAudit(Number.isFinite(limit) ? limit : 50),
    );
    return helpers.jsonResponse({ entries });
  }

  if (method === "GET" && subPath === "/guards/exceptions") {
    const raw = broker.readExceptions();
    return helpers.jsonResponse({
      ...raw,
      waivers: normalizeExceptions(raw),
    });
  }

  const resolveMatch = /^\/guards\/requests\/([A-Za-z0-9_-]+)\/resolve$/.exec(subPath);
  if (method === "POST" && resolveMatch?.[1]) {
    const parsed = yield* helpers.readJsonBody;
    if (!parsed.ok) return helpers.jsonResponse({ error: parsed.error }, parsed.status);
    const decision = parsed.value.decision;
    if (decision !== "approve" && decision !== "deny") {
      return helpers.jsonResponse({ error: "decision must be 'approve' or 'deny'" }, 400);
    }
    const rawScope = parsed.value.scope;
    const scope = rawScope === "bundle" ? "bundle" : rawScope === "once" ? "once" : undefined;
    const reason = typeof parsed.value.reason === "string" ? parsed.value.reason : undefined;
    const result = broker.resolveRequest(resolveMatch[1], {
      decision,
      scope,
      reason,
      approvedVia: `${helpers.session.method}:${helpers.session.subject}`,
    });
    if (!result.found) {
      return helpers.jsonResponse(
        { error: "Pending guard request not found or already resolved" },
        404,
      );
    }
    if (result.persisted) {
      const ok = yield* Effect.promise(() => result.persisted!);
      if (!ok) {
        return helpers.jsonResponse({ error: "Failed to persist bundled guard grant" }, 500);
      }
    }
    return helpers.jsonResponse({
      ok: true,
      decision,
      ...(result.scope ? { scope: result.scope } : {}),
      ...(result.grantId ? { grantId: result.grantId } : {}),
    });
  }

  if (method === "POST" && subPath === "/guards/preapprove") {
    const parsed = yield* helpers.readJsonBody;
    if (!parsed.ok) return helpers.jsonResponse({ error: parsed.error }, parsed.status);
    const guard = typeof parsed.value.guard === "string" ? parsed.value.guard : "";
    const command = Array.isArray(parsed.value.command)
      ? parsed.value.command.filter((x): x is string => typeof x === "string")
      : [];
    const cwd = typeof parsed.value.cwd === "string" ? parsed.value.cwd : "";
    const reason = typeof parsed.value.reason === "string" ? parsed.value.reason : undefined;
    const threadId = typeof parsed.value.threadId === "string" ? parsed.value.threadId : undefined;
    const ttlMs = typeof parsed.value.ttlMs === "number" ? parsed.value.ttlMs : undefined;
    if (!broker.listening) {
      return helpers.jsonResponse({ error: "guard grant broker is not listening" }, 503);
    }
    const grant = broker.preapprove({
      guard,
      command,
      cwd,
      reason,
      threadId,
      ttlMs,
      approvedVia: `${helpers.session.method}:${helpers.session.subject}`,
    });
    if (!grant.ok) {
      return helpers.jsonResponse({ error: grant.error }, 400);
    }
    return helpers.jsonResponse(grant);
  }

  return null;
});
