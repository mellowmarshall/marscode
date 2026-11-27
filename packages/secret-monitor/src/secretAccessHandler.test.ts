import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { AGENT_THREAD_ENV } from "@t3tools/shared/procIdentity";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { TestClock } from "effect/testing";

import { AccessLogLine } from "./accessLog.ts";
import {
  makeSecretAccessHandler,
  QUIET_REFRESH_MILLIS,
  type SecretBusPort,
  type UnexpectedSecretAccess,
} from "./secretAccessHandler.ts";
import { classifySecretMessage, type ObservedMessage } from "./secretMessages.ts";

const decodeLine = Schema.decodeUnknownSync(Schema.fromJsonString(AccessLogLine));

const QUIET_PATH = "/org/freedesktop/secrets/collection/login/quiet";
const OTHER_PATH = "/org/freedesktop/secrets/collection/login/other";

const PROC: Readonly<Record<string, string>> = {
  "/proc/300/comm": "op\n",
  "/proc/300/environ": `${AGENT_THREAD_ENV}=thread-ops\0`,
  "/proc/400/comm": "secret-tool\n",
  "/proc/400/environ": "PATH=/usr/bin\0",
  "/proc/400/stat": "400 (secret-tool) S 1 400 400 0",
};

/** The real file system for the log, with `/proc` answered from a fixed table. */
const layerProc = Layer.effect(
  FileSystem.FileSystem,
  Effect.map(FileSystem.FileSystem, (real) => {
    const missing = FileSystem.makeNoop({});
    return {
      ...real,
      readFileString: (path: string, encoding?: string) => {
        if (!path.startsWith("/proc/")) return real.readFileString(path, encoding);
        const content = PROC[path];
        return content === undefined ? missing.readFileString(path) : Effect.succeed(content);
      },
    };
  }),
).pipe(Layer.provideMerge(NodeServices.layer));

const message = (member: string, sender: string, body: ReadonlyArray<unknown> = []) =>
  ({
    isMethodCall: true,
    interface: "org.freedesktop.Secret.Service",
    member,
    sender,
    body,
  }) satisfies ObservedMessage;

const makeFixture = Effect.fnUntraced(function* (
  options: {
    readonly quiet?: ReadonlySet<string> | null;
    readonly notifierFails?: boolean;
  } = {},
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped();
  const logPath = path.join(root, "access.jsonl");
  const pidLookups: string[] = [];
  let quietSearches = 0;
  const notified: UnexpectedSecretAccess[] = [];
  const pids: Record<string, number> = { ":1.30": 300, ":1.40": 400, ":1.50": 999 };
  const port: SecretBusPort = {
    ownNames: new Set([":1.1", ":1.2"]),
    callerPid: (sender) =>
      Effect.sync(() => {
        pidLookups.push(sender);
        return pids[sender] ?? null;
      }),
    searchQuietItems: Effect.sync(() => {
      quietSearches += 1;
      return options.quiet === undefined ? new Set([QUIET_PATH]) : options.quiet;
    }),
  };
  const handler = makeSecretAccessHandler({
    port,
    log: { path: logPath },
    onUnexpectedAccess: (access) =>
      options.notifierFails
        ? Effect.die(new Error("notifier down"))
        : Effect.sync(() => {
            notified.push(access);
          }),
  });
  const lines = fileSystem.readFileString(logPath).pipe(
    Effect.orElseSucceed(() => ""),
    Effect.map((content) =>
      content
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => decodeLine(line)),
    ),
  );
  // The monitor classifies at the bus listener; the handler sees only Secret Service calls.
  const handle = (observed: ObservedMessage) => {
    const call = classifySecretMessage(observed, port.ownNames);
    return call === null ? Effect.void : handler.handle(call);
  };
  return {
    handle,
    lines,
    notified,
    pidLookups,
    quietSearches: () => quietSearches,
  };
});

