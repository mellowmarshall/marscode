/**
 * Lazy headless runtime layer for `t3 generate`.
 * Imported dynamically only when `t3 generate` runs without a pre-provided `TextGeneration`
 * service, keeping CLI startup fast and preserving deferred-import boundaries.
 */
import * as AcpRegistrySupport from "@t3tools/provider-acp-registry/server/AcpRegistrySupport";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as OpenCodeRuntime from "@t3tools/provider-opencode/server/OpenCodeRuntime";
import * as OpenCodeServerLedger from "@t3tools/provider-opencode/server/OpenCodeServerLedger";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as HostPowerMonitor from "../background/HostPowerMonitor.ts";
import * as ServerConfig from "../config.ts";
import * as TrustedProviderRegistry from "../devtools/TrustedProviderRegistry.ts";
import { ExternalBackgroundWorkProbeLive } from "../devtools/jobs/cernoThreadProbe.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as PortScanner from "../preview/PortScanner.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as AntigravityInstallation from "../provider/AntigravityInstallation.ts";
import * as CodexInstallation from "../provider/CodexInstallation.ts";
import * as CodexManagedTokenBroker from "../provider/CodexManagedTokenBroker.ts";
import * as ModelManifest from "../provider/ModelManifest.ts";
import * as ProviderHostLive from "../provider/ProviderHostLive.ts";
import * as ProviderInstallationGate from "../provider/ProviderInstallationGate.ts";
import * as ProviderInstanceRegistryHydration from "../provider/ProviderInstanceRegistryHydration.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ResetCreditCoordinator from "../provider/resetCreditCoordinator.ts";
import * as DesktopTelemetryReceiver from "../resourceTelemetry/DesktopTelemetryReceiver.ts";
import * as SecretResolver from "../secrets/SecretResolver.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";

/** Build the minimal headless TextGeneration + ProviderRegistry layer for `t3 generate`. */
export function makeHeadlessGenerateLayer(configLayer: Layer.Layer<ServerConfig.ServerConfig>) {
  const layerRoot = Layer.mergeAll(
    configLayer,
    FetchHttpClient.layer,
    ManagedPolicy.layer,
    ProviderInstallationGate.layer,
    ExternalBackgroundWorkProbeLive,
    McpProviderSessions.layer,
    IdAllocator.layer,
    Layer.succeed(
      ProviderEventLoggers.ProviderEventLoggers,
      ProviderEventLoggers.NoOpProviderEventLoggers,
    ),
    Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
      resolveLink: () => Effect.die("resolveLink is unused in headless t3 generate"),
    }),
  );

  const layerStorage = Layer.mergeAll(ServerSecretStore.layer, SqlitePersistence.layerConfig).pipe(
    Layer.provideMerge(layerRoot),
  );

  const layerSettings = Layer.mergeAll(ServerSettings.layer, ServerEnvironment.layer).pipe(
    Layer.provideMerge(layerStorage),
  );

  const layerTelemetry = DesktopTelemetryReceiver.layer.pipe(Layer.provideMerge(layerSettings));

  const layerBackground = BackgroundPolicy.layer.pipe(
    Layer.provide(HostPowerMonitor.layer),
    Layer.provideMerge(layerTelemetry),
  );

  const layerManifest = ModelManifest.layer.pipe(Layer.provideMerge(layerBackground));

  const layerDriversSupport = Layer.mergeAll(
    ModelManifest.layerModelCatalog,
    SecretResolver.layer,
    AcpRegistrySupport.layerFromHost.pipe(Layer.provide(ProviderHostLive.layer)),
    PortScanner.layer.pipe(Layer.provide(ProcessRunner.layer)),
    TrustedProviderRegistry.layer,
    ResetCreditCoordinator.layer,
    AntigravityInstallation.AntigravityInstallation.layer,
    CodexInstallation.CodexInstallation.layer,
    CodexManagedTokenBroker.layer,
    ProviderLatestVersions.layer,
    OpenCodeRuntime.layer.pipe(
      Layer.provide(
        Layer.unwrap(
          Effect.gen(function* () {
            const config = yield* ServerConfig.ServerConfig;
            return OpenCodeServerLedger.layer({ stateDir: config.stateDir });
          }),
        ),
      ),
    ),
  ).pipe(Layer.provideMerge(layerManifest));

  const layerHydration = ProviderInstanceRegistryHydration.layer.pipe(
    Layer.provideMerge(layerDriversSupport),
  );
  return Layer.merge(TextGeneration.layer, ProviderRegistry.layer).pipe(
    Layer.provideMerge(layerHydration),
  );
}

export const getProvidersSafe = Effect.gen(function* () {
  const registry = yield* Effect.serviceOption(ProviderRegistry.ProviderRegistry);
  if (registry._tag === "None") return [];
  return yield* registry.value.getProviders.pipe(Effect.orElseSucceed(() => []));
});
