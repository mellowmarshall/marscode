// Config, fleet host-config sync, review stats, and cerno stats routes for `/api/devtools/*`.
import * as NodeOS from "node:os";

import { aggregateReviewStats } from "@t3tools/playbook/statsAggregate";
import type { ReviewStatsGroupBy, ReviewStatsSide } from "@t3tools/playbook/statsTypes";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as UsageLimitSources from "../usage/UsageLimitSources.ts";
import * as CernoStats from "./CernoStats.ts";
import * as DevtoolsConfig from "./DevtoolsConfig.ts";
import * as DevtoolsFleetConfig from "./DevtoolsFleetConfig.ts";
import * as DevtoolsFleetConfigCache from "./DevtoolsFleetConfigCache.ts";
import { jsonResponse, readJsonBody } from "./DevtoolsHttpContext.ts";
import type { GuardGrantBroker } from "./GuardGrantBroker.ts";
import type * as JobRegistry from "./jobs/JobRegistry.ts";
import * as ReviewStats from "./ReviewStats.ts";
import * as ReviewStatsThreads from "./ReviewStatsThreads.ts";

export const handleConfigAndStatsRoute = Effect.fn("DevtoolsConfigRoutes.handle")(
  function* (input: {
    readonly method: "GET" | "POST";
    readonly subPath: string;
    readonly url: URL;
    readonly broker: GuardGrantBroker;
    readonly jobRegistry: JobRegistry.JobRegistryService;
    readonly shipQueueRootOverride?: string | undefined;
  }) {
    const { method, subPath, url, broker, jobRegistry, shipQueueRootOverride } = input;

    if (method === "GET" && subPath === "/config/fleet") {
      const providerRegOpt = yield* Effect.serviceOption(ProviderRegistry.ProviderRegistry);
      const limitSourcesOpt = yield* Effect.serviceOption(UsageLimitSources.UsageLimitSources);
      const providers = Option.isSome(providerRegOpt)
        ? yield* providerRegOpt.value.getProviders.pipe(Effect.orElseSucceed(() => []))
        : [];
      const limitSources = Option.isSome(limitSourcesOpt)
        ? yield* limitSourcesOpt.value.current.pipe(Effect.orElseSucceed(() => []))
        : [];
      const refresh = url.searchParams.get("refresh") === "1";
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
      const hostParam = url.searchParams.get("host")?.trim() ?? "";
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
            { providers, limitSources },
          ),
          shipQueueReview: DevtoolsConfig.resolveReviewRolePlan(
            "ship_queue_review",
            resultingConfig,
            { providers, limitSources },
          ),
        },
      });
    }

    if (method === "GET" && subPath === "/review-stats") {
      const sp = url.searchParams;
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
      let delegatedReviews:
        | ReadonlyArray<ReviewStatsThreads.DelegatedReviewSubagentRow>
        | undefined;
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
      const sp = url.searchParams;
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

    return null;
  },
);
