import type { UnexpectedSecretAccess } from "@t3tools/secret-monitor/secretAccessHandler";
import { startSecretMonitor } from "@t3tools/secret-monitor/SecretMonitor";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import { forkParked } from "../serverActivation.ts";

/** The monitor watches the desktop session's keyring, so it runs only where one exists. */
export const sessionBusToMonitor = (
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
): string | null => {
  const address = environment.DBUS_SESSION_BUS_ADDRESS?.trim() ?? "";
  return platform === "linux" && address.length > 0 ? address : null;
};

/** The notification hook: an unexpected keyring read surfaces in the server log as a warning. */
export const reportUnexpectedSecretAccess = (access: UnexpectedSecretAccess) =>
  Effect.logWarning(`Secret Service GetSecrets by ${access.caller.label}`, {
    sender: access.sender,
    pid: access.caller.pid,
    process: access.caller.comm,
    threadId: access.caller.threadId,
    items: access.paths.length,
  });

export const runSecretAccessMonitor = Effect.fn("SecretAccessMonitor.run")(
  function* (busAddress: string, logPath: string) {
    const { disconnected } = yield* startSecretMonitor({
      busAddress,
      log: { path: logPath },
      onUnexpectedAccess: reportUnexpectedSecretAccess,
    });
    yield* Effect.logInfo("Secret Service monitor started", { logPath });
    const reason = yield* Fiber.join(disconnected);
    yield* Effect.logWarning("Secret Service monitor lost the session bus", { reason });
  },
  Effect.scoped,
  // Observation only: a missing bus, a refused BecomeMonitor, or a lost connection never
  // reaches server startup.
  Effect.catchCause((cause) =>
    Effect.logWarning("Secret Service monitor unavailable", { cause: Cause.pretty(cause) }),
  ),
);

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const platform = yield* HostProcess.Platform;
    const environment = yield* HostProcess.Environment;
    const busAddress = sessionBusToMonitor(platform, environment);
    if (busAddress === null) return;
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    yield* forkParked(
      runSecretAccessMonitor(
        busAddress,
        path.join(config.logsDir, "secret-monitor", "access.jsonl"),
      ),
    );
  }),
);
