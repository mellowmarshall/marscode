/**
 * Authenticated HTTP and SSE client for `/api/devtools/*` across local and linked environments.
 * JSON calls use cookie / Bearer / DPoP headers; only EventSource streams use media wsTicket.
 */
import { useAtomValue } from "@effect/atom-react";
import { RemoteEnvironmentAuthorization } from "@t3tools/client-runtime/authorization";
import type { PreparedHttpAuthorization } from "@t3tools/client-runtime/connection";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import {
  type DeviceHubAccess,
  resolveDeviceHubAccess,
  withDeviceHubQuery,
} from "@t3tools/client-runtime/state/deviceHubAccess";
import { buildEnvironmentAuthHeaders } from "@t3tools/client-runtime/state/environmentHttpAuth";
import type { EnvironmentId } from "@t3tools/contracts";
import { msg } from "gt-react";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import { m } from "~/i18n/messages";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentSession } from "../state/session";
import {
  parseDevtoolsErrorCode,
  type DevtoolsErrorCode,
  type DevtoolsServiceHealth,
} from "./devtoolsState";

const DEVTOOLS_BASE_PATH = "/api/devtools";
const ACCESS_RETRY_INTERVAL_MS = 10_000;

import type {
  ActiveGuardBundleGrant,
  ActiveSecretGrant,
  GuardBrokerEvent,
  GuardBundleSpec,
  PendingGuardRequest,
  UnifiedActiveGrant,
} from "@t3tools/guard-protocol/protocol";

export type {
  ActiveGuardBundleGrant,
  ActiveSecretGrant,
  GuardBrokerEvent,
  GuardBundleSpec,
  PendingGuardRequest,
  UnifiedActiveGrant,
};

export interface DevtoolsCapabilities {
  readonly host: string;
  readonly platform: string;
  readonly guardBrokerListening: boolean;
  readonly canApproveGuards?: boolean;
  readonly canReadDiagnostics?: boolean;
  readonly canOperateTerminal?: boolean;
  readonly devdeckReachable?: boolean;
  readonly devdeckPassiveSupported?: boolean;
  readonly multiplexedEvents?: boolean;
  readonly tools: {
    readonly devdeck: boolean;
    readonly shipQueue: boolean;
    readonly playbook: boolean;
    readonly reaper: boolean;
  };
  readonly services?: DevtoolsServiceHealth;
}

export type {
  AggregatedFleetAlert,
  DeclaredContractSummary,
  DevdeckAlertItem,
  DevdeckAlertsPanel,
  DevdeckDiskInfo,
  DevdeckGpuInfo,
  DevdeckHostProbeReport,
  DevdeckHostsPanel,
  DevdeckHostTelemetry,
  DevdeckMemInfo,
  DevdeckNodeState,
  DevdeckServerItem,
  DevdeckSessionItem,
  DevdeckShipCiTurn,
  DevdeckShipDepEntry,
  DevdeckShipHostCheck,
  DevdeckShipPanel,
  DevdeckToolProbe,
  DevdeckWorktreesPanel,
  MergedFleetHost,
  NormalizedWaiver,
  PlaybookDeclarationPayload,
  PlaybookRuleSection,
} from "./devdeckTypes";

export interface ShipQueueRouteInfo {
  readonly host?: string;
  readonly local?: boolean | number | string;
  readonly load?: string | number;
  readonly note?: string;
  readonly at?: string;
}

