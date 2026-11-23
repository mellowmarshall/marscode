import type {
  HostGuardResolveInput,
  HostGuardResolveResult,
  HostGuardState,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { GuardGrantBroker, type GuardGrantBrokerOptions } from "./GuardGrantBroker.ts";

class HostGuardBrokerStartError extends Schema.TaggedError<HostGuardBrokerStartError>()(
  "HostGuardBrokerStartError",
  {
    cause: Schema.Defect(),
  },
) {}

/** Effect service exposing host-guard pending override state and human resolution over RPC. */
export class HostGuardBroker extends Context.Service<
  HostGuardBroker,
  {
    readonly state: Effect.Effect<HostGuardState>;
    readonly stateStream: Stream.Stream<HostGuardState>;
    readonly resolve: (
      input: HostGuardResolveInput & { readonly approvedVia?: string | undefined },
    ) => Effect.Effect<HostGuardResolveResult>;
    readonly preapprove: GuardGrantBroker["preapprove"];
  }
>()("t3/hostGuard/HostGuardBroker") {}

export const layerWithOptions = (options: GuardGrantBrokerOptions = {}) =>
  Layer.effect(
    HostGuardBroker,
    Effect.gen(function* () {
      const platform = yield* HostProcess.Platform;
      const changesPubSub = yield* PubSub.unbounded<HostGuardState>();
      const services = yield* Effect.context<never>();
      const broker = new GuardGrantBroker(options);
      const unsubscribe = broker.subscribe(() => {
        Effect.runSyncWith(services)(PubSub.publish(changesPubSub, broker.getState()));
      });
      yield* Effect.addFinalizer(() =>
        Effect.sync(unsubscribe).pipe(
          Effect.andThen(Effect.promise(() => broker.close())),
          Effect.andThen(PubSub.shutdown(changesPubSub)),
        ),
      );
      yield* Effect.tryPromise({
        try: () => broker.start(platform),
        catch: (cause) => new HostGuardBrokerStartError({ cause }),
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("HostGuardBroker failed to start; host-guard approvals disabled.", {
            cause,
          }),
        ),
      );
      return HostGuardBroker.of({
        state: Effect.sync(() => broker.getState()),
        stateStream: Stream.unwrap(
          Effect.gen(function* () {
            const subscription = yield* PubSub.subscribe(changesPubSub);
            const initial = broker.getState();
            return Stream.concat(Stream.make(initial), Stream.fromSubscription(subscription));
          }),
        ).pipe(Stream.scoped),
        resolve: Effect.fn("HostGuardBroker.resolve")(function* (
          input: HostGuardResolveInput & { readonly approvedVia?: string | undefined },
        ) {
          const res = yield* Effect.sync(() =>
            broker.resolveRequest(input.requestId, {
              decision: input.decision,
              reason: input.reason,
              approvedVia: input.approvedVia,
            }),
          );
          return {
            resolved: res.found,
            ...(res.grantId !== undefined ? { grantId: res.grantId } : {}),
          };
        }),
        preapprove: (input) => broker.preapprove(input),
      });
    }),
  );

export const layer = layerWithOptions();
