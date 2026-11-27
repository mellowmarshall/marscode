import { ONE_PASSWORD_SERVICE_ACCOUNT_KEYRING_ATTRIBUTES } from "@t3tools/secret-provider-onepassword/shared/definition";
import { Message, MessageType, sessionBus, type MessageBus } from "dbus-next";
import * as NodeEvents from "node:events";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { AccessLogOptions } from "./accessLog.ts";
import {
  makeSecretAccessHandler,
  type SecretAccessNotifier,
  type SecretBusPort,
} from "./secretAccessHandler.ts";
import { makeSecretCallQueue } from "./secretCallQueue.ts";
import {
  classifySecretMessage,
  monitorMatchRules,
  parseSearchItemsReply,
} from "./secretMessages.ts";

const DBUS_NAME = "org.freedesktop.DBus";
const DBUS_PATH = "/org/freedesktop/DBus";
const SECRETS_NAME = "org.freedesktop.secrets";
const SECRETS_PATH = "/org/freedesktop/secrets";
/** Bounds the socket handshake, so a bus that never authenticates is reported unavailable. */
export const CONNECT_TIMEOUT = Duration.seconds(5);

export class SecretMonitorUnavailable extends Schema.TaggedError<SecretMonitorUnavailable>()(
  "SecretMonitorUnavailable",
  { reason: Schema.String },
) {}

export interface SecretMonitorOptions {
  readonly log: AccessLogOptions;
  readonly onUnexpectedAccess?: SecretAccessNotifier | undefined;
  /** The session bus address, as in `DBUS_SESSION_BUS_ADDRESS`. */
  readonly busAddress: string;
  /** Opens a connection to `busAddress`; replaced only in tests. */
  readonly connect?: ((busAddress: string) => MessageBus) | undefined;
}

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** dbus-next keeps its stream on a private connection; the bus emits nothing when it ends. */
interface BusConnection {
  readonly _connection?: NodeEvents.EventEmitter & { readonly stream?: NodeEvents.EventEmitter };
}

/**
 * Calls `onLost` once when the bus fails or its socket ends or closes, as when the bus daemon
 * dies. The listeners stay for the bus's lifetime: an `error` event with no listener throws,
 * and a later socket error must not take the server down.
 */
const watchBusLoss = (bus: MessageBus, onLost: (reason: string) => void): void => {
  let lost = false;
  const report = (reason: string) => {
    if (lost) return;
    lost = true;
    onLost(reason);
  };
  bus.on("error", (error: unknown) => report(describeError(error)));
  const connection = (bus as MessageBus & BusConnection)._connection;
  connection?.on("end", () => report("session bus connection ended"));
  connection?.stream?.on("close", () => report("session bus socket closed"));
};

const openBus = (connect: () => MessageBus) =>
  Effect.acquireRelease(
    Effect.callback<MessageBus, SecretMonitorUnavailable>((resume) => {
      let bus: MessageBus;
      try {
        bus = connect();
      } catch (error) {
        resume(Effect.fail(new SecretMonitorUnavailable({ reason: describeError(error) })));
        return;
      }
      let settled = false;
      watchBusLoss(bus, (reason) => {
        if (settled) return;
        settled = true;
        bus.disconnect();
        resume(Effect.fail(new SecretMonitorUnavailable({ reason })));
      });
      bus.once("connect", () => {
        if (settled) return;
        settled = true;
        resume(Effect.succeed(bus));
      });
      return Effect.sync(() => {
        if (settled) return;
        settled = true;
        bus.disconnect();
      });
    }).pipe(
      // A bus that accepts the socket but never finishes authentication must not hold startup.
      Effect.timeoutOrElse({
        duration: CONNECT_TIMEOUT,
        orElse: () =>
          Effect.fail(
            new SecretMonitorUnavailable({ reason: "session bus did not answer the handshake" }),
          ),
      }),
    ),
    (bus) => Effect.sync(() => bus.disconnect()),
  );

const callBus = (bus: MessageBus, message: Message) =>
  Effect.tryPromise({
    try: () => bus.call(message),
    catch: (error) => new SecretMonitorUnavailable({ reason: describeError(error) }),
  });