export interface ShipQueueJob {
  readonly id?: string;
  readonly key?: string;
  readonly repo?: string;
  readonly primary?: string;
  readonly worktree?: string;
  readonly branch?: string;
  readonly title?: string;
  readonly submitted_at?: string;
  readonly thread_id?: string;
  readonly state?: string;
  readonly display_state?: string;
  readonly stage?: string;
  readonly last_marker?: string;
  readonly waiting?: string;
  readonly reason?: string;
  readonly route?: ShipQueueRouteInfo | null;
  readonly ci_done?: boolean | number | string;
  readonly needs_root?: {
    readonly request?: string;
    readonly hosts?: ReadonlyArray<string>;
  } | null;
  readonly parked?: {
    readonly for?: string;
    readonly hosts?: string | ReadonlyArray<string>;
    readonly at?: number | string;
  } | null;
  readonly push_exit?: number | string;
  readonly pr?: string | number;
  readonly pr_repo?: string;
  readonly merge_exit?: number | string;
  readonly sync_exit?: number | string;
  /** Server-read from the job log when `sync_exit` is non-zero: why the post-merge sync failed. */
  readonly sync_reason?: string;
  readonly post_merge?: boolean;
  readonly watchers?: number;
  readonly steps_tip?: string;
  readonly steps?: ReadonlyArray<ShipQueueStepTiming>;
  readonly rebased_onto?: string;
  readonly pushed_sha?: string;
  readonly ended_at?: string;
  readonly waiting_for?: string;
  readonly ci_lease?: { readonly host?: string } | null;
  readonly ci_wait?: { readonly reason?: string } | null;
  readonly challenged_tip?: string;
  readonly challenge_override?: {
    readonly reason?: string;
    readonly at?: string;
  } | null;
}

/** One declared step's run as the queue records it in `job.json` (`steps`). */
export interface ShipQueueStepTiming {
  readonly name: string;
  readonly host?: string;
  readonly exit?: number;
  readonly ms?: number;
}

export interface ShipQueueStatusPayload {
  readonly queue_root?: string;
  readonly open_count?: number;
  readonly total_count?: number;
  readonly upgrade_pending?: string;
  readonly jobs?: ReadonlyArray<ShipQueueJob>;
}

export interface ShipQueueDepUpdateSummary {
  readonly packageFile: string;
  readonly depName: string;
  readonly currentValue: string;
  readonly newValue: string;
  readonly releaseTimestamp: string | null;
}

export interface ShipQueueDepRepoSummary {
  readonly repo: string;
  readonly reportId: string | null;
  readonly status: string;
  readonly scannedAt: number | null;
  readonly active: boolean;
  readonly holding: boolean;
  readonly pendingCount: number;
  readonly waitingCount: number;
  readonly heldCount: number;
  readonly failedCount: number;
  readonly attemptId: string | null;
  readonly attemptStatus: string | null;
  readonly decisionKind: string | null;
  readonly decisionUntil: number | null;
  readonly error: string | null;
  readonly updates: ReadonlyArray<ShipQueueDepUpdateSummary>;
}

export interface ShipQueueDepsPayload {
  readonly queueRoot?: string;
  readonly repos: ReadonlyArray<ShipQueueDepRepoSummary>;
}

export interface ReaperStatus {
  readonly protected: {
    readonly sessions: number;
    readonly worktrees: number;
    readonly paths: number;
  };
  readonly orphan_candidates: ReadonlyArray<{
    readonly pid: number;
    readonly cmd: string;
    readonly age_s: number;
  }>;
  readonly stale_tmp: {
    readonly max_age_hours: number;
    readonly roots: ReadonlyArray<string>;
    readonly dirs: number;
    readonly files: number;
    readonly skipped_active: number;
  };
  readonly cargo_last_run: {
    readonly stamp_path: string;
    readonly last_run: string | null;
    readonly age_s: number | null;
  };
}

export interface ReaperCargoResult {
  readonly dry_run: boolean;
  readonly build_dirs: number;
  readonly removed: number;
  readonly removed_bytes: number;
  readonly incremental: number;
  readonly incremental_bytes: number;
  readonly skipped_in_use: number;
  readonly aborted_reason: string | null;
  readonly items: ReadonlyArray<{
    readonly kind: string;
    readonly action: string;
    readonly path: string;
    readonly bytes?: number;
    readonly reason?: string;
  }>;
}

export interface PlaybookResultEntry {
  readonly check: string;
  readonly status: string;
  readonly summary: string;
  readonly errors?: ReadonlyArray<string>;
  readonly files?: ReadonlyArray<string>;
  readonly fix?: string;
}

