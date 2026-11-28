// Shared HTTP auth policy, JSON body parsing, and SSE stream helpers for `/api/devtools/*`.
import {
  AuthAccessWriteScope,
  AuthDiagnosticsReadScope,
  type AuthEnvironmentScope,
  AuthOrchestrationReadScope,
  AuthTerminalOperateScope,
} from "@t3tools/contracts";
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import {
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
  failEnvironmentScopeRequired,
} from "../auth/http.ts";
import * as DevtoolsErrors from "./DevtoolsErrors.ts";
import { isGuardPrivilegedRoute } from "./DevtoolsGuardRoutes.ts";
import type { GuardBrokerEvent, GuardGrantBroker } from "./GuardGrantBroker.ts";

const JSON_MAX_BODY_BYTES = 64 * 1024;
const MAX_GUARD_SSE_STREAMS = 8;
const MAX_DEVDECK_SSE_STREAMS = 12;
const MAX_SHIP_QUEUE_SSE_STREAMS = 12;
const MAX_MUX_SSE_STREAMS = 16;
const SSE_HEARTBEAT_INTERVAL = "20 seconds" as const;
const decodeUnknownJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const SSE_HEADERS = {
  "cache-control": "no-store, no-transform",
  "x-accel-buffering": "no",
  "x-content-type-options": "nosniff",
} as const;

const NO_STORE_HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
} as const;

export interface SseChannelBucket {
  active: number;
  readonly limit: number;
}

export interface SseLimiter {
  readonly guards: SseChannelBucket;
  readonly devdeck: SseChannelBucket;
  readonly shipQueue: SseChannelBucket;
  readonly jobs: SseChannelBucket;
  readonly mux: SseChannelBucket;
}

export function createSseLimiter(): SseLimiter {
  return {
    guards: { active: 0, limit: MAX_GUARD_SSE_STREAMS },
    devdeck: { active: 0, limit: MAX_DEVDECK_SSE_STREAMS },
    shipQueue: { active: 0, limit: MAX_SHIP_QUEUE_SSE_STREAMS },
    jobs: { active: 0, limit: MAX_SHIP_QUEUE_SSE_STREAMS },
    mux: { active: 0, limit: MAX_MUX_SSE_STREAMS },
  };
}

export function jsonResponse(body: unknown, status = 200): HttpServerResponse.HttpServerResponse {
  let payload = body;
  if (status >= 400 && body !== null && typeof body === "object" && !Array.isArray(body)) {
    const rec = body as Record<string, unknown>;
    if (!("code" in rec)) {
      if (typeof rec.errorCode === "string" && rec.errorCode) {
        payload = { ...rec, code: rec.errorCode };
      } else if (typeof rec.error === "string" && rec.error) {
        payload = { ...rec, code: DevtoolsErrors.inferHttpErrorCode(status, rec.error) };
      }
    }
  }
  return HttpServerResponse.text(JSON.stringify(payload), {
    status,
    contentType: "application/json",
    headers: NO_STORE_HEADERS,
  });
}

export function isPeerOrMcpSubject(subject: string): boolean {
  return subject.startsWith("mcp-") || subject.startsWith("peer-link:");
}

