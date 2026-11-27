/**
 * Modular HTTP + SSE router for dev's devtools under `/api/devtools/*`.
 * Enforces HTTP Bearer/DPoP/cookie auth on JSON routes and media auth on SSE streams.
 */
import * as NodeOS from "node:os";

import {
  AuthAccessWriteScope,
  AuthDiagnosticsReadScope,
  type AuthEnvironmentScope,
  AuthOrchestrationReadScope,
  AuthTerminalOperateScope,
  CommandId,
  MessageId,
  type ModelSelection,
  ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { aggregateReviewStats } from "@t3tools/playbook/statsAggregate";
import type { ReviewStatsGroupBy, ReviewStatsSide } from "@t3tools/playbook/statsTypes";
import * as ByteSize from "effect/ByteSize";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import {
  authenticateMediaRequest,
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
  failEnvironmentScopeRequired,
} from "../auth/http.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerConfig from "../config.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as GuardGrants from "../persistence/GuardGrants.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as StorageCleanup from "../storageCleanup.ts";
import { requestUrl } from "../requestUrl.ts";
import * as UsageLimitSources from "../usage/UsageLimitSources.ts";
import * as CernoStats from "./CernoStats.ts";
import * as CliRunners from "./CliRunners.ts";
import * as DevtoolsConfig from "./DevtoolsConfig.ts";
import * as DevtoolsErrors from "./DevtoolsErrors.ts";
import * as DevtoolsEventMux from "./DevtoolsEventMux.ts";
import * as DevtoolsFleetConfig from "./DevtoolsFleetConfig.ts";
import * as DevtoolsFleetConfigCache from "./DevtoolsFleetConfigCache.ts";
import { handleGuardRoute, isGuardPrivilegedRoute } from "./DevtoolsGuardRoutes.ts";
import { handleNativeFleetRequest } from "./fleet/FleetRoutes.ts";
import type { NativeFleetService } from "./fleet/NativeFleetService.ts";
import { makeNativeFleetFromContext } from "./fleet/NativeFleetWiring.ts";
import { isAllowedFleetPath } from "./fleet/FleetRoutePolicy.ts";
import { GuardGrantBroker, type GuardBrokerEvent } from "./GuardGrantBroker.ts";
import * as JobRegistry from "./jobs/JobRegistry.ts";
import { handlePlaybookRoute } from "./DevtoolsPlaybookRoutes.ts";
import * as ReaperPolicy from "./ReaperPolicy.ts";
import * as Reaper from "./reaper/ReaperService.ts";
import * as ReviewStats from "./ReviewStats.ts";
import * as ReviewStatsThreads from "./ReviewStatsThreads.ts";
import * as StorageManifest from "./StorageManifest.ts";
import * as TrustedProviderRegistry from "./TrustedProviderRegistry.ts";

const DEVTOOLS_ROUTE_PREFIX = "/api/devtools";

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

const TEMP_DIR_PREFIXES = [
  "/tmp/",
  "/var/tmp/",
  "/private/tmp/",
  "/private/var/tmp/",
  "/var/folders/",
  "/private/var/folders/",
];

function jsonResponse(body: unknown, status = 200): HttpServerResponse.HttpServerResponse {
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

function isPeerOrMcpSubject(subject: string): boolean {
  return subject.startsWith("mcp-") || subject.startsWith("peer-link:");
}

function decodeSafeJobIdParam(raw: string): string | null {
  try {
    const decoded = decodeURIComponent(raw);
    return /^[A-Za-z0-9:._-]{1,96}$/.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

function requiredScopesForJsonRoute(
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
      subPath === "/reaper/policy")
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

const authenticateJsonRequest = Effect.fnUntraced(function* (
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

const readJsonBody = Effect.gen(function* () {
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
  if (!textResult.ok) {
    return textResult;
  }
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

interface SseChannelBucket {
  active: number;
  readonly limit: number;
}

interface SseLimiter {
  readonly guards: SseChannelBucket;
  readonly devdeck: SseChannelBucket;
  readonly shipQueue: SseChannelBucket;
  readonly jobs: SseChannelBucket;
  readonly mux: SseChannelBucket;
}

function createSseLimiter(): SseLimiter {
  return {
    guards: { active: 0, limit: MAX_GUARD_SSE_STREAMS },
    devdeck: { active: 0, limit: MAX_DEVDECK_SSE_STREAMS },
    shipQueue: { active: 0, limit: MAX_SHIP_QUEUE_SSE_STREAMS },
    jobs: { active: 0, limit: MAX_SHIP_QUEUE_SSE_STREAMS },
    mux: { active: 0, limit: MAX_MUX_SSE_STREAMS },
  };
}

function webStreamToSseResponse(
  bucket: SseChannelBucket,
  makeStream: (signal: AbortSignal) => ReadableStream<Uint8Array>,
  invalidated: Effect.Effect<void, never>,
  withHeartbeat = false,
): HttpServerResponse.HttpServerResponse {
  if (bucket.active >= bucket.limit) {
    return jsonResponse({ error: "Too many active devtools event streams" }, 429);
  }
  bucket.active += 1;

  // Stream.fromReadableStream preserves pull-based backpressure and never interleaves chunks.
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

function guardEventsSseResponse(
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
        for (const ev of buffered) {
          Queue.offerUnsafe(mailbox, ev);
        }
        buffered.length = 0;
      }),
    { bufferSize: 64, strategy: "dropping" },
  );

  const encoded = events.pipe(Stream.map((event) => `data: ${JSON.stringify(event)}\n\n`));
  // Frame-level merge before text encoding guarantees `: ping` never splits a JSON frame.
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

export interface DevtoolsDeps {
  readonly broker?: GuardGrantBroker | undefined;
  readonly startBroker?: boolean | undefined;
  readonly nativeFleet?: NativeFleetService | undefined;
}

function shouldAutoStartBroker(
  path: Path.Path,
  config: Option.Option<ServerConfig.ServerConfig["Service"]>,
): boolean {
  if (Option.isNone(config)) return true;
  const baseDir = path.resolve(config.value.baseDir);
  if (TEMP_DIR_PREFIXES.some((prefix) => baseDir.startsWith(prefix))) {
    return false;
  }
  return config.value.devUrl === undefined;
}

let consoleDepsSeq = 0;

function nextConsoleDepsThreadId(): string {
  consoleDepsSeq += 1;
  return `t3-console-deps-${process.pid}-${consoleDepsSeq}`;
}

export const makeHandler = Effect.fn("DevtoolsHttp.makeHandler")(function* (
  broker: GuardGrantBroker,
  jobRegistry: JobRegistry.JobRegistryService,
  sseLimiter: SseLimiter = createSseLimiter(),
  shipQueueRootOverride?: string,
  nativeFleet?: NativeFleetService,
) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = requestUrl(request);
  if (Option.isNone(url)) {
    return jsonResponse({ error: "Bad Request" }, 400);
  }

  const subPath = url.value.pathname.slice(DEVTOOLS_ROUTE_PREFIX.length) || "/";
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "POST") {
    return jsonResponse({ error: "Method Not Allowed" }, 405);
  }

  const isSseRoute =
    method === "GET" &&
    (subPath === "/events" ||
      subPath === "/guards/events" ||
      subPath === "/devdeck/events" ||
      subPath === "/ship-queue/events" ||
      subPath === "/jobs/events");

  if (isSseRoute) {
    if (subPath === "/events") {
      // Authenticate before validating query parameters so unauthenticated callers always get 401.
      const session = yield* authenticateMediaRequest(AuthOrchestrationReadScope);
      const incoming = new URLSearchParams(url.value.search);
      const topics = DevtoolsEventMux.parseMuxTopics(incoming.get("topics"));
      if (!topics) {
        return jsonResponse({ error: "Invalid or missing topics parameter" }, 400);
      }
      if (topics.has("guards")) {
        if (!session.scopes.includes(AuthTerminalOperateScope)) {
          return yield* failEnvironmentScopeRequired(AuthTerminalOperateScope);
        }
        if (!session.scopes.includes(AuthAccessWriteScope) || isPeerOrMcpSubject(session.subject)) {
          return yield* failEnvironmentScopeRequired(AuthAccessWriteScope);
        }
      }
      if (topics.has("devdeck") && !session.scopes.includes(AuthDiagnosticsReadScope)) {
        return yield* failEnvironmentScopeRequired(AuthDiagnosticsReadScope);
      }
      const forwardParams = new URLSearchParams();
      for (const key of ["panels", "passive", "delta", "node"]) {
        const val = incoming.get(key);
        if (val !== null) forwardParams.set(key, val);
      }
      const qs = forwardParams.toString();
      const devdeckApiPath = qs ? `/api/events?${qs}` : "/api/events";
      if (topics.has("devdeck") && !isAllowedFleetPath("GET", devdeckApiPath)) {
        return jsonResponse({ error: "Invalid DevDeck event parameters" }, 400);
      }
      const sessions = yield* SessionStore.SessionStore;
      const invalidated = sessions.awaitInvalidation(session.sessionId).pipe(
        Effect.catchTags({
          SessionCredentialVerificationError: (error) =>
            failEnvironmentInternal("internal_error", error).pipe(Effect.ignore),
        }),
      );
      const includeCmdline =
        session.scopes.includes(AuthDiagnosticsReadScope) && !isPeerOrMcpSubject(session.subject);
      return webStreamToSseResponse(
        sseLimiter.mux,
        (signal) =>
          DevtoolsEventMux.createMultiplexedEventStream(signal, {
            topics,
            broker,
            jobRegistry,
            includeCmdline,
            devdeckApiPath,
            nativeFleet,
          }),
        invalidated,
        true,
      );
    }

    const primaryScope =
      subPath === "/guards/events"
        ? AuthTerminalOperateScope
        : subPath === "/devdeck/events"
          ? AuthDiagnosticsReadScope
          : AuthOrchestrationReadScope;
    const session = yield* authenticateMediaRequest(primaryScope);
    if (
      subPath === "/guards/events" &&
      (!session.scopes.includes(AuthAccessWriteScope) || isPeerOrMcpSubject(session.subject))
    ) {
      return yield* failEnvironmentScopeRequired(AuthAccessWriteScope);
    }
    const sessions = yield* SessionStore.SessionStore;
    const invalidated = sessions.awaitInvalidation(session.sessionId).pipe(
      Effect.catchTags({
        SessionCredentialVerificationError: (error) =>
          failEnvironmentInternal("internal_error", error).pipe(Effect.ignore),
      }),
    );

    if (subPath === "/guards/events") {
      return guardEventsSseResponse(sseLimiter.guards, broker, invalidated);
    }

    if (subPath === "/devdeck/events") {
      const rawQuery = url.value.search;
      const forwardParams = new URLSearchParams();
      if (rawQuery) {
        const incoming = new URLSearchParams(rawQuery);
        for (const key of ["panels", "passive", "delta", "node"]) {
          const val = incoming.get(key);
          if (val !== null) forwardParams.set(key, val);
        }
      }
      const qs = forwardParams.toString();
      const devdeckApiPath = qs ? `/api/events?${qs}` : "/api/events";
      if (!isAllowedFleetPath("GET", devdeckApiPath)) {
        return jsonResponse({ error: "Invalid DevDeck event parameters" }, 400);
      }
      if (!nativeFleet) {
        return jsonResponse({ error: "Native fleet telemetry unavailable" }, 503);
      }
      return webStreamToSseResponse(
        sseLimiter.devdeck,
        (signal) => nativeFleet.createEventStream(signal, devdeckApiPath),
        invalidated,
      );
    }

    if (subPath === "/jobs/events") {
      const includeCmdline =
        session.scopes.includes(AuthDiagnosticsReadScope) && !isPeerOrMcpSubject(session.subject);
      return webStreamToSseResponse(
        sseLimiter.jobs,
        (signal) => jobRegistry.createEventsStream(signal, { includeCmdline }),
        invalidated,
      );
    }

    return webStreamToSseResponse(
      sseLimiter.shipQueue,
      (signal) => CliRunners.createShipQueueEventStream(signal),
      invalidated,
    );
  }

  // Non-SSE JSON routes NEVER accept query-string media tickets; enforce least-privilege per route.
  const routeAuth = requiredScopesForJsonRoute(method, subPath);
  const session = yield* authenticateJsonRequest(
    routeAuth.scopes,
    routeAuth.rejectPeerOrMcp === true,
    routeAuth.anyOfScopes,
  );

  if (method === "GET" && subPath === "/capabilities") {
    const platform = yield* HostProcess.Platform;
    const hostnameOpt = yield* Effect.serviceOption(HostProcess.Hostname);
    const localHost = Option.getOrElse(hostnameOpt, () => NodeOS.hostname());
    const canReadDiagnostics = session.scopes.includes(AuthDiagnosticsReadScope);
    const canOperateTerminal = session.scopes.includes(AuthTerminalOperateScope);
    const canApproveGuards =
      canOperateTerminal &&
      session.scopes.includes(AuthAccessWriteScope) &&
      !isPeerOrMcpSubject(session.subject);
    const useNativeFleet = Boolean(nativeFleet);
    const devdeckHealth = { reachable: useNativeFleet, passiveSupported: useNativeFleet };
    const tools = {
      ...CliRunners.discoverTools(useNativeFleet),
      reaper: Option.isSome(yield* Effect.serviceOption(Reaper.ReaperService)),
    };
    const services = DevtoolsErrors.buildServiceHealth({
      devdeckInstalled: tools.devdeck,
      devdeckReachable: devdeckHealth.reachable,
      guardBrokerListening: broker.listening,
      shipQueueInstalled: tools.shipQueue,
      reaperInstalled: tools.reaper,
      playbookInstalled: tools.playbook,
    });
    return jsonResponse({
      host: localHost,
      platform,
      guardBrokerListening: broker.listening,
      canApproveGuards,
      canReadDiagnostics,
      canOperateTerminal,
      devdeckReachable: devdeckHealth.reachable,
      devdeckPassiveSupported: devdeckHealth.passiveSupported,
      nativeFleet: useNativeFleet,
      multiplexedEvents: true,
      tools,
      services,
    });
  }

  if (method === "GET" && subPath === "/fleet/self") {
    if (!nativeFleet) {
      return jsonResponse({ error: "Native fleet telemetry unavailable" }, 503);
    }
    const selfState = yield* Effect.promise(() => nativeFleet.readFreshSelfNodeState());
    return jsonResponse(selfState);
  }

  const guardResponse = yield* handleGuardRoute(method, subPath, url.value, broker, {
    jsonResponse,
    readJsonBody,
    session,
  });
  if (guardResponse !== null) {
    return guardResponse;
  }

  const playbookResponse = yield* handlePlaybookRoute(method, subPath, url.value, broker, {
    jsonResponse,
    readJsonBody,
    session,
  });
  if (playbookResponse !== null) {
    return playbookResponse;
  }

  if (subPath.startsWith("/devdeck/")) {
    const rawSuffix = subPath.slice("/devdeck/".length);
    const querySuffix = url.value.search ? url.value.search : "";
    const devdeckApiPath = `/api/${rawSuffix}${querySuffix}`;
    if (!isAllowedFleetPath(method, devdeckApiPath)) {
      return jsonResponse({ error: "DevDeck route not allowed" }, 404);
    }
    let parsedBody: Record<string, unknown> | undefined;
    if (method === "POST") {
      const parsed = yield* readJsonBody;
      if (!parsed.ok) return jsonResponse({ error: parsed.error }, parsed.status);
      parsedBody = parsed.value;
    }
    if (!nativeFleet) {
      return jsonResponse({ error: "Native fleet telemetry unavailable" }, 503);
    }
    const nativeRes = yield* Effect.promise(() =>
      handleNativeFleetRequest(nativeFleet, method, devdeckApiPath, parsedBody),
    );
    return jsonResponse(nativeRes.body, nativeRes.status);
  }

  if (method === "GET" && subPath === "/jobs") {
    const refresh = url.value.searchParams.get("refresh") === "1";
    const includeCmdline =
      session.scopes.includes(AuthDiagnosticsReadScope) && !isPeerOrMcpSubject(session.subject);
    const jobs = yield* Effect.promise(() => jobRegistry.listJobs({ refresh, includeCmdline }));
    return jsonResponse({ jobs, queueMeta: jobRegistry.getQueueMeta() });
  }

  const jobCancelMatch = /^\/jobs\/([^/?#]+)\/cancel$/.exec(subPath);
  if (method === "POST" && jobCancelMatch?.[1]) {
    const jobId = decodeSafeJobIdParam(jobCancelMatch[1]);
    if (!jobId) return jsonResponse({ error: "Invalid job id" }, 400);
    const res = yield* Effect.promise((signal) => jobRegistry.cancelJob(jobId, signal));
    return jsonResponse(res, res.ok ? 200 : 400);
  }

  const jobDetailMatch = /^\/jobs\/([^/?#]+)$/.exec(subPath);
  if (method === "GET" && jobDetailMatch?.[1]) {
    const jobId = decodeSafeJobIdParam(jobDetailMatch[1]);
    if (!jobId) return jsonResponse({ error: "Invalid job id" }, 400);
    const detail = yield* Effect.promise(() => jobRegistry.getJobDetail(jobId));
    if (!detail) return jsonResponse({ error: "Job not found" }, 404);
    return jsonResponse(detail);
  }

  if (method === "GET" && subPath === "/ship-queue/status") {
    const res = yield* Effect.promise(() => CliRunners.getShipQueueStatus());
    return jsonResponse(res, res.ok ? 200 : 503);
  }

  if (method === "GET" && subPath === "/ship-queue/deps") {
    return jsonResponse(CliRunners.readShipQueueDeps(shipQueueRootOverride));
  }

  if (method === "POST" && subPath === "/ship-queue/deps/decide") {
    const parsed = yield* readJsonBody;
    if (!parsed.ok) return jsonResponse({ error: parsed.error }, parsed.status);
    const reportId = typeof parsed.value.reportId === "string" ? parsed.value.reportId.trim() : "";
    const decision = parsed.value.decision;
    if (!reportId || !/^[A-Za-z0-9._-]+:[A-Za-z0-9._-]+$/.test(reportId)) {
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
    const grant = broker.preapprove({
      guard: "owner-check",
      command: ["ship-queue", "deps", "decide", reportId, decision],
      cwd,
      reason,
      threadId,
      ttlMs: 30_000,
      approvedVia: `${session.method}:${session.subject}`,
    });
    if (!grant.ok) {
      return jsonResponse({ error: grant.error }, 400);
    }
    const res = yield* Effect.promise((signal) =>
      CliRunners.decideShipQueueDeps({
        reportId,
        decision,
        cwd,
        extraEnv: { T3CODE_THREAD_ID: threadId },
        signal,
      }),
    );
    return jsonResponse(res, res.ok ? 200 : 400);
  }

  if (method === "POST" && subPath === "/ship-queue/deps/scan") {
    const parsed = yield* readJsonBody;
    if (!parsed.ok) return jsonResponse({ error: parsed.error }, parsed.status);
    const repo = typeof parsed.value.repo === "string" ? parsed.value.repo.trim() : "";
    if (!repo || !/^[A-Za-z0-9._-]+$/.test(repo)) {
      return jsonResponse({ error: "Invalid repository name" }, 400);
    }
    const res = CliRunners.scanShipQueueDeps(repo);
    return jsonResponse(res, res.ok ? 200 : 400);
  }

  const cancelMatch = /^\/ship-queue\/jobs\/([0-9]{1,16})\/cancel$/.exec(subPath);
  if (method === "POST" && cancelMatch?.[1]) {
    const res = yield* Effect.promise((signal) =>
      CliRunners.cancelShipQueueJob(cancelMatch[1]!, signal),
    );
    return jsonResponse(res, res.ok ? 200 : 400);
  }

  if (
    (method === "GET" && (subPath === "/reaper/status" || subPath === "/reaper/cargo-dry-run")) ||
    (method === "POST" && subPath === "/reaper/run")
  ) {
    const reaper = yield* Effect.serviceOption(Reaper.ReaperService);
    if (Option.isNone(reaper)) {
      return jsonResponse({ ok: false, exitCode: 1, data: null, error: "Reaper unavailable" }, 503);
    }
    let data: unknown;
    if (subPath === "/reaper/status") {
      data = yield* reaper.value.status;
    } else if (subPath === "/reaper/cargo-dry-run") {
      data = yield* reaper.value.cargo(true);
    } else {
      const parsed = yield* readJsonBody;
      if (!parsed.ok) return jsonResponse({ error: parsed.error }, parsed.status);
      data = yield* reaper.value.run({ cargoOnly: parsed.value.cargoOnly === true });
    }
    return jsonResponse({ ok: true, exitCode: 0, data }, 200);
  }

  if (method === "GET" && subPath === "/config/fleet") {
    const providerRegOpt = yield* Effect.serviceOption(ProviderRegistry.ProviderRegistry);
    const limitSourcesOpt = yield* Effect.serviceOption(UsageLimitSources.UsageLimitSources);
    const providers = Option.isSome(providerRegOpt)
      ? yield* providerRegOpt.value.getProviders.pipe(Effect.orElseSucceed(() => []))
      : [];
    const limitSources = Option.isSome(limitSourcesOpt)
      ? yield* limitSourcesOpt.value.current.pipe(Effect.orElseSucceed(() => []))
      : [];
    const refresh = url.value.searchParams.get("refresh") === "1";
    const snapshot = yield* Effect.promise((signal) =>
      DevtoolsFleetConfigCache.getCachedFleetConfigSnapshot({ refresh, signal }),
    );
    const resolved = {
      playbookChallenge: DevtoolsConfig.resolveReviewRolePlan(
        "playbook_challenge",
        snapshot.localConfig,
        { providers, limitSources },
      ),
      shipQueueReview: DevtoolsConfig.resolveReviewRolePlan(
        "ship_queue_review",
        snapshot.localConfig,
        { providers, limitSources },
      ),
    };
    return jsonResponse({
      ...snapshot,
      configPath: DevtoolsConfig.defaultHostConfigPath(),
      resolved,
    });
  }

  if (method === "GET" && (subPath === "/config" || subPath === "/config/resolved")) {
    const providerRegOpt = yield* Effect.serviceOption(ProviderRegistry.ProviderRegistry);
    const limitSourcesOpt = yield* Effect.serviceOption(UsageLimitSources.UsageLimitSources);
    const providers = Option.isSome(providerRegOpt)
      ? yield* providerRegOpt.value.getProviders.pipe(Effect.orElseSucceed(() => []))
      : [];
    const limitSources = Option.isSome(limitSourcesOpt)
      ? yield* limitSourcesOpt.value.current.pipe(Effect.orElseSucceed(() => []))
      : [];
    const hostParam = url.value.searchParams.get("host")?.trim() ?? "";
    let config = DevtoolsConfig.readDevtoolsHostConfig();
    let configPath = DevtoolsConfig.defaultHostConfigPath();
    let hostName: string | undefined;
    let reachable = true;
    let exists = true;
    if (
      subPath === "/config" &&
      hostParam &&
      hostParam.toLowerCase() !== "all" &&
      hostParam.toLowerCase() !== "local"
    ) {
      const target = DevtoolsFleetConfig.findFleetHost(hostParam);
      if (!target) {
        return jsonResponse({ error: `Unknown fleet host: ${hostParam}` }, 404);
      }
      const state = yield* Effect.promise((signal) =>
        DevtoolsFleetConfig.readFleetHostConfig(target, config, { signal }),
      );
      if (!state.reachable || !state.config) {
        return jsonResponse(
          {
            error: state.error ?? `Host ${target.name} is unreachable`,
            host: target.name,
            reachable: state.reachable,
            configPath: state.configPath,
          },
          502,
        );
      }
      config = state.config;
      configPath = state.configPath;
      hostName = target.name;
      reachable = state.reachable;
      exists = state.exists;
    }
    const resolved = {
      playbookChallenge: DevtoolsConfig.resolveReviewRolePlan("playbook_challenge", config, {
        providers,
        limitSources,
      }),
      shipQueueReview: DevtoolsConfig.resolveReviewRolePlan("ship_queue_review", config, {
        providers,
        limitSources,
      }),
    };
    if (subPath === "/config/resolved") {
      return jsonResponse({ resolved });
    }
    return jsonResponse({
      configPath,
      config,
      resolved,
      ...(hostName ? { host: hostName, reachable, exists } : {}),
    });
  }

  if (method === "POST" && subPath === "/config") {
    const parsed = yield* readJsonBody;
    if (!parsed.ok) return jsonResponse({ error: parsed.error }, parsed.status);
    const targetHost =
      typeof parsed.value.targetHost === "string" ? parsed.value.targetHost.trim() : "";

    let resultingConfig: DevtoolsConfig.DevtoolsHostConfig | null = null;
    let fleetResults: ReadonlyArray<DevtoolsFleetConfig.FleetWriteResultEntry> | undefined;
    let overallOk = true;

    if (targetHost && targetHost.toLowerCase() !== "local") {
      const precheck = DevtoolsConfig.prepareMergedHostConfig({}, parsed.value);
      if (!precheck.ok) {
        return jsonResponse({ error: precheck.error }, 400);
      }
      if (targetHost.toLowerCase() !== "all" && !DevtoolsFleetConfig.findFleetHost(targetHost)) {
        return jsonResponse({ error: `Unknown fleet host: ${targetHost}` }, 400);
      }
      const fleetRes = yield* Effect.promise((signal) =>
        DevtoolsFleetConfig.writeFleetHostConfig(targetHost, parsed.value, { signal }),
      );
      overallOk = fleetRes.ok;
      fleetResults = fleetRes.results;
      resultingConfig = fleetRes.config ?? DevtoolsConfig.readDevtoolsHostConfig();
      const localEntry = fleetRes.results.find((r) => r.local && r.ok && r.config);
      if (localEntry?.config) {
        broker.setRuntimeTimeouts({
          defaultGrantTtlMs: localEntry.config.guards.grant_ttl_s * 1000,
          defaultRequestTimeoutMs: localEntry.config.guards.request_timeout_s * 1000,
        });
        jobRegistry.setDefaultStallMinutes(localEntry.config.jobs.default_stall_minutes);
      }
    } else {
      const written = DevtoolsConfig.writeDevtoolsHostConfig(parsed.value);
      if (!written.ok) {
        return jsonResponse({ error: written.error }, 400);
      }
      resultingConfig = written.config;
      broker.setRuntimeTimeouts({
        defaultGrantTtlMs: written.config.guards.grant_ttl_s * 1000,
        defaultRequestTimeoutMs: written.config.guards.request_timeout_s * 1000,
      });
      jobRegistry.setDefaultStallMinutes(written.config.jobs.default_stall_minutes);
    }

    DevtoolsFleetConfigCache.invalidateFleetConfigCache();

    const providerRegOpt = yield* Effect.serviceOption(ProviderRegistry.ProviderRegistry);
    const limitSourcesOpt = yield* Effect.serviceOption(UsageLimitSources.UsageLimitSources);
    const providers = Option.isSome(providerRegOpt)
      ? yield* providerRegOpt.value.getProviders.pipe(Effect.orElseSucceed(() => []))
      : [];
    const limitSources = Option.isSome(limitSourcesOpt)
      ? yield* limitSourcesOpt.value.current.pipe(Effect.orElseSucceed(() => []))
      : [];
    return jsonResponse({
      ok: overallOk,
      configPath: DevtoolsConfig.defaultHostConfigPath(),
      config: resultingConfig,
      ...(targetHost ? { targetHost } : {}),
      ...(fleetResults ? { results: fleetResults } : {}),
      resolved: {
        playbookChallenge: DevtoolsConfig.resolveReviewRolePlan(
          "playbook_challenge",
          resultingConfig,
          {
            providers,
            limitSources,
          },
        ),
        shipQueueReview: DevtoolsConfig.resolveReviewRolePlan(
          "ship_queue_review",
          resultingConfig,
          {
            providers,
            limitSources,
          },
        ),
      },
    });
  }

  if (method === "GET" && subPath === "/review-stats") {
    const sp = url.value.searchParams;
    const rawSide = sp.get("side") ?? "reviewer";
    const side: ReviewStatsSide =
      rawSide === "submitter" || rawSide === "pair" ? rawSide : "reviewer";
    const rawBy = sp.get("by") ?? "model";
    const validBy = new Set<ReviewStatsGroupBy>([
      "model",
      "family",
      "lab",
      "provider",
      "repo",
      "source",
      "effort",
      "day",
    ]);
    const by: ReviewStatsGroupBy = validBy.has(rawBy as ReviewStatsGroupBy)
      ? (rawBy as ReviewStatsGroupBy)
      : "model";
    const rawSource = sp.get("source") ?? "all";
    const source: "all" | "playbook_challenge" | "ship_queue_review" =
      rawSource === "playbook_challenge" || rawSource === "ship_queue_review" ? rawSource : "all";
    const repo = sp.get("repo")?.trim() || undefined;
    const lab = sp.get("lab")?.trim() || undefined;
    const family = sp.get("family")?.trim() || undefined;
    const host = sp.get("host")?.trim() || undefined;
    const daysRaw = Number(sp.get("days") ?? "");
    const days = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.round(daysRaw) : undefined;
    const includeBypasses = sp.get("includeBypasses") === "1";

    const forceRefresh = sp.get("refresh") === "1" || sp.has("_r");

    const sqlOpt = yield* Effect.serviceOption(SqlClient.SqlClient);
    let lookup: ReviewStatsThreads.ThreadSubmitterLookup | undefined;
    let delegatedReviews: ReadonlyArray<ReviewStatsThreads.DelegatedReviewSubagentRow> | undefined;
    if (Option.isSome(sqlOpt)) {
      const cachedLookup = ReviewStats.getCachedSubmitterLookup(forceRefresh);
      if (cachedLookup) {
        lookup = cachedLookup;
      } else {
        const rows = yield* sqlOpt.value<{
          readonly thread_id: string;
          readonly model: string | null;
          readonly instance_id: string | null;
          readonly provider: string | null;
          readonly default_provider: string | null;
          readonly options_json: string | null;
          readonly branch: string | null;
          readonly worktree_path: string | null;
          readonly is_subagent: number;
        }>`
          SELECT
            thread_id,
            json_extract(payload_json, '$.modelSelection.model') AS model,
            json_extract(payload_json, '$.modelSelection.instanceId') AS instance_id,
            json_extract(payload_json, '$.modelSelection.provider') AS provider,
            default_provider,
            json_extract(payload_json, '$.modelSelection.options') AS options_json,
            json_extract(payload_json, '$.branch') AS branch,
            json_extract(payload_json, '$.worktreePath') AS worktree_path,
            CASE
              WHEN thread_id LIKE 'thread:delegated-task:%'
                OR COALESCE(json_extract(payload_json, '$.lineage.relationshipToParent'), '') = 'subagent'
              THEN 1
              ELSE 0
            END AS is_subagent
          FROM orchestration_v2_projection_threads
          WHERE deleted_at IS NULL
          ORDER BY updated_at ASC
        `.pipe(Effect.orElseSucceed(() => []));
        lookup = ReviewStatsThreads.buildSubmitterLookupFromRows(rows);
        ReviewStats.setCachedSubmitterLookup(lookup);
      }

      const cachedDelegated = ReviewStats.getCachedDelegatedReviews(forceRefresh);
      if (cachedDelegated) {
        delegatedReviews = cachedDelegated;
      } else {
        const subRows = yield* sqlOpt.value<ReviewStatsThreads.RawSubagentProjectionRow>`
          SELECT
            subagent_id,
            thread_id,
            child_thread_id,
            status,
            started_at,
            completed_at,
            updated_at,
            provider,
            driver,
            provider_instance_id,
            payload_json
          FROM orchestration_v2_projection_subagents
          WHERE status = 'completed'
            AND child_thread_id IS NOT NULL
            AND json_extract(payload_json, '$.prompt') LIKE 'Act as the review sub-agent%'
          ORDER BY COALESCE(completed_at, updated_at) DESC
          LIMIT 2000
        `.pipe(Effect.orElseSucceed(() => []));
        const mapped = ReviewStatsThreads.mapRawDelegatedReviewRows(subRows);
        delegatedReviews = mapped;
        ReviewStats.setCachedDelegatedReviews(mapped);
      }
    }

    const hostnameOpt = yield* Effect.serviceOption(HostProcess.Hostname);
    const localHostName = Option.getOrElse(hostnameOpt, () => NodeOS.hostname());
    const records = ReviewStats.loadReviewRecordsCached(
      shipQueueRootOverride ? { shipJobsDir: `${shipQueueRootOverride}/jobs` } : {},
      lookup,
      { forceRefresh, delegatedReviews },
    );
    return jsonResponse(
      aggregateReviewStats(records, {
        side,
        by,
        source,
        repo,
        lab,
        family,
        host,
        localHostName,
        days,
        nowMs: DateTime.toEpochMillis(yield* DateTime.now),
        includeBypasses,
      }),
    );
  }

  if (method === "GET" && subPath === "/stats/cerno") {
    const sp = url.value.searchParams;
    const host = sp.get("host")?.trim() || undefined;
    const harness = sp.get("harness")?.trim() || undefined;
    const daysRaw = Number(sp.get("days") ?? "");
    const days = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.round(daysRaw) : undefined;
    const hostnameOpt = yield* Effect.serviceOption(HostProcess.Hostname);
    const localHostName = Option.getOrElse(hostnameOpt, () => NodeOS.hostname());
    return jsonResponse(
      CernoStats.loadCernoStats({
        ...(host ? { host } : {}),
        ...(harness ? { harness } : {}),
        ...(days !== undefined ? { days } : {}),
        localHostName,
      }),
      200,
    );
  }

  if (subPath === "/reaper/policy" && (method === "GET" || method === "POST")) {
    const serverConfig = yield* Effect.serviceOption(ServerConfig.ServerConfig);
    const settingsService = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
    let protectedHistoryRoots: ReadonlyArray<string> = [];
    if (Option.isSome(serverConfig)) {
      const settings = Option.isSome(settingsService)
        ? yield* settingsService.value.getSettings.pipe(
            Effect.orElseSucceed(() => ({ providerInstances: {} })),
          )
        : { providerInstances: {} };
      const manifest = StorageManifest.buildStorageManifestFromSettings(
        serverConfig.value,
        settings,
      );
      protectedHistoryRoots = manifest.entries
        .filter((e) => e.trust === "history")
        .map((e) => e.path);
    }
    if (method === "GET") {
      return jsonResponse(ReaperPolicy.readReaperPolicySync(protectedHistoryRoots), 200);
    }
    const parsed = yield* readJsonBody;
    if (!parsed.ok) return jsonResponse({ error: parsed.error }, parsed.status);
    const rawRules = Array.isArray(parsed.value.rules) ? parsed.value.rules : null;
    if (!rawRules) {
      return jsonResponse({ error: "rules array is required" }, 400);
    }
    const rules: ReaperPolicy.ReaperPolicyRule[] = [];
    for (const item of rawRules) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return jsonResponse({ error: "Invalid rule object" }, 400);
      }
      const r = item as Record<string, unknown>;
      rules.push({
        path: typeof r.path === "string" ? r.path : "",
        maxAgeDays: typeof r.maxAgeDays === "number" ? r.maxAgeDays : Number(r.maxAgeDays ?? 14),
        keepLatest: typeof r.keepLatest === "number" ? r.keepLatest : Number(r.keepLatest ?? 2),
        enabled: r.enabled === true,
      });
    }
    const written = yield* Effect.tryPromise({
      try: () => ReaperPolicy.writeReaperPolicy(rules, protectedHistoryRoots),
      catch: (err) => ({ ok: false as const, error: String(err) }),
    }).pipe(Effect.catch((e) => Effect.succeed(e)));
    if (!written.ok) {
      return jsonResponse({ error: written.error }, 400);
    }
    return jsonResponse(written.document, 200);
  }

  if (
    (method === "GET" && (subPath === "/storage/manifest" || subPath === "/storage/scan")) ||
    (method === "POST" && (subPath === "/storage/scan/refresh" || subPath === "/storage/review"))
  ) {
    const serverConfig = yield* Effect.serviceOption(ServerConfig.ServerConfig);
    if (Option.isNone(serverConfig)) {
      return jsonResponse({ error: "ServerConfig unavailable" }, 503);
    }
    const settingsService = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
    const settings = Option.isSome(settingsService)
      ? yield* settingsService.value.getSettings.pipe(
          Effect.orElseSucceed(() => ({
            providerInstances: {},
            defaultModelSelection: null as ModelSelection | null,
          })),
        )
      : { providerInstances: {}, defaultModelSelection: null as ModelSelection | null };
    const manifest = StorageManifest.buildStorageManifestFromSettings(serverConfig.value, settings);
    // Until the external reaper timers are retired, they read this file for history roots.
    yield* Effect.tryPromise({
      try: () => StorageManifest.writeStorageManifestIfChanged(manifest),
      catch: (err) => String(err),
    }).pipe(Effect.catch(() => Effect.void));
    if (subPath === "/storage/manifest") {
      return jsonResponse(manifest, 200);
    }
    const reaper = yield* Effect.serviceOption(Reaper.ReaperService);
    const storageCleanup = yield* Effect.serviceOption(StorageCleanup.StorageCleanup);
    const storageCleanupReport = Option.isSome(storageCleanup)
      ? yield* storageCleanup.value.latestReport.pipe(Effect.orElseSucceed(() => null))
      : null;
    const hostScan = Option.isNone(reaper)
      ? null
      : subPath === "/storage/scan/refresh"
        ? yield* reaper.value.refreshScan
        : ((yield* reaper.value.latestScan) ?? (yield* reaper.value.refreshScan));
    if (subPath === "/storage/review") {
      const parsed = yield* readJsonBody;
      if (!parsed.ok) return jsonResponse({ error: parsed.error }, parsed.status);
      const validated = ReaperPolicy.validateStorageReviewInput({
        host: parsed.value.host,
        defaultHost: manifest.host,
        ...(parsed.value.mounts !== undefined ? { mounts: parsed.value.mounts } : {}),
      });
      if (!validated.ok) {
        return jsonResponse({ error: validated.error }, 400);
      }
      const targetHost = validated.host;
      const bodyMounts =
        validated.mounts ??
        (targetHost.toLowerCase() === manifest.host.toLowerCase() && hostScan
          ? hostScan.mounts.map((m) => ({
              mount: m.mount,
              usedPct: m.used_pct,
              ...(m.avail_bytes !== undefined ? { availBytes: m.avail_bytes } : {}),
            }))
          : undefined);
      const prompt = ReaperPolicy.buildStorageCleanupReviewPrompt({
        host: targetHost,
        ...(bodyMounts ? { mounts: bodyMounts } : {}),
        manifest,
      });

      const launchSvcOpt = yield* Effect.serviceOption(ThreadLaunchService.ThreadLaunchService);
      const foldersOpt = yield* Effect.serviceOption(ManagedProjectFolders.ManagedProjectFolders);
      const providersOpt = yield* Effect.serviceOption(ProviderRegistry.ProviderRegistry);
      if (Option.isSome(launchSvcOpt) && Option.isSome(foldersOpt) && Option.isSome(providersOpt)) {
        const providers = yield* providersOpt.value.getProviders.pipe(
          Effect.orElseSucceed(() => []),
        );
        const firstReady =
          providers.find((p) => p.enabled && p.status === "ready" && p.models.length > 0) ??
          providers.find((p) => p.enabled && p.models.length > 0) ??
          providers[0];
        const firstModel = firstReady?.models[0];
        const modelSelection: ModelSelection | null =
          settings.defaultModelSelection ??
          (firstReady && firstModel
            ? {
                instanceId: firstReady.instanceId,
                model: firstModel.slug,
              }
            : null);
        if (modelSelection) {
          const scratch = yield* foldersOpt.value.ensureScratchProject.pipe(
            Effect.map((v) => v.projectId),
            Effect.orElseSucceed(() => null),
          );
          if (scratch) {
            const reqId = ReaperPolicy.nextStorageReviewRequestId();
            const threadId = ThreadId.make(reqId);
            const launched = yield* launchSvcOpt.value
              .launch({
                commandId: CommandId.make(reqId),
                threadId,
                projectId: scratch,
                title: `Storage review: ${targetHost}`,
                modelSelection,
                runtimeMode: "approval-required",
                interactionMode: "default",
                workspaceStrategy: { type: "root" },
                initialMessage: {
                  messageId: MessageId.make(reqId),
                  text: prompt,
                  attachments: [],
                },
                createdBy: "user",
                creationSource: "web",
              })
              .pipe(
                Effect.map((r) => ({
                  ok: true as const,
                  threadId: r.threadId,
                  projectId: scratch,
                })),
                Effect.catchCause(() => Effect.succeed({ ok: false as const })),
              );
            if (launched.ok) {
              return jsonResponse(
                {
                  ok: true,
                  launched: true,
                  threadId: launched.threadId,
                  projectId: launched.projectId,
                  prompt,
                },
                200,
              );
            }
          }
        }
      }
      return jsonResponse({ ok: true, launched: false, prompt }, 200);
    }
    return jsonResponse({ manifest, storageCleanupReport, hostScan }, 200);
  }

  return jsonResponse({ error: "Not Found" }, 404);
});

export function makeLayer(deps: DevtoolsDeps = {}) {
  return Layer.unwrap(
    Effect.gen(function* () {
      const platform = yield* HostProcess.Platform;
      const pathSvc = yield* Path.Path;
      const serverConfig = yield* Effect.serviceOption(ServerConfig.ServerConfig);
      const settingsService = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
      const trustedProviders = yield* TrustedProviderRegistry.TrustedProviderRegistry;
      const guardGrantsRepo = yield* Effect.serviceOption(GuardGrants.GuardGrantsRepository);
      const secretRequestsSvc = yield* Effect.serviceOption(SecretRequests.SecretRequests);
      const pullRequestSvc = yield* Effect.serviceOption(PullRequestService.PullRequestService);
      const services = yield* Effect.context<never>();
      const runPromise = Effect.runPromiseWith(services);
      const bundlePersistence = Option.isSome(guardGrantsRepo)
        ? yield* GuardGrants.makeGuardBundlePersistenceEffect(guardGrantsRepo.value)
        : undefined;
      const secretGrants = Option.isSome(secretRequestsSvc)
        ? {
            listActiveGrants: () => runPromise(secretRequestsSvc.value.listActiveGrants()),
            revokeGrant: (grantId: string) =>
              runPromise(secretRequestsSvc.value.revokeGrant(grantId)),
            subscribeGrants: secretRequestsSvc.value.subscribeGrants,
          }
        : undefined;
      const signingStateDir = Option.isSome(serverConfig)
        ? pathSvc.join(serverConfig.value.stateDir, "guards")
        : undefined;
      const broker =
        deps.broker ??
        new GuardGrantBroker({
          getTrustedCodexAppServers: trustedProviders.snapshotCodexAppServers,
          bundlePersistence,
          secretGrants,
          signingStateDir,
        });
      if (Option.isSome(pullRequestSvc)) {
        const merges = yield* pullRequestSvc.value.subscribeMerges;
        yield* Effect.forkScoped(
          Stream.runForEach(merges, (merged) =>
            Effect.gen(function* () {
              yield* Effect.promise(() =>
                broker.invalidateRepoPr(merged.repository, merged.number, "pr-merged"),
              ).pipe(Effect.ignore);
              // Also revoke by PR head branch so grants keyed on an issue number (#6) instead of PR (#19) still clear.
              const summary = yield* pullRequestSvc.value
                .summary(merged)
                .pipe(Effect.orElseSucceed(() => null));
              if (summary?.headBranch) {
                yield* Effect.promise(() =>
                  broker.invalidateRepoBranch(merged.repository, summary.headBranch, "pr-merged"),
                ).pipe(Effect.ignore);
              }
            }),
          ),
        );
      }
      const jobRegistry = yield* JobRegistry.JobRegistry;
      const sseLimiter = createSseLimiter();
      const shouldStart = deps.startBroker ?? shouldAutoStartBroker(pathSvc, serverConfig);
      const nativeFleet = yield* makeNativeFleetFromContext({
        override: deps.nativeFleet,
        enableBackground: shouldStart,
      });

      if (shouldStart) {
        DevtoolsFleetConfigCache.warmFleetConfigCache();
      }
      if (Option.isSome(serverConfig) && shouldStart) {
        const cfg = serverConfig.value;
        const publishManifest = (
          providerInstances: Parameters<
            typeof StorageManifest.buildStorageManifestFromSettings
          >[1]["providerInstances"],
        ) =>
          Effect.tryPromise({
            try: () =>
              StorageManifest.writeStorageManifest(
                StorageManifest.buildStorageManifestFromSettings(cfg, { providerInstances }),
              ),
            catch: (err) => String(err),
          }).pipe(
            Effect.catch((err) =>
              Effect.logWarning(`Devtools StorageManifest write failed: ${err}`),
            ),
          );
        if (Option.isSome(settingsService)) {
          const initial = yield* settingsService.value.getSettings.pipe(
            Effect.orElseSucceed(() => ({ providerInstances: {} })),
          );
          yield* publishManifest(initial.providerInstances);
          const settingsChanges = yield* settingsService.value.subscribeChanges;
          yield* Effect.forkScoped(
            Stream.runForEach(settingsChanges, (next) => publishManifest(next.providerInstances)),
          );
        } else {
          yield* publishManifest({});
        }
      }

      if (shouldStart) {
        const hostCfg = DevtoolsConfig.readDevtoolsHostConfig();
        broker.setRuntimeTimeouts({
          defaultGrantTtlMs: hostCfg.guards.grant_ttl_s * 1000,
          defaultRequestTimeoutMs: hostCfg.guards.request_timeout_s * 1000,
        });
        jobRegistry.setDefaultStallMinutes(hostCfg.jobs.default_stall_minutes);
      }

      if (shouldStart) {
        yield* Effect.tryPromise({
          try: () => broker.start(platform),
          catch: (err) => String(err),
        }).pipe(
          Effect.catch((err) =>
            Effect.logWarning(`Devtools GuardGrantBroker failed to start: ${err}`),
          ),
        );
        yield* Effect.addFinalizer(() => Effect.promise(() => broker.close()));
      }

      return HttpRouter.add(
        "*",
        `${DEVTOOLS_ROUTE_PREFIX}/*`,
        makeHandler(broker, jobRegistry, sseLimiter, undefined, nativeFleet).pipe(
          Effect.catchDefect((defect) =>
            Effect.logError("DevtoolsHttp unhandled defect", defect).pipe(
              Effect.as(
                jsonResponse(
                  {
                    ok: false,
                    error: "Unexpected DevTools server error",
                    code: "internal_error",
                  },
                  500,
                ),
              ),
            ),
          ),
        ),
      );
    }),
  );
}

export const layer = makeLayer();