export interface PlaybookReport {
  readonly repo?: string;
  readonly command?: string;
  readonly counts?: { readonly PASS?: number; readonly FAIL?: number; readonly UNPROVEN?: number };
  readonly total_seconds?: number;
  readonly results?: ReadonlyArray<PlaybookResultEntry>;
}

export function hasConnectedEnvironment(environmentId: EnvironmentId): boolean {
  try {
    return Option.isSome(
      appAtomRegistry.get(environmentSession.preparedConnectionValueAtom(environmentId)),
    );
  } catch {
    return false;
  }
}

export function subscribeEnvironmentConnected(
  environmentId: EnvironmentId,
  listener: (connected: boolean) => void,
): () => void {
  try {
    let prev = hasConnectedEnvironment(environmentId);
    return appAtomRegistry.subscribe(
      environmentSession.preparedConnectionValueAtom(environmentId),
      (prepared) => {
        const next = Option.isSome(prepared);
        if (next === prev) return;
        prev = next;
        listener(next);
      },
    );
  } catch {
    return () => {};
  }
}

const devtoolsStreamAccessAtom = Atom.family((environmentId: EnvironmentId) =>
  connectionAtomRuntime
    .atom((get) => {
      const prepared = Option.getOrNull(
        get(environmentSession.preparedConnectionValueAtom(environmentId)),
      );
      if (prepared === null) return Effect.never;
      return resolveDeviceHubAccess({ prepared, hubBasePath: DEVTOOLS_BASE_PATH });
    })
    .pipe(Atom.setIdleTTL(60_000), Atom.withLabel(`devtools-stream-access:${environmentId}`)),
);

const retryingDevtoolsStreamAccessAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => {
    const access = devtoolsStreamAccessAtom(environmentId);
    const result = get(access);
    if (AsyncResult.isFailure(result)) {
      const timer = setTimeout(() => get.refresh(access), ACCESS_RETRY_INTERVAL_MS);
      get.addFinalizer(() => clearTimeout(timer));
    }
    return result;
  }),
);

const EMPTY_ACCESS_ATOM = Atom.make(AsyncResult.initial<DeviceHubAccess, never>()).pipe(
  Atom.withLabel("devtools-stream-access:empty"),
);

export function useDevtoolsStreamAccess(
  environmentId: EnvironmentId | null,
): DeviceHubAccess | null {
  const result = useAtomValue(
    environmentId === null ? EMPTY_ACCESS_ATOM : retryingDevtoolsStreamAccessAtom(environmentId),
  );
  return AsyncResult.isSuccess(result) ? result.value : null;
}

export function refreshDevtoolsStreamAccess(environmentId: EnvironmentId): void {
  appAtomRegistry.refresh(devtoolsStreamAccessAtom(environmentId));
}

export function resolveDevtoolsStreamAccessAsync(
  environmentId: EnvironmentId,
): Promise<DeviceHubAccess | null> {
  if (!hasConnectedEnvironment(environmentId)) {
    return Promise.resolve(null);
  }
  const atom = devtoolsStreamAccessAtom(environmentId);
  return Effect.runPromise(
    AtomRegistry.getResult(appAtomRegistry, atom, { suspendOnWaiting: true }).pipe(
      Effect.timeout("10 seconds"),
      Effect.orElseSucceed(() => null as DeviceHubAccess | null),
    ),
  );
}

export function buildDevtoolsStreamUrl(
  access: DeviceHubAccess,
  subPath: string,
  extraQuery?: Readonly<Record<string, string>>,
): string {
  const cleanSub = subPath.startsWith("/") ? subPath : `/${subPath}`;
  const baseUrl = `${access.httpBase}${cleanSub}`;
  const mergedQuery: Record<string, string> = {
    ...extraQuery,
    ...access.query,
  };
  return withDeviceHubQuery(baseUrl, { ...access, query: mergedQuery });
}

