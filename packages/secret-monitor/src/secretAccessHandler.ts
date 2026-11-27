import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

import { appendAccessLog, type AccessLogEntry, type AccessLogOptions } from "./accessLog.ts";
import {
  resolveCallerIdentity,
  unidentifiedCaller,
  type CallerIdentity,
} from "./callerIdentity.ts";
import { isQuietRead, type SecretCall } from "./secretMessages.ts";

/** Quiet items are found by attribute; rotating the token recreates the item at a new path. */
export const QUIET_REFRESH_MILLIS = 60_000;
const SENDER_CACHE_LIMIT = 512;

/** What the handler asks of the bus, kept apart so the handling logic runs without D-Bus. */
export interface SecretBusPort {
  /** The monitor's own unique names; their calls are not reported. */
  readonly ownNames: ReadonlySet<string>;
  /** `GetConnectionUnixProcessID`, or null when the bus cannot answer. */
  readonly callerPid: (sender: string) => Effect.Effect<number | null>;
  /** Object paths of the quiet items, or null when the Secret Service cannot answer. */
  readonly searchQuietItems: Effect.Effect<ReadonlySet<string> | null>;
}

/** A GetSecrets call on something other than a quiet item. */
export interface UnexpectedSecretAccess {
  readonly interface: string;
  readonly sender: string | undefined;
  readonly paths: ReadonlyArray<string>;
  readonly caller: CallerIdentity;
}

export type SecretAccessNotifier = (access: UnexpectedSecretAccess) => Effect.Effect<void>;

export interface SecretAccessHandlerOptions {
  readonly port: SecretBusPort;
  readonly log: AccessLogOptions;
  readonly onUnexpectedAccess?: SecretAccessNotifier | undefined;
}

/**
 * Builds the per-message handler. Every non-routine call is logged; only GetSecrets outside the
 * quiet items notifies. A failure on one message is logged and never stops the monitor.
 */
export const makeSecretAccessHandler = (options: SecretAccessHandlerOptions) => {
  const { port } = options;
  const senders = new Map<string, CallerIdentity>();
  let quietPaths: ReadonlySet<string> = new Set();
  let quietCheckedAt: number | null = null;

  const record = (entry: AccessLogEntry) =>
    appendAccessLog(options.log, entry).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not write secret access log", { cause: Cause.pretty(cause) }),
      ),
    );

  // Resolve on every message, not only GetSecrets: OpenSession and SearchItems arrive first,
  // so the sender is cached while its process still exists.
  const describe = Effect.fnUntraced(function* (sender: string | undefined) {
    if (sender === undefined) return unidentifiedCaller(null);
    const cached = senders.get(sender);
    if (cached !== undefined) return cached;
    const pid = yield* port.callerPid(sender);
    if (pid === null) return unidentifiedCaller(null);
    const identity = yield* resolveCallerIdentity(pid);
    if (identity.comm === null) return identity;
    if (senders.size >= SENDER_CACHE_LIMIT) senders.clear();
    senders.set(sender, identity);
    return identity;
  });

  const refreshQuiet = Effect.fnUntraced(function* () {
    const now = yield* Clock.currentTimeMillis;
    if (quietCheckedAt !== null && now - quietCheckedAt < QUIET_REFRESH_MILLIS) return;
    quietCheckedAt = now;
    const found = yield* port.searchQuietItems;
    if (found !== null) quietPaths = found;
  });

  const onCall = Effect.fnUntraced(function* (call: SecretCall) {
    const caller = yield* describe(call.sender);
    if (call.kind === "routine") return;
    if (call.kind === "audit") {
      yield* record({
        event: "call",
        interface: call.interface,
        member: call.member,
        sender: call.sender,
        caller,
      });
      return;
    }
    yield* refreshQuiet();
    const base = {
      interface: call.interface,
      member: "GetSecrets",
      sender: call.sender,
      paths: call.paths,
      caller,
    };
    if (isQuietRead(call.paths, quietPaths)) {
      yield* record({ event: "quiet-read", ...base });
      return;
    }
    yield* record({ event: "unexpected-read", ...base });
    if (options.onUnexpectedAccess !== undefined) {
      yield* options
        .onUnexpectedAccess({
          interface: call.interface,
          sender: call.sender,
          paths: call.paths,
          caller,
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Secret access notifier failed", { cause: Cause.pretty(cause) }),
          ),
        );
    }
  });

  const handle = (call: SecretCall) =>
    onCall(call).pipe(
      Effect.catchCause((cause) =>
        record({ event: "error", sender: call.sender, detail: Cause.pretty(cause) }),
      ),
    );

  return { handle, record } as const;
};
