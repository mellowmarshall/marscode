/**
 * Modular HTTP + SSE router for MarsCode devtools under `/api/devtools/*`.
 * Enforces HTTP Bearer/DPoP/cookie auth on JSON routes and media auth on SSE streams.
 */
import * as NodeOS from "node:os";

import {
  AuthAccessWriteScope,
  AuthDiagnosticsReadScope,
  AuthOrchestrationReadScope,
  AuthTerminalOperateScope,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest } from "effect/http";

import {
  authenticateMediaRequest,
  failEnvironmentInternal,
  failEnvironmentScopeRequired,
} from "../auth/http.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerConfig from "../config.ts";
import * as GuardGrants from "../persistence/GuardGrants.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import { requestUrl } from "../requestUrl.ts";
import { discoverTools } from "./CliProcessExec.ts";
import * as DevtoolsConfig from "./DevtoolsConfig.ts";
import { handleConfigAndStatsRoute } from "./DevtoolsConfigRoutes.ts";
import * as DevtoolsErrors from "./DevtoolsErrors.ts";
import * as DevtoolsEventMux from "./DevtoolsEventMux.ts";
import * as DevtoolsFleetConfigCache from "./DevtoolsFleetConfigCache.ts";
import { handleGuardRoute } from "./DevtoolsGuardRoutes.ts";
import { handlePlaybookRoute } from "./DevtoolsPlaybookRoutes.ts";
import {
  authenticateJsonRequest,
  createSseLimiter,
  decodeSafeJobIdParam,
  guardEventsSseResponse,
  isPeerOrMcpSubject,
  jsonResponse,
  readJsonBody,
  requiredScopesForJsonRoute,
  webStreamToSseResponse,
  type SseLimiter,
} from "./DevtoolsHttpContext.ts";
import { handleShipQueueRoute, registerShipQueueDepsScheduler } from "./DevtoolsShipQueueRoutes.ts";
import {
  handleStorageAndToolRoute,
  startStorageManifestPublisher,
} from "./DevtoolsStorageRoutes.ts";
import { isAllowedFleetPath } from "./fleet/FleetRoutePolicy.ts";
import { handleNativeFleetRequest } from "./fleet/FleetRoutes.ts";
import type { NativeFleetService } from "./fleet/NativeFleetService.ts";
import { makeNativeFleetFromContext } from "./fleet/NativeFleetWiring.ts";
import { GuardGrantBroker } from "./GuardGrantBroker.ts";
import * as JobRegistry from "./jobs/JobRegistry.ts";
import * as Reaper from "./reaper/ReaperService.ts";
import { createShipQueueEventStream } from "./ShipQueueEventStream.ts";
import * as TrustedProviderRegistry from "./TrustedProviderRegistry.ts";

const DEVTOOLS_ROUTE_PREFIX = "/api/devtools";

const TEMP_DIR_PREFIXES = [
  "/tmp/",
  "/var/tmp/",
  "/private/tmp/",
  "/private/var/tmp/",
  "/var/folders/",
  "/private/var/folders/",
];

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
      (signal) => createShipQueueEventStream(signal),
      invalidated,
    );
  }

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
      ...discoverTools(useNativeFleet),
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
    if (!nativeFleet) return jsonResponse({ error: "Native fleet telemetry unavailable" }, 503);
    const selfState = yield* Effect.promise(() => nativeFleet.readFreshSelfNodeState());
    return jsonResponse(selfState);
  }

  const guardResponse = yield* handleGuardRoute(method, subPath, url.value, broker, {
    jsonResponse,
    readJsonBody,
    session,
  });
  if (guardResponse !== null) return guardResponse;

  const playbookResponse = yield* handlePlaybookRoute(method, subPath, url.value, broker, {
    jsonResponse,
    readJsonBody,
    session,
  });
  if (playbookResponse !== null) return playbookResponse;

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
    if (!nativeFleet) return jsonResponse({ error: "Native fleet telemetry unavailable" }, 503);
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

  const shipQueueRes = yield* handleShipQueueRoute({
    method,
    subPath,
    broker,
    session,
    shipQueueRootOverride,
  });
  if (shipQueueRes !== null) return shipQueueRes;

  const configStatsRes = yield* handleConfigAndStatsRoute({
    method,
    subPath,
    url: url.value,
    broker,
    jobRegistry,
    shipQueueRootOverride,
  });
  if (configStatsRes !== null) return configStatsRes;

  const storageRes = yield* handleStorageAndToolRoute({
    method,
    subPath,
  });
  if (storageRes !== null) return storageRes;

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
        yield* registerShipQueueDepsScheduler();
        if (Option.isSome(serverConfig)) {
          yield* startStorageManifestPublisher(serverConfig.value, settingsService);
        }
      }

      if (shouldStart) {
        const hostCfg = DevtoolsConfig.readDevtoolsHostConfig();
        broker.setRuntimeTimeouts({
          defaultGrantTtlMs: hostCfg.guards.grant_ttl_s * 1000,
          defaultRequestTimeoutMs: hostCfg.guards.request_timeout_s * 1000,
        });
        jobRegistry.setDefaultStallMinutes(hostCfg.jobs.default_stall_minutes);
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