export function decodeSafeJobIdParam(raw: string): string | null {
  try {
    const decoded = decodeURIComponent(raw);
    return /^[A-Za-z0-9:._-]{1,96}$/.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

export function requiredScopesForJsonRoute(
  method: "GET" | "POST",
  subPath: string,
): {
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly anyOfScopes?: ReadonlyArray<AuthEnvironmentScope>;
  readonly rejectPeerOrMcp?: boolean;
} {
  if (
    isGuardPrivilegedRoute(method, subPath) ||
    subPath === "/ship-queue/deps/decide" ||
    (method === "POST" &&
      (subPath === "/config" ||
        subPath === "/reaper/policy" ||
        subPath === "/reaper/proposals/decide" ||
        subPath === "/storage/review" ||
        subPath === "/storage/scan/refresh"))
  ) {
    return {
      scopes: [AuthTerminalOperateScope, AuthAccessWriteScope],
      rejectPeerOrMcp: true,
    };
  }
  if (
    method === "POST" &&
    (/^\/jobs\/[^/?#]+\/cancel$/.test(subPath) ||
      subPath === "/playbook/run" ||
      subPath === "/playbook/challenge" ||
      subPath === "/reaper/run" ||
      /^\/devdeck\/sessions\/[^/?#]+\/close$/.test(subPath) ||
      /^\/devdeck\/servers\/[^/?#]+(?:\/[^/?#]+)?\/stop$/.test(subPath) ||
      /^\/devdeck\/hosts\/[^/?#]+\/(?:provision|ci)$/.test(subPath))
  ) {
    return {
      scopes: [AuthTerminalOperateScope],
      rejectPeerOrMcp: true,
    };
  }
  if (method === "POST") {
    return { scopes: [AuthTerminalOperateScope] };
  }
  if (
    subPath === "/capabilities" ||
    subPath === "/config/resolved" ||
    subPath === "/fleet/self" ||
    subPath === "/jobs" ||
    subPath === "/ship-queue/status" ||
    subPath === "/ship-queue/deps"
  ) {
    return { scopes: [AuthOrchestrationReadScope] };
  }
  if (
    method === "GET" &&
    (subPath === "/config" ||
      subPath === "/config/fleet" ||
      subPath === "/review-stats" ||
      subPath === "/review-threads/verify" ||
      subPath === "/stats/cerno" ||
      subPath === "/reaper/policy" ||
      subPath === "/reaper/proposals")
  ) {
    return {
      scopes: [AuthDiagnosticsReadScope],
      rejectPeerOrMcp: true,
    };
  }
  if (/^\/jobs\/[^/?#]+$/.test(subPath)) {
    return {
      scopes: [AuthDiagnosticsReadScope],
      rejectPeerOrMcp: true,
    };
  }
  if (/^\/devdeck\/actions\/[^/?#]+$/.test(subPath)) {
    return {
      scopes: [],
      anyOfScopes: [AuthDiagnosticsReadScope, AuthTerminalOperateScope],
    };
  }
  return { scopes: [AuthDiagnosticsReadScope] };
}

export const authenticateJsonRequest = Effect.fnUntraced(function* (
  requiredScopes: ReadonlyArray<AuthEnvironmentScope>,
  rejectPeerOrMcp = false,
  anyOfScopes?: ReadonlyArray<AuthEnvironmentScope>,
) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const session = yield* serverAuth.authenticateHttpRequest(request).pipe(
    Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
      failEnvironmentAuthInvalid(
        EnvironmentAuth.serverAuthCredentialReason(error),
        EnvironmentAuth.serverAuthDpopFailureReason(error),
      ),
    ),
    Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
      failEnvironmentInternal("internal_error", error),
    ),
  );
  for (const scope of requiredScopes) {
    if (!session.scopes.includes(scope)) {
      return yield* failEnvironmentScopeRequired(scope);
    }
  }
  if (
    anyOfScopes &&
    anyOfScopes.length > 0 &&
    !anyOfScopes.some((s) => session.scopes.includes(s))
  ) {
    return yield* failEnvironmentScopeRequired(anyOfScopes[0]!);
  }
  if (rejectPeerOrMcp && isPeerOrMcpSubject(session.subject)) {
    return yield* failEnvironmentScopeRequired(AuthAccessWriteScope);
  }
  return session;
});

function isMaxBodySizeError(error: unknown, depth = 0): boolean {
  if (!error || depth > 4) return false;
  if (typeof error === "string") {
    return /max ?body|too large|exceeds|limit/i.test(error);
  }
  if (typeof error !== "object") return false;
  const e = error as {
    readonly _tag?: unknown;
    readonly reason?: unknown;
    readonly message?: unknown;
    readonly cause?: unknown;
  };
  if (e._tag === "MaxBodySize" || e.reason === "MaxBodySize") return true;
  if (typeof e.message === "string" && /max ?body|too large|exceeds|limit/i.test(e.message)) {
    return true;
  }
  return isMaxBodySizeError(e.reason, depth + 1) || isMaxBodySizeError(e.cause, depth + 1);
}

export const readJsonBody = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const declaredLength = Number(request.headers["content-length"] ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > JSON_MAX_BODY_BYTES) {
    return { ok: false as const, status: 413, error: "Request body too large" };
  }
  const textResult = yield* request.text.pipe(
    Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(JSON_MAX_BODY_BYTES)),
    Effect.map((text) => ({ ok: true as const, text })),
    Effect.catch((error) =>
      Effect.succeed({
        ok: false as const,
        status: isMaxBodySizeError(error) ? 413 : 400,
        error: isMaxBodySizeError(error) ? "Request body too large" : "Unable to read request body",
      }),
    ),
  );
  if (!textResult.ok) return textResult;
  const text = textResult.text;
  if (Buffer.byteLength(text, "utf8") > JSON_MAX_BODY_BYTES) {
    return { ok: false as const, status: 413, error: "Request body too large" };
  }
  if (!text.trim()) {
    return { ok: true as const, value: {} as Record<string, unknown>, raw: "" };
  }
  const parsed = yield* decodeUnknownJson(text).pipe(Effect.option);
  if (Option.isNone(parsed)) {
    return { ok: false as const, status: 400, error: "Malformed JSON body" };
  }
  if (!parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
    return { ok: false as const, status: 400, error: "Expected JSON object body" };
  }
  return { ok: true as const, value: parsed.value as Record<string, unknown>, raw: text };
});

export function webStreamToSseResponse(
  bucket: SseChannelBucket,
  makeStream: (signal: AbortSignal) => ReadableStream<Uint8Array>,
  invalidated: Effect.Effect<void, never>,
  withHeartbeat = false,
): HttpServerResponse.HttpServerResponse {
  if (bucket.active >= bucket.limit) {
    return jsonResponse({ error: "Too many active devtools event streams" }, 429);
  }
  bucket.active += 1;

  const bytes = Stream.unwrap(
    Effect.gen(function* () {
      const signal = yield* Effect.abortSignal;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          bucket.active = Math.max(0, bucket.active - 1);
        }),
      );
      return Stream.fromReadableStream({
        evaluate: () => makeStream(signal),
        onError: () => undefined,
      }).pipe(Stream.catch(() => Stream.empty));
    }),
  );

  const pingBytes = new TextEncoder().encode(": ping\n\n");
  const stream = withHeartbeat
    ? bytes.pipe(
        Stream.merge(
          Stream.tick(SSE_HEARTBEAT_INTERVAL).pipe(
            Stream.drop(1),
            Stream.map(() => pingBytes),
          ),
          { haltStrategy: "left" },
        ),
      )
    : bytes;

  return HttpServerResponse.stream(stream.pipe(Stream.interruptWhen(invalidated)), {
    contentType: "text/event-stream",
    headers: SSE_HEADERS,
  });
}

