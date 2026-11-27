// @effect-diagnostics nodeBuiltinImport:off - Runs a real dbus-daemon process and gates on its binary.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ONE_PASSWORD_SERVICE_ACCOUNT_KEYRING_ATTRIBUTES } from "@t3tools/secret-provider-onepassword/shared/definition";
import { Message, MessageType, type MessageBus } from "dbus-next";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import { TestClock } from "effect/testing";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeEvents from "node:events";

import type { UnexpectedSecretAccess } from "./secretAccessHandler.ts";
import { monitorMatchRules } from "./secretMessages.ts";
import { CONNECT_TIMEOUT, startSecretMonitor, SecretMonitorUnavailable } from "./SecretMonitor.ts";

class FakeBus extends NodeEvents.EventEmitter {
  readonly calls: Message[] = [];
  readonly methodHandlers: Array<(message: Message) => boolean> = [];
  disconnected = false;
  readonly name: string;
  private readonly answer: (message: Message) => Message | null;

  constructor(
    name: string,
    answer: (message: Message) => Message | null,
    connects: boolean = true,
  ) {
    super();
    this.name = name;
    this.answer = answer;
    if (connects) queueMicrotask(() => this.emit("connect"));
  }

  call(message: Message): Promise<Message | null> {
    this.calls.push(message);
    return Promise.resolve(this.answer(message));
  }

  addMethodHandler(handler: (message: Message) => boolean): void {
    this.methodHandlers.push(handler);
  }

  disconnect(): void {
    this.disconnected = true;
  }
}

const reply = (body: ReadonlyArray<unknown>) =>
  new Message({ type: MessageType.METHOD_RETURN, replySerial: "1", body: [...body] });

it.layer(NodeServices.layer)("startSecretMonitor", (it) => {
  it.effect("becomes a monitor on one connection and resolves callers on the other", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped();
      const buses: FakeBus[] = [];
      const answer = (message: Message) => {
        if (message.member === "GetConnectionUnixProcessID") return reply([999_999_999]);
        if (message.member === "SearchItems") return reply([["/quiet"], []]);
        return reply([]);
      };
      const notified = yield* Deferred.make<UnexpectedSecretAccess>();

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* startSecretMonitor({
            busAddress: "unix:path=/fake/bus",
            log: { path: path.join(root, "access.jsonl") },
            connect: () => {
              const bus = new FakeBus(`:1.${buses.length + 1}`, answer);
              buses.push(bus);
              return bus as unknown as MessageBus;
            },
            onUnexpectedAccess: (access) => Deferred.succeed(notified, access).pipe(Effect.asVoid),
          });
          const [resolver, monitor] = buses;
          expect(resolver?.calls).toEqual([]);
          const become = monitor?.calls[0];
          expect(become?.interface).toBe("org.freedesktop.DBus.Monitoring");
          expect(become?.member).toBe("BecomeMonitor");
          expect(become?.body).toEqual([monitorMatchRules(), 0]);
          // A monitor must never reply to the calls it observes.
          expect(monitor?.methodHandlers.map((claim) => claim(become!))).toEqual([true]);

          const getSecrets = new Message({
            type: MessageType.METHOD_CALL,
            sender: ":1.77",
            destination: ":1.5",
            path: "/org/freedesktop/secrets",
            interface: "org.freedesktop.Secret.Service",
            member: "GetSecrets",
            signature: "aoo",
            body: [["/other"], "/session/1"],
          });
          monitor?.emit("message", getSecrets);
          const access = yield* Deferred.await(notified);
          expect(access.sender).toBe(":1.77");
          expect(access.paths).toEqual(["/other"]);
          expect(access.caller.pid).toBe(999_999_999);
          expect(resolver?.calls.map((call) => call.member)).toEqual([
            "GetConnectionUnixProcessID",
            "SearchItems",
          ]);
          expect(resolver?.calls[1]?.body).toEqual([
            ONE_PASSWORD_SERVICE_ACCOUNT_KEYRING_ATTRIBUTES,
          ]);
        }),
      );
      expect(buses.map((bus) => bus.disconnected)).toEqual([true, true]);

      const lines = (yield* fileSystem.readFileString(path.join(root, "access.jsonl")))
        .trim()
        .split("\n");
      expect(lines.map((line) => JSON.parse(line).event)).toEqual(["started", "unexpected-read"]);
    }),
  );

  it.effect("reports a lost bus once and survives later socket errors", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped();
      const buses: FakeBus[] = [];
      yield* Effect.scoped(
        Effect.gen(function* () {
          const { disconnected } = yield* startSecretMonitor({
            busAddress: "unix:path=/fake/bus",
            log: { path: path.join(root, "access.jsonl") },
            connect: () => {
              const bus = new FakeBus(`:1.${buses.length + 1}`, () => reply([]));
              buses.push(bus);
              return bus as unknown as MessageBus;
            },
          });
          const [resolver, monitor] = buses;
          monitor?.emit("error", new Error("socket closed"));
          expect(yield* Fiber.join(disconnected)).toBe("socket closed");
          // Without a listener left, EventEmitter would throw these into the server.
          expect(() => monitor?.emit("error", new Error("again"))).not.toThrow();
          expect(() => resolver?.emit("error", new Error("again"))).not.toThrow();
        }),
      );
    }),
  );

  it.effect("fails with SecretMonitorUnavailable when the bus cannot be reached", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.scoped(
        startSecretMonitor({
          busAddress: "unix:path=/fake/bus",
          log: { path: "/nonexistent/access.jsonl" },
          connect: () => {
            throw new Error("DBUS_SESSION_BUS_ADDRESS is not set");
          },
        }),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(String(exit.cause)).toContain("SecretMonitorUnavailable");
      }
      expect(SecretMonitorUnavailable).toBeDefined();
    }),
  );

  it.effect("fails when the bus refuses BecomeMonitor, and closes both connections", () =>
    Effect.gen(function* () {
      const buses: FakeBus[] = [];
      const exit = yield* Effect.scoped(
        startSecretMonitor({
          busAddress: "unix:path=/fake/bus",
          log: { path: "/nonexistent/access.jsonl" },
          connect: () => {
            const bus = new FakeBus(`:1.${buses.length + 1}`, () => {
              throw new Error("AccessDenied");
            });
            buses.push(bus);
            return bus as unknown as MessageBus;
          },
        }),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(buses.map((bus) => bus.disconnected)).toEqual([true, true]);
    }),
  );
  it.effect("gives up on a bus that never finishes the handshake", () =>
    Effect.gen(function* () {
      const buses: FakeBus[] = [];
      const failure = yield* Effect.scoped(
        startSecretMonitor({
          busAddress: "unix:path=/fake/bus",
          log: { path: "/nonexistent/access.jsonl" },
          connect: () => {
            const bus = new FakeBus(":1.1", () => reply([]), false);
            buses.push(bus);
            return bus as unknown as MessageBus;
          },
        }),
      ).pipe(Effect.flip, Effect.forkChild);
      yield* TestClock.adjust(CONNECT_TIMEOUT);
      const error = yield* Fiber.join(failure);
      expect(error).toBeInstanceOf(SecretMonitorUnavailable);
      expect(buses.map((bus) => bus.disconnected)).toEqual([true]);
    }),
  );
});