it.layer(layerProc)("makeSecretAccessHandler", (it) => {
  it.effect("notifies an unexpected GetSecrets with the caller's T3 thread", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      yield* fixture.handle(message("OpenSession", ":1.30"));
      yield* fixture.handle(message("GetSecrets", ":1.30", [[OTHER_PATH], "/session/1"]));

      expect(fixture.notified).toEqual([
        {
          interface: "org.freedesktop.Secret.Service",
          sender: ":1.30",
          paths: [OTHER_PATH],
          caller: {
            pid: 300,
            comm: "op",
            threadId: "thread-ops",
            threadPid: 300,
            label: "T3 thread thread-ops",
          },
        },
      ]);
      // OpenSession is routine: nothing logged, but it primed the sender cache.
      expect(fixture.pidLookups).toEqual([":1.30"]);
      const lines = yield* fixture.lines;
      expect(lines.map((line) => line.event)).toEqual(["unexpected-read"]);
      expect(lines[0]?.caller?.threadId).toBe("thread-ops");
    }),
  );

  it.effect("logs a quiet-item read without notifying", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      yield* fixture.handle(message("GetSecrets", ":1.40", [[QUIET_PATH]]));

      expect(fixture.notified).toEqual([]);
      const lines = yield* fixture.lines;
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        event: "quiet-read",
        member: "GetSecrets",
        paths: [QUIET_PATH],
        caller: { label: "secret-tool (direct keyring read)", threadId: null },
      });
    }),
  );

  it.effect("notifies a read mixing quiet and other items", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      yield* fixture.handle(message("GetSecrets", ":1.40", [[QUIET_PATH, OTHER_PATH]]));
      expect(fixture.notified).toHaveLength(1);
    }),
  );

  it.effect("audits SearchItems and ignores the monitor's own connections", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      yield* fixture.handle(message("SearchItems", ":1.40", [{ service: "x" }]));
      yield* fixture.handle(message("GetSecrets", ":1.1", [[OTHER_PATH]]));

      expect(fixture.notified).toEqual([]);
      expect(fixture.pidLookups).toEqual([":1.40"]);
      const lines = yield* fixture.lines;
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ event: "call", member: "SearchItems", sender: ":1.40" });
    }),
  );

  it.effect("searches for quiet items once a minute, keeping the last answer on failure", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const read = message("GetSecrets", ":1.40", [[QUIET_PATH]]);
      yield* fixture.handle(read);
      yield* fixture.handle(read);
      expect(fixture.quietSearches()).toBe(1);

      yield* TestClock.adjust(QUIET_REFRESH_MILLIS);
      yield* fixture.handle(read);
      expect(fixture.quietSearches()).toBe(2);
      expect(fixture.notified).toEqual([]);
    }),
  );

  it.effect("notifies every read while the Secret Service cannot list quiet items", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture({ quiet: null });
      yield* fixture.handle(message("GetSecrets", ":1.40", [[QUIET_PATH]]));
      expect(fixture.notified).toHaveLength(1);
    }),
  );

  it.effect("reports a caller that exited as unidentified and does not cache it", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      yield* fixture.handle(message("SearchItems", ":1.50"));
      yield* fixture.handle(message("GetSecrets", ":1.50", [[OTHER_PATH]]));

      expect(fixture.pidLookups).toEqual([":1.50", ":1.50"]);
      expect(fixture.notified[0]?.caller).toEqual({
        pid: 999,
        comm: null,
        threadId: null,
        threadPid: null,
        label: "an unidentified process",
      });
    }),
  );

  it.effect("keeps the log entry when the notifier fails", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture({ notifierFails: true });
      yield* fixture.handle(message("GetSecrets", ":1.40", [[OTHER_PATH]]));
      yield* fixture.handle(message("GetSecrets", ":1.40", [[OTHER_PATH]]));
      const lines = yield* fixture.lines;
      expect(lines.map((line) => line.event)).toEqual(["unexpected-read", "unexpected-read"]);
    }),
  );
});