export function guardEventsSseResponse(
  bucket: SseChannelBucket,
  broker: GuardGrantBroker,
  invalidated: Effect.Effect<void, never>,
): HttpServerResponse.HttpServerResponse {
  if (bucket.active >= bucket.limit) {
    return jsonResponse({ error: "Too many active guard event streams" }, 429);
  }
  bucket.active += 1;

  const events = Stream.callback<GuardBrokerEvent>(
    (mailbox) =>
      Effect.gen(function* () {
        let snapshotSent = false;
        const buffered: Array<GuardBrokerEvent> = [];
        const unsubscribe = broker.subscribe((event) => {
          if (!snapshotSent) {
            buffered.push(event);
            return;
          }
          Queue.offerUnsafe(mailbox, event);
        });
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            unsubscribe();
            bucket.active = Math.max(0, bucket.active - 1);
            Queue.endUnsafe(mailbox);
          }),
        );
        const grants = yield* Effect.promise(() => broker.listActiveGrants()).pipe(
          Effect.orElseSucceed(() => []),
        );
        Queue.offerUnsafe(mailbox, {
          type: "snapshot",
          pending: broker.listPending(),
          grants,
        });
        snapshotSent = true;
        for (const ev of buffered) Queue.offerUnsafe(mailbox, ev);
        buffered.length = 0;
      }),
    { bufferSize: 64, strategy: "dropping" },
  );

  const encoded = events.pipe(Stream.map((event) => `data: ${JSON.stringify(event)}\n\n`));
  const heartbeat = Stream.tick(SSE_HEARTBEAT_INTERVAL).pipe(
    Stream.drop(1),
    Stream.map(() => ": ping\n\n"),
  );

  return HttpServerResponse.stream(
    encoded.pipe(
      Stream.merge(heartbeat, { haltStrategy: "left" }),
      Stream.encodeText,
      Stream.interruptWhen(invalidated),
    ),
    {
      contentType: "text/event-stream",
      headers: SSE_HEADERS,
    },
  );
}
