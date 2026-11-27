import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as SecretAccessMonitor from "./SecretAccessMonitor.ts";

describe("sessionBusToMonitor", () => {
  it("monitors only on Linux with a session bus address", () => {
    const bus = { DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus" };
    expect(SecretAccessMonitor.sessionBusToMonitor("linux", bus)).toBe(
      "unix:path=/run/user/1000/bus",
    );
    expect(SecretAccessMonitor.sessionBusToMonitor("linux", {})).toBeNull();
    expect(
      SecretAccessMonitor.sessionBusToMonitor("linux", { DBUS_SESSION_BUS_ADDRESS: "  " }),
    ).toBeNull();
    expect(SecretAccessMonitor.sessionBusToMonitor("darwin", bus)).toBeNull();
  });
});

const layerServices = ServerConfig.layerTest(process.cwd(), {
  prefix: "secret-access-monitor-",
}).pipe(Layer.provideMerge(NodeServices.layer));

it.layer(layerServices)("SecretAccessMonitor", (it) => {
  it.effect("builds without a session bus", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.scoped(Layer.build(SecretAccessMonitor.layer)).pipe(
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(HostProcess.Environment, {}),
        Effect.exit,
      );
      expect(Exit.isSuccess(exit)).toBe(true);
    }),
  );

  it.effect("finishes quietly when the session bus cannot be reached", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped();
      const exit = yield* SecretAccessMonitor.runSecretAccessMonitor(
        `unix:path=${path.join(root, "no-bus.sock")}`,
        path.join(root, "access.jsonl"),
      ).pipe(Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(yield* fileSystem.exists(path.join(root, "access.jsonl"))).toBe(false);
    }),
  );

  it.effect("reports an unexpected read without failing", () =>
    SecretAccessMonitor.reportUnexpectedSecretAccess({
      interface: "org.freedesktop.Secret.Service",
      sender: ":1.9",
      paths: ["/org/freedesktop/secrets/collection/login/1"],
      caller: {
        pid: 1234,
        comm: "chrome",
        threadId: null,
        threadPid: null,
        label: "Google Chrome",
      },
    }),
  );
});
