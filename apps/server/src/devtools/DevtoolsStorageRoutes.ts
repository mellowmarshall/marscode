// Native ReaperService and storage HTTP routes for `/api/devtools/*`.
import {
  CommandId,
  MessageId,
  type ModelSelection,
  ReaperProposalDecision,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as StorageCleanup from "../storageCleanup.ts";
import { jsonResponse, readJsonBody } from "./DevtoolsHttpContext.ts";
import * as ReaperPolicy from "./ReaperPolicy.ts";
import * as ReaperProposals from "./reaper/ReaperProposals.ts";
import * as ReaperReviewPrompt from "./reaper/ReaperReviewPrompt.ts";
import * as Reaper from "./reaper/ReaperService.ts";
import * as StorageManifest from "./StorageManifest.ts";

const decodeProposalDecision = Schema.decodeUnknownOption(ReaperProposalDecision);

export const handleStorageAndToolRoute = Effect.fn("DevtoolsStorageRoutes.handle")(
  function* (input: { readonly method: "GET" | "POST"; readonly subPath: string }) {
    const { method, subPath } = input;

    if (
      (method === "GET" && (subPath === "/reaper/status" || subPath === "/reaper/cargo-dry-run")) ||
      (method === "POST" && subPath === "/reaper/run")
    ) {
      const reaper = yield* Effect.serviceOption(Reaper.ReaperService);
      if (Option.isNone(reaper)) {
        return jsonResponse(
          { ok: false, exitCode: 1, data: null, error: "Reaper unavailable" },
          503,
        );
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

    if (
      (method === "GET" && subPath === "/reaper/proposals") ||
      (method === "POST" && subPath === "/reaper/proposals/decide")
    ) {
      const proposals = yield* Effect.serviceOption(ReaperProposals.ReaperProposals);
      if (Option.isNone(proposals)) return jsonResponse({ error: "Reaper unavailable" }, 503);
      if (method === "GET") {
        return yield* proposals.value.list.pipe(
          Effect.map((list) => jsonResponse({ proposals: list }, 200)),
          Effect.catchTags({
            ReaperProposalStoreError: (e) =>
              Effect.succeed(jsonResponse({ error: e.message }, 500)),
          }),
        );
      }
      const parsed = yield* readJsonBody;
      if (!parsed.ok) return jsonResponse({ error: parsed.error }, parsed.status);
      const decision = decodeProposalDecision(parsed.value);
      if (Option.isNone(decision)) return jsonResponse({ error: "Invalid decision" }, 400);
      return yield* proposals.value.decide(decision.value).pipe(
        Effect.map((list) => jsonResponse({ proposals: list }, 200)),
        Effect.catchTags({
          ReaperProposalNotFoundError: (e) =>
            Effect.succeed(jsonResponse({ error: e.message }, 404)),
          ReaperProposalRefusedError: (e) =>
            Effect.succeed(jsonResponse({ error: e.message }, 400)),
          ReaperProposalStoreError: (e) => Effect.succeed(jsonResponse({ error: e.message }, 500)),
        }),
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
      if (!rawRules) return jsonResponse({ error: "rules array is required" }, 400);
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
      if (!written.ok) return jsonResponse({ error: written.error }, 400);
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
      const manifest = StorageManifest.buildStorageManifestFromSettings(
        serverConfig.value,
        settings,
      );
      yield* Effect.tryPromise({
        try: () => StorageManifest.writeStorageManifestIfChanged(manifest),
        catch: (err) => String(err),
      }).pipe(Effect.catch(() => Effect.void));
      if (subPath === "/storage/manifest") return jsonResponse(manifest, 200);
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
        if (!validated.ok) return jsonResponse({ error: validated.error }, 400);
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
        const prompt = ReaperReviewPrompt.buildStorageCleanupReviewPrompt({
          host: targetHost,
          isLocalHost: targetHost.toLowerCase() === manifest.host.toLowerCase(),
          ...(bodyMounts ? { mounts: bodyMounts } : {}),
          manifest,
        });

        const launchSvcOpt = yield* Effect.serviceOption(ThreadLaunchService.ThreadLaunchService);
        const foldersOpt = yield* Effect.serviceOption(ManagedProjectFolders.ManagedProjectFolders);
        const providersOpt = yield* Effect.serviceOption(ProviderRegistry.ProviderRegistry);
        if (
          Option.isSome(launchSvcOpt) &&
          Option.isSome(foldersOpt) &&
          Option.isSome(providersOpt)
        ) {
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
              ? { instanceId: firstReady.instanceId, model: firstModel.slug }
              : null);
          if (modelSelection) {
            const scratch = yield* foldersOpt.value.ensureScratchProject.pipe(
              Effect.map((v) => v.projectId),
              Effect.orElseSucceed(() => null),
            );
            if (scratch) {
              const reqId = ReaperPolicy.nextStorageReviewRequestId();
              const launched = yield* launchSvcOpt.value
                .launch({
                  commandId: CommandId.make(reqId),
                  threadId: ThreadId.make(reqId),
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

    return null;
  },
);

/** Publishes the storage manifest on startup and whenever server settings change. */
export const startStorageManifestPublisher: (
  cfg: ServerConfig.ServerConfig["Service"],
  settingsService: Option.Option<ServerSettings.ServerSettingsService["Service"]>,
) => Effect.Effect<void, never, Scope.Scope> = Effect.fn(
  "DevtoolsStorageRoutes.startStorageManifestPublisher",
)(function* (
  cfg: ServerConfig.ServerConfig["Service"],
  settingsService: Option.Option<ServerSettings.ServerSettingsService["Service"]>,
) {
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
      Effect.catch((err) => Effect.logWarning(`Devtools StorageManifest write failed: ${err}`)),
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
});