export interface DevtoolsFetchResult<T> {
  readonly ok: boolean;
  readonly status: number;
  readonly data: T | null;
  readonly error?: string | undefined;
  readonly errorCode?: DevtoolsErrorCode | undefined;
}

function appendQueryToUrl(base: string, query?: Readonly<Record<string, string>>): string {
  if (!query) return base;
  const entries = Object.entries(query);
  if (entries.length === 0) return base;
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}${new URLSearchParams(entries).toString()}`;
}

async function resolveHttpRequestAuth(
  environmentId: EnvironmentId,
  method: "GET" | "POST",
  subPath: string,
  query?: Readonly<Record<string, string>>,
  rejectedAccessToken?: string,
  signal?: AbortSignal,
): Promise<{
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly credentials: RequestCredentials;
  readonly usedDpopAccessToken?: string;
} | null> {
  if (signal?.aborted) return null;
  const prepared = Option.getOrNull(
    appAtomRegistry.get(environmentSession.preparedConnectionValueAtom(environmentId)),
  );
  if (!prepared) return null;

  const cleanSub = subPath.startsWith("/") ? subPath : `/${subPath}`;
  let httpBaseUrl = prepared.httpBaseUrl;
  let effectiveAuth: PreparedHttpAuthorization | null = prepared.httpAuthorization;

  if (effectiveAuth === null || effectiveAuth._tag === "Bearer") {
    const finalUrl = appendQueryToUrl(
      `${httpBaseUrl.replace(/\/+$/, "")}${DEVTOOLS_BASE_PATH}${cleanSub}`,
      query,
    );
    const authHeaders = await Effect.runPromise(
      buildEnvironmentAuthHeaders(effectiveAuth, method, finalUrl, Option.none()).pipe(
        Effect.orElseSucceed(() => null),
      ),
    );
    if (!authHeaders) return null;
    const headers: Record<string, string> = {};
    if (authHeaders.authorization) headers.authorization = authHeaders.authorization;
    if (authHeaders.dpop) headers.dpop = authHeaders.dpop;
    return {
      url: finalUrl,
      headers,
      credentials: effectiveAuth === null ? "include" : "omit",
    };
  }

  // Always obtain the current/renewed DPoP credential from RemoteEnvironmentAuthorization
  // and build headers via T3's shared buildEnvironmentAuthHeaders helper.
  const dpopAuth = effectiveAuth;
  const dpopEffect = AtomRegistry.getResult(appAtomRegistry, connectionAtomRuntime).pipe(
    Effect.flatMap((context) =>
      Effect.gen(function* () {
        let activeAuth: Extract<PreparedHttpAuthorization, { readonly _tag: "Dpop" }> = dpopAuth;
        const remoteOpt = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
        if (Option.isSome(remoteOpt)) {
          if (dpopAuth.directConnection !== undefined) {
            activeAuth = yield* remoteOpt.value.authorizeDirectDpopHttp(
              dpopAuth.directConnection,
              rejectedAccessToken,
            );
          } else {
            const renewed = yield* remoteOpt.value.authorizeDpopHttp({
              expectedEnvironmentId: prepared.environmentId,
              ...(rejectedAccessToken !== undefined ? { rejectedAccessToken } : {}),
            });
            if (prepared.target._tag === "RelayConnectionTarget") {
              httpBaseUrl = renewed.httpBaseUrl;
            }
            activeAuth = renewed.httpAuthorization;
          }
        }
        const finalUrl = appendQueryToUrl(
          `${httpBaseUrl.replace(/\/+$/, "")}${DEVTOOLS_BASE_PATH}${cleanSub}`,
          query,
        );
        const signerOpt = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
        const authHeaders = yield* buildEnvironmentAuthHeaders(
          activeAuth,
          method,
          finalUrl,
          signerOpt,
        );
        const headers: Record<string, string> = {};
        if (authHeaders.authorization) headers.authorization = authHeaders.authorization;
        if (authHeaders.dpop) headers.dpop = authHeaders.dpop;
        return {
          url: finalUrl,
          headers,
          credentials: "omit" as RequestCredentials,
          usedDpopAccessToken: activeAuth.accessToken,
        };
      }).pipe(Effect.provide(context)),
    ),
    Effect.orElseSucceed(() => null),
  );
  try {
    return await Effect.runPromise(dpopEffect, signal ? { signal } : undefined);
  } catch {
    return null;
  }
}

export async function fetchDevtoolsJson<T>(
  environmentId: EnvironmentId,
  subPath: string,
  options: {
    readonly method?: "GET" | "POST" | undefined;
    readonly body?: unknown;
    readonly query?: Readonly<Record<string, string>> | undefined;
    readonly signal?: AbortSignal | undefined;
  } = {},
): Promise<DevtoolsFetchResult<T>> {
  const method = options.method ?? "GET";
  if (!hasConnectedEnvironment(environmentId)) {
    return { ok: false, status: 0, data: null, error: m(msg("Environment not connected")) };
  }

  const perform = async (
    rejectedAccessToken?: string,
  ): Promise<DevtoolsFetchResult<T> & { readonly usedDpopAccessToken?: string }> => {
    const reqAuth = await resolveHttpRequestAuth(
      environmentId,
      method,
      subPath,
      options.query,
      rejectedAccessToken,
      options.signal,
    );
    if (!reqAuth) {
      return {
        ok: false,
        status: 0,
        data: null,
        error: options.signal?.aborted
          ? m(msg("Request aborted"))
          : m(msg("Environment authorization unavailable")),
      };
    }
    const headers: Record<string, string> = {
      accept: "application/json",
      ...reqAuth.headers,
      ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
    };
    const init: RequestInit = {
      method,
      credentials: reqAuth.credentials,
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    };
    try {
      const res = await fetch(reqAuth.url, init);
      const contentType = res.headers.get("content-type") ?? "";
      const text = await res.text();
      // An older bundled T3 server falls back to serving index.html with HTTP 200 on unknown /api/devtools/* routes.
      if (res.ok && !contentType.toLowerCase().includes("application/json")) {
        return {
          ok: false,
          status: 404,
          data: null,
          error: m(msg("Devtools API is not supported on this host")),
          ...(reqAuth.usedDpopAccessToken
            ? { usedDpopAccessToken: reqAuth.usedDpopAccessToken }
            : {}),
        };
      }
      let parsed: unknown = null;
      if (text) {
        try {
          parsed = JSON.parse(text) as unknown;
        } catch {
          parsed = null;
        }
      }
      if (!res.ok) {
        const errMsg =
          parsed && typeof parsed === "object" && "error" in parsed
            ? String((parsed as { error: unknown }).error)
            : `HTTP ${res.status}`;
        const rawCode =
          parsed && typeof parsed === "object" && "code" in parsed
            ? (parsed as { code?: unknown }).code
            : parsed && typeof parsed === "object" && "errorCode" in parsed
              ? (parsed as { errorCode?: unknown }).errorCode
              : undefined;
        const errorCode = parseDevtoolsErrorCode(rawCode);
        return {
          ok: false,
          status: res.status,
          data: (parsed as T) ?? null,
          error: errMsg,
          ...(errorCode ? { errorCode } : {}),
          ...(reqAuth.usedDpopAccessToken
            ? { usedDpopAccessToken: reqAuth.usedDpopAccessToken }
            : {}),
        };
      }
      return {
        ok: true,
        status: res.status,
        data: parsed as T,
        ...(reqAuth.usedDpopAccessToken
          ? { usedDpopAccessToken: reqAuth.usedDpopAccessToken }
          : {}),
      };
    } catch (err) {
      return {
        ok: false,
        status: 0,
        data: null,
        error: err instanceof Error ? err.message : String(err),
        ...(reqAuth.usedDpopAccessToken
          ? { usedDpopAccessToken: reqAuth.usedDpopAccessToken }
          : {}),
      };
    }
  };

  const first = await perform();
  if (first.status === 401 && !options.signal?.aborted) {
    refreshDevtoolsStreamAccess(environmentId);
    return await perform(first.usedDpopAccessToken);
  }
  return first;
}

export interface DevdeckActionStatus {
  readonly id?: string;
  readonly state?: string;
  readonly message?: string;
}

/**
 * POST a DevDeck action and, when HTTP 202 returns an `action_id`, poll `/devdeck/actions/:id`
 * until terminal (`ok` or `failed`) with bounded per-poll timeouts and transient-error tolerance.
 */
export async function runTrackedDevdeckAction(
  environmentId: EnvironmentId,
  devdeckPath: string,
  body?: unknown,
): Promise<{ readonly ok: boolean; readonly error?: string; readonly message?: string }> {
  const res = await fetchDevtoolsJson<{ action_id?: string; error?: string }>(
    environmentId,
    `/devdeck${devdeckPath}`,
    {
      method: "POST",
      ...(body !== undefined ? { body } : {}),
    },
  );
  if (!res.ok) {
    return { ok: false, error: res.data?.error ?? res.error ?? m(msg("DevDeck action failed")) };
  }
  const actionId = res.data?.action_id;
  if (!actionId) {
    return { ok: true };
  }
  const isSlowOp = devdeckPath === "/hosts/check" || devdeckPath.endsWith("/provision");
  const maxWaitMs = isSlowOp ? 600_000 : 30_000;
  const startedAt = Date.now();
  const deadline = startedAt + maxWaitMs;
  let consecutiveFailures = 0;

  while (Date.now() < deadline) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    const intervalMs = Math.min(remainingMs, Date.now() - startedAt < 5_000 ? 250 : 1_500);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));

    const pollRemaining = deadline - Date.now();
    if (pollRemaining <= 0) break;
    const controller = new AbortController();
    const pollTimeout = setTimeout(() => controller.abort(), Math.min(8_000, pollRemaining));
    let poll: DevtoolsFetchResult<DevdeckActionStatus>;
    try {
      poll = await fetchDevtoolsJson<DevdeckActionStatus>(
        environmentId,
        `/devdeck/actions/${encodeURIComponent(actionId)}`,
        { signal: controller.signal },
      );
    } finally {
      clearTimeout(pollTimeout);
    }

    if (!poll.ok) {
      if (poll.status === 404 || poll.status === 401 || poll.status === 403) {
        return { ok: false, error: poll.error ?? m(msg("Failed to check action status")) };
      }
      consecutiveFailures += 1;
      if (consecutiveFailures >= 3) {
        return { ok: false, error: poll.error ?? m(msg("Failed to check action status")) };
      }
      continue;
    }
    consecutiveFailures = 0;
    const state = poll.data?.state;
    if (state === "ok") {
      return { ok: true, ...(poll.data?.message ? { message: poll.data.message } : {}) };
    }
    if (state === "failed") {
      return {
        ok: false,
        error: poll.data?.message || m(msg("DevDeck action failed")),
      };
    }
  }
  return { ok: false, error: m(msg("Timed out waiting for DevDeck action")) };
}

export type ReviewEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultrathink";

export interface ReviewModelSpec {
  readonly provider: string;
  readonly model: string;
  readonly effort: ReviewEffort;
}

export interface ReviewRoleConfig {
  readonly default: ReviewModelSpec;
  readonly fallbacks: ReadonlyArray<ReviewModelSpec>;
  readonly min_remaining_pct: number;
}

export interface DevtoolsHostConfig {
  readonly challenge_timeout_s: number;
  readonly playbook_challenge: ReviewRoleConfig;
  readonly ship_queue_review: ReviewRoleConfig;
  readonly guards: {
    readonly request_timeout_s: number;
    readonly grant_ttl_s: number;
  };
  readonly jobs: {
    readonly default_stall_minutes: number;
  };
}

export interface ResolvedModelCandidate extends ReviewModelSpec {
  readonly isDefault: boolean;
  readonly order: number;
  readonly available: boolean;
  readonly remainingPct: number | null;
  readonly healthy: boolean;
}

export interface ResolvedRolePlan {
  readonly role: "playbook_challenge" | "ship_queue_review";
  readonly minRemainingPct: number;
  readonly selected: ResolvedModelCandidate;
  readonly fallbackUsed: boolean;
  readonly reason: string;
  readonly candidates: ReadonlyArray<ResolvedModelCandidate>;
  readonly usageRemaining: Readonly<Record<string, number | null>>;
}

export interface FleetHostDescriptor {
  readonly name: string;
  readonly label: string;
  readonly ssh: string | null;
  readonly local: boolean;
  readonly role: string;
  readonly onHost?: string;
}

export interface FleetHostConfigState {
  readonly host: FleetHostDescriptor;
  readonly reachable: boolean;
  readonly exists: boolean;
  readonly inSyncWithLocal: boolean;
  readonly configPath: string;
  readonly config: DevtoolsHostConfig | null;
  readonly error?: string;
}

export interface FleetConfigSnapshot {
  readonly localHost: string;
  readonly localConfig: DevtoolsHostConfig;
  readonly configPath: string;
  readonly hosts: ReadonlyArray<FleetHostConfigState>;
  readonly resolved: {
    readonly playbookChallenge: ResolvedRolePlan;
    readonly shipQueueReview: ResolvedRolePlan;
  };
}

export interface FleetWriteResultEntry {
  readonly host: string;
  readonly ssh: string | null;
  readonly local: boolean;
  readonly ok: boolean;
  readonly config?: DevtoolsHostConfig;
  readonly error?: string;
}

export interface DevtoolsConfigPayload {
  readonly ok?: boolean;
  readonly configPath: string;
  readonly config: DevtoolsHostConfig;
  readonly host?: string;
  readonly targetHost?: string;
  readonly results?: ReadonlyArray<FleetWriteResultEntry>;
  readonly resolved: {
    readonly playbookChallenge: ResolvedRolePlan;
    readonly shipQueueReview: ResolvedRolePlan;
  };
  readonly error?: string;
}

export type ReviewStatsSide = "reviewer" | "submitter" | "pair";
export type ReviewStatsGroupBy =
  | "model"
  | "family"
  | "lab"
  | "provider"
  | "repo"
  | "source"
  | "effort"
  | "day";

export interface ReviewActorModel {
  readonly model: string;
  readonly effort: string;
  readonly family: string;
  readonly lab: string;
  readonly provider: string;
}

export interface ReviewSeverityCounts {
  readonly breaking: number;
  readonly critical: number;
  readonly high: number;
  readonly medium: number;
  readonly low: number;
  readonly info: number;
  readonly total: number;
}

export interface ReviewStatRecord {
  readonly id: string;
  readonly source: "playbook_challenge" | "ship_queue_review";
  readonly timestamp: string;
  readonly repo: string;
  readonly branch: string;
  readonly commit: string;
  readonly worktree: string;
  readonly threadId: string;
  readonly reviewThreadId?: string;
  readonly verdict: string;
  readonly reviewer: ReviewActorModel;
  readonly submitter: ReviewActorModel;
  readonly counts: ReviewSeverityCounts;
  readonly bypassDetected: boolean;
  readonly playbookFriction: boolean;
  readonly rejectedRisesCount: number;
  readonly fallbackUsed: boolean;
  readonly durationS: number | null;
}

export interface ReviewStatsGroupRow {
  readonly key: string;
  readonly model?: string;
  readonly effort?: string;
  readonly family?: string;
  readonly reviews: number;
  readonly passed: number;
  readonly flagged: number;
  readonly passRatePct: number;
  readonly avgIssues: number;
  readonly bypasses: number;
  readonly friction: number;
  readonly fallbacks: number;
  readonly challenges?: number;
  readonly overrides?: number;
  readonly breaking: number;
  readonly critical: number;
  readonly high: number;
  readonly medium: number;
  readonly low: number;
  readonly info: number;
  readonly total: number;
}

export interface ReviewStatsHighlight {
  readonly label: string;
  readonly reviews: number;
  readonly totalIssues: number;
  readonly avgIssues: number;
  readonly breaking: number;
  readonly critical: number;
  readonly high: number;
}

export interface ReviewStatsPayload {
  readonly side: ReviewStatsSide;
  readonly by: ReviewStatsGroupBy;
  readonly totals: ReviewStatsGroupRow;
  readonly groups: ReadonlyArray<ReviewStatsGroupRow>;
  readonly recent: ReadonlyArray<ReviewStatRecord>;
  readonly highlights: {
    readonly topBugSubmitter: ReviewStatsHighlight | null;
    readonly topBugCatcher: ReviewStatsHighlight | null;
  };
  readonly facets: {
    readonly repos: ReadonlyArray<string>;
    readonly labs: ReadonlyArray<string>;
    readonly families: ReadonlyArray<string>;
    readonly hosts?: ReadonlyArray<string>;
  };
}

export interface CernoFindingRecord {
  readonly sourceId: string;
  readonly timestampUtc: string;
  readonly host: string;
  readonly mode: string;
  readonly harness: string;
  readonly complete: boolean;
  readonly osExit: number | null;
  readonly streamBytes: number;
  readonly rawOutcome: string;
  readonly finalOutcome: string;
  readonly alerts: number;
  readonly disagreement: boolean;
}

export interface CernoGroupRow {
  readonly key: string;
  readonly captures: number;
  readonly complete: number;
  readonly pass: number;
  readonly fail: number;
  readonly alerts: number;
  readonly disagreements: number;
  readonly streamBytes: number;
}

export interface CernoStatsPayload {
  readonly enabled: boolean;
  readonly host: string;
  readonly configPath: string;
  readonly captureDir: string | null;
  readonly localCapture: boolean;
  readonly shareOptIn: boolean;
  readonly totals: CernoGroupRow;
  readonly byHarness: ReadonlyArray<CernoGroupRow>;
  readonly byMode: ReadonlyArray<CernoGroupRow>;
  readonly recentFindings: ReadonlyArray<CernoFindingRecord>;
  readonly facets: {
    readonly hosts: ReadonlyArray<string>;
    readonly harnesses: ReadonlyArray<string>;
  };
}

export interface ReaperPolicyRule {
  readonly path: string;
  readonly maxAgeDays: number;
  readonly keepLatest: number;
  readonly enabled: boolean;
}

export interface ReaperPolicyDocument {
  readonly policyPath: string;
  readonly rules: ReadonlyArray<ReaperPolicyRule>;
  readonly protectedHistoryRoots: ReadonlyArray<string>;
}

export interface StorageMountScan {
  readonly mount: string;
  readonly total_bytes: number;
  readonly used_bytes: number;
  readonly avail_bytes: number;
  readonly used_pct: number;
}

export interface StorageScanPayload {
  readonly manifest?: {
    readonly host: string;
    readonly generatedAt: string;
    readonly entries: ReadonlyArray<{
      readonly id: string;
      readonly provider: string;
      readonly trust: "history" | "ephemeral";
      readonly kind: string;
      readonly path: string;
    }>;
  } | null;
  readonly hostScan?: {
    readonly scanned_at?: string;
    readonly host?: string;
    readonly high_pressure?: boolean;
    readonly pressure_mounts?: ReadonlyArray<string>;
    readonly mounts?: ReadonlyArray<StorageMountScan>;
    readonly top_consumers?: ReadonlyArray<{
      readonly path: string;
      readonly bytes: number;
      readonly mount?: string;
    }>;
  } | null;
}

export interface StorageReviewLaunchPayload {
  readonly ok: boolean;
  readonly launched: boolean;
  readonly threadId?: string;
  readonly projectId?: string;
  readonly prompt: string;
}