/** dbus-next sets the unique name once connected; its patched typings omit the field. */
const uniqueName = (bus: MessageBus): string | null =>
  (bus as MessageBus & { readonly name?: string | null }).name ?? null;

const makeBusPort = (resolver: MessageBus, monitor: MessageBus): SecretBusPort => ({
  ownNames: new Set(
    [uniqueName(resolver), uniqueName(monitor)].filter((name): name is string => name !== null),
  ),
  callerPid: (sender) =>
    callBus(
      resolver,
      new Message({
        destination: DBUS_NAME,
        path: DBUS_PATH,
        interface: DBUS_NAME,
        member: "GetConnectionUnixProcessID",
        signature: "s",
        body: [sender],
      }),
    ).pipe(
      Effect.map((reply) => {
        const pid = reply?.body[0];
        return typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? pid : null;
      }),
      Effect.orElseSucceed(() => null),
    ),
  searchQuietItems: callBus(
    resolver,
    new Message({
      destination: SECRETS_NAME,
      path: SECRETS_PATH,
      interface: "org.freedesktop.Secret.Service",
      member: "SearchItems",
      signature: "a{ss}",
      body: [ONE_PASSWORD_SERVICE_ACCOUNT_KEYRING_ATTRIBUTES],
    }),
  ).pipe(
    Effect.map((reply) => (reply === null ? null : parseSearchItemsReply(reply.body))),
    Effect.orElseSucceed(() => null),
  ),
});

/**
 * Watches the session bus for Secret Service method calls until the scope closes. Fails with
 * `SecretMonitorUnavailable` when the bus cannot be reached or refuses `BecomeMonitor`.
 *
 * Two connections on purpose: a connection that has called `BecomeMonitor` may not send, so
 * caller resolution and SearchItems go through a second one.
 */
export const startSecretMonitor = Effect.fn("SecretMonitor.start")(function* (
  options: SecretMonitorOptions,
) {
  const connect = () =>
    (options.connect ?? ((busAddress) => sessionBus({ busAddress })))(options.busAddress);
  const resolver = yield* openBus(connect);
  const monitor = yield* openBus(connect);
  const port = makeBusPort(resolver, monitor);
  const handler = makeSecretAccessHandler({
    port,
    log: options.log,
    onUnexpectedAccess: options.onUnexpectedAccess,
  });

  // Classify in the listener, so plumbing and foreign traffic never take queue space that a
  // GetSecrets needs.
  const calls = yield* makeSecretCallQueue();
  // dbus-next answers any method call no handler claims; a monitor must never send, or the
  // bus disconnects it. Claim every call so it stays silent.
  monitor.addMethodHandler(() => true);
  monitor.on("message", (message: Message) => {
    const call = classifySecretMessage(
      {
        isMethodCall: message.type === MessageType.METHOD_CALL,
        interface: message.interface,
        member: message.member,
        sender: message.sender,
        body: message.body,
      },
      port.ownNames,
    );
    if (call !== null) calls.offer(call);
  });
  const disconnected = yield* Effect.callback<string>((resume) => {
    const onLost = (reason: string) => resume(Effect.succeed(reason));
    watchBusLoss(monitor, onLost);
    watchBusLoss(resolver, onLost);
  }).pipe(Effect.forkScoped);

  yield* callBus(
    monitor,
    new Message({
      destination: DBUS_NAME,
      path: DBUS_PATH,
      interface: "org.freedesktop.DBus.Monitoring",
      member: "BecomeMonitor",
      signature: "asu",
      body: [monitorMatchRules(), 0],
    }),
  );
  yield* handler.record({ event: "started" });

  yield* calls.take.pipe(
    Effect.flatMap(({ call, dropped }) =>
      Effect.gen(function* () {
        if (dropped > 0) {
          yield* Effect.logWarning("Secret Service monitor dropped audit calls", { dropped });
          yield* handler.record({ event: "dropped", dropped });
        }
        yield* handler.handle(call);
      }),
    ),
    Effect.forever,
    Effect.forkScoped,
  );
  return { disconnected } as const;
});
