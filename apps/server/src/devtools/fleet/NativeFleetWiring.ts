// @effect-diagnostics nodeBuiltinImport:off - Effect-layer wiring for NativeFleetService and legacy DevDeck override check.
import * as NodeOS from "node:os";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as PeerLinks from "../../peer/PeerLinks.ts";
import * as DesktopTelemetryReceiver from "../../resourceTelemetry/DesktopTelemetryReceiver.ts";
import * as HostResources from "../../resourceTelemetry/HostResources.ts";
import * as DevdeckProxy from "../DevdeckProxy.ts";
import { NativeFleetService } from "./NativeFleetService.ts";

export function shouldUseLegacyDevdeckProxy(devdeckTarget?: DevdeckProxy.DevdeckTarget): boolean {
  return Boolean(devdeckTarget) || DevdeckProxy.hasDevdeckEndpointOverride();
}

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
    const desktopTelemetryOpt = yield* Effect.serviceOption(
      DesktopTelemetryReceiver.DesktopTelemetryReceiver,
    );
    const peerLinksOpt = yield* Effect.serviceOption(PeerLinks.PeerLinks);
    const services = yield* Effect.context<never>();
    const runWithServices = Effect.runPromiseWith(services);

    const fleet = new NativeFleetService({
      hostname: localHostName,
      platform,
      enableBackgroundPolling: options.enableBackground,
      writeNodesFile: options.enableBackground,
      readHostResources: Option.isSome(hostResourcesOpt)
        ? () => runWithServices(hostResourcesOpt.value.read.pipe(Effect.orElseSucceed(() => null)))
        : undefined,
      readDesktopPower: Option.isSome(desktopTelemetryOpt)
        ? () =>
            runWithServices(
              desktopTelemetryOpt.value.latest.pipe(
                Effect.map((opt) => (Option.isSome(opt) ? opt.value.power : null)),
                Effect.orElseSucceed(() => null),
              ),
            )
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