const DBUS_DAEMON = "/usr/bin/dbus-daemon";

/** Starts a private session bus; resolves with its address once it listens. */
const startBusDaemon = (socketPath: string) =>
  Effect.acquireRelease(
    Effect.callback<{ readonly daemon: NodeChildProcess.ChildProcess; readonly address: string }>(
      (resume) => {
        const daemon = NodeChildProcess.spawn(
          DBUS_DAEMON,
          [
            "--session",
            "--nofork",
            "--nopidfile",
            "--print-address=1",
            `--address=unix:path=${socketPath}`,
          ],
          { stdio: ["ignore", "pipe", "inherit"] },
        );
        let output = "";
        daemon.stdout?.on("data", (chunk: Buffer) => {
          output += chunk.toString();
          const newline = output.indexOf("\n");
          if (newline >= 0) resume(Effect.succeed({ daemon, address: output.slice(0, newline) }));
        });
      },
    ),
    ({ daemon }) => Effect.sync(() => daemon.kill("SIGKILL")),
  );

describe("startSecretMonitor on a real session bus", () => {
  it.live.skipIf(!NodeFS.existsSync(DBUS_DAEMON))("detects the bus daemon being killed", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped();
      const { daemon, address } = yield* startBusDaemon(path.join(root, "bus"));
      const logPath = path.join(root, "access.jsonl");
      const { disconnected } = yield* startSecretMonitor({
        busAddress: address,
        log: { path: logPath },
      });

      daemon.kill("SIGKILL");
      const reason = yield* Fiber.join(disconnected);

      // SIGKILL closes the socket cleanly: no `error` event, only end and close.
      expect(reason).toMatch(/^session bus (connection ended|socket closed)$/u);
      const events = (yield* fileSystem.readFileString(logPath))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).event);
      expect(events).toEqual(["started"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
