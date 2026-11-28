// @effect-diagnostics nodeBuiltinImport:off - Effect-layer wiring for NativeFleetService.
import * as NodeOS from "node:os";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as HostPowerMonitor from "../../background/HostPowerMonitor.ts";
import * as GitManager from "../../git/GitManager.ts";
import * as GitWorkflowService from "../../git/GitWorkflowService.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as PeerLinks from "../../peer/PeerLinks.ts";
import * as DesktopTelemetryReceiver from "../../resourceTelemetry/DesktopTelemetryReceiver.ts";
import * as HostResources from "../../resourceTelemetry/HostResources.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as JobRegistry from "../jobs/JobRegistry.ts";
import type { FleetWorktreesPanel } from "./FleetTypes.ts";
import { makeFleetWorktreesCollector } from "./FleetWorktrees.ts";
import { NativeFleetService } from "./NativeFleetService.ts";

/** Builds the worktrees panel reader when the project store and Git services are present. */
const makeWorktreesReader = Effect.fn("NativeFleet.makeWorktreesReader")(function* () {
  const gitOpt = yield* Effect.serviceOption(GitVcsDriver.GitVcsDriver);
  const workflowOpt = yield* Effect.serviceOption(GitWorkflowService.GitWorkflowService);
  const gitManagerOpt = yield* Effect.serviceOption(GitManager.GitManager);
  const projectStoreOpt = yield* Effect.serviceOption(ProjectStore.ProjectStoreV2);
  if (
    Option.isNone(gitOpt) ||
    Option.isNone(workflowOpt) ||
    Option.isNone(gitManagerOpt) ||
    Option.isNone(projectStoreOpt)
  ) {
    return undefined;
  }
  const collector = yield* makeFleetWorktreesCollector.pipe(
    Effect.provideService(GitVcsDriver.GitVcsDriver, gitOpt.value),
    Effect.provideService(GitWorkflowService.GitWorkflowService, workflowOpt.value),
    Effect.provideService(GitManager.GitManager, gitManagerOpt.value),
  );
  const projectStore = projectStoreOpt.value;
  const runWithServices = Effect.runPromiseWith(yield* Effect.context<never>());
  return (): Promise<FleetWorktreesPanel | null> =>
    runWithServices(
      Effect.gen(function* () {
        const shells = yield* projectStore.listShells().pipe(Effect.orElseSucceed(() => []));
        const nowMs = yield* Clock.currentTimeMillis;
        return yield* collector.collect({
          projectRoots: shells.map((shell) => shell.workspaceRoot),
          nowMs,
        });
      }).pipe(Effect.orElseSucceed(() => null)),
    );
});

export const makeNativeFleetFromContext = Effect.fn("NativeFleet.makeFromContext")(
  function* (options: {
    readonly override?: NativeFleetService | undefined;
    readonly enableBackground: boolean;
  }) {
    if (options.override) {
      yield* Effect.addFinalizer(() => Effect.sync(() => options.override!.close()));
      return options.override;
    }
    const platform = yield* HostProcess.Platform;
    const hostnameOpt = yield* Effect.serviceOption(HostProcess.Hostname);
    const localHostName = Option.getOrElse(hostnameOpt, () => NodeOS.hostname());
    const hostResourcesOpt = yield* Effect.serviceOption(HostResources.HostResources);
    const hostPowerOpt = yield* Effect.serviceOption(HostPowerMonitor.HostPowerMonitor);
    const desktopTelemetryOpt = yield* Effect.serviceOption(
      DesktopTelemetryReceiver.DesktopTelemetryReceiver,
    );
    const peerLinksOpt = yield* Effect.serviceOption(PeerLinks.PeerLinks);
    const jobRegistryOpt = yield* Effect.serviceOption(JobRegistry.JobRegistry);
    const services = yield* Effect.context<never>();
    const runWithServices = Effect.runPromiseWith(services);
    const readWorktrees = yield* makeWorktreesReader();

    const fleet = new NativeFleetService({
      hostname: localHostName,
      platform,
      enableBackgroundPolling: options.enableBackground,
      readHostResources: Option.isSome(hostResourcesOpt)
        ? () => runWithServices(hostResourcesOpt.value.read.pipe(Effect.orElseSucceed(() => null)))
        : undefined,
      readDesktopPower: Option.isSome(hostPowerOpt)
        ? () => runWithServices(hostPowerOpt.value.snapshot.pipe(Effect.orElseSucceed(() => null)))
        : Option.isSome(desktopTelemetryOpt)
          ? () =>
              runWithServices(
                desktopTelemetryOpt.value.latest.pipe(
                  Effect.map((opt) => (Option.isSome(opt) ? opt.value.power : null)),
                  Effect.orElseSucceed(() => null),
                ),
              )
          : undefined,
      readWorktrees,
      onProcessTable: Option.isSome(jobRegistryOpt)
        ? (rows) => void jobRegistryOpt.value.applyProcessTable(rows)
        : undefined,
      listPeerLinks: Option.isSome(peerLinksOpt)
        ? () =>
            runWithServices(
              peerLinksOpt.value.names.pipe(
                Effect.map((links) =>
                  links.map((link) => ({
                    environmentId: link.environmentId,
                    label: link.label,
                    resolve: () =>
                      runWithServices(
                        peerLinksOpt.value.resolve(link.environmentId).pipe(
                          Effect.map((resolved) => ({
                            url: resolved.url,
                            token: resolved.token,
                          })),
                          Effect.orElseSucceed(() => null),
                        ),
                      ),
                  })),
                ),
                Effect.orElseSucceed(() => []),
              ),
            )
        : undefined,
    });
    yield* Effect.addFinalizer(() => Effect.sync(() => fleet.close()));
    return fleet;
  },
);
