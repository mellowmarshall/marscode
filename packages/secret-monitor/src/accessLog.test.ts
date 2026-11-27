import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { AccessLogLine, appendAccessLog, rotatedLogPath } from "./accessLog.ts";

const decodeLine = Schema.decodeUnknownSync(Schema.fromJsonString(AccessLogLine));

const readLines = (fileSystem: FileSystem.FileSystem, path: string) =>
  fileSystem.readFileString(path).pipe(
    Effect.map((content) =>
      content
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => decodeLine(line)),
    ),
  );

it.layer(NodeServices.layer)("appendAccessLog", (it) => {
  it.effect("writes owner-only JSONL stamped with the clock's time", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped();
      const logPath = path.join(root, "secret-monitor", "access.jsonl");

      yield* appendAccessLog({ path: logPath }, { event: "started" });
      yield* appendAccessLog(
        { path: logPath },
        {
          event: "unexpected-read",
          interface: "org.freedesktop.Secret.Service",
          member: "GetSecrets",
          sender: ":1.9",
          paths: ["/org/freedesktop/secrets/collection/login/3"],
          caller: {
            pid: 42,
            comm: "secret-tool",
            threadId: "thread-1",
            threadPid: 40,
            label: "T3 thread thread-1",
          },
        },
      );

      const lines = yield* readLines(fileSystem, logPath);
      expect(lines).toEqual([
        { at: "1970-01-01T00:00:00.000Z", event: "started" },
        {
          at: "1970-01-01T00:00:00.000Z",
          event: "unexpected-read",
          interface: "org.freedesktop.Secret.Service",
          member: "GetSecrets",
          sender: ":1.9",
          paths: ["/org/freedesktop/secrets/collection/login/3"],
          caller: {
            pid: 42,
            comm: "secret-tool",
            threadId: "thread-1",
            threadPid: 40,
            label: "T3 thread thread-1",
          },
        },
      ]);
      expect((yield* fileSystem.stat(logPath)).mode & 0o777).toBe(0o600);
      expect((yield* fileSystem.stat(path.dirname(logPath))).mode & 0o777).toBe(0o700);
    }),
  );

  it.effect("tightens a log file that predates the writer", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped();
      const logPath = path.join(root, "access.jsonl");
      yield* fileSystem.writeFileString(logPath, "", { mode: 0o644 });
      yield* fileSystem.chmod(logPath, 0o644);

      yield* appendAccessLog({ path: logPath }, { event: "started" });

      expect((yield* fileSystem.stat(logPath)).mode & 0o777).toBe(0o600);
    }),
  );

  it.effect("tightens a log directory that predates the writer", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped();
      const directory = path.join(root, "secret-monitor");
      yield* fileSystem.makeDirectory(directory);
      yield* fileSystem.chmod(directory, 0o755);

      yield* appendAccessLog({ path: path.join(directory, "access.jsonl") }, { event: "started" });

      expect((yield* fileSystem.stat(directory)).mode & 0o777).toBe(0o700);
    }),
  );

  it.effect("refuses a symlink at the log path and leaves its target untouched", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped();
      const target = path.join(root, "victim");
      const logPath = path.join(root, "access.jsonl");
      yield* fileSystem.writeFileString(target, "original\n");
      yield* fileSystem.chmod(target, 0o644);
      yield* fileSystem.symlink(target, logPath);

      const error = yield* appendAccessLog({ path: logPath }, { event: "started" }).pipe(
        Effect.flip,
      );

      expect(error._tag).toBe("AccessLogUnavailable");
      expect(yield* fileSystem.readFileString(target)).toBe("original\n");
      expect((yield* fileSystem.stat(target)).mode & 0o777).toBe(0o644);
    }),
  );

  it.effect("rotates before the file passes its bound, keeping one previous file", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped();
      const logPath = path.join(root, "access.jsonl");
      const errorLineBytes = '{"at":"1970-01-01T00:00:00.000Z","event":"error","detail":"d3"}\n'
        .length;
      const options = { path: logPath, maxBytes: errorLineBytes * 2 };

      yield* appendAccessLog(options, { event: "started" });
      yield* appendAccessLog(options, { event: "started" });
      expect(yield* fileSystem.exists(rotatedLogPath(logPath))).toBe(false);

      yield* appendAccessLog(options, { event: "error", detail: "d3" });
      expect(yield* readLines(fileSystem, rotatedLogPath(logPath))).toHaveLength(2);
      expect(yield* readLines(fileSystem, logPath)).toEqual([
        { at: "1970-01-01T00:00:00.000Z", event: "error", detail: "d3" },
      ]);

      yield* appendAccessLog(options, { event: "error", detail: "d4" });
      yield* appendAccessLog(options, { event: "error", detail: "d5" });
      const previous = yield* readLines(fileSystem, rotatedLogPath(logPath));
      expect(previous.map((line) => line.detail)).toEqual(["d3", "d4"]);
      expect((yield* readLines(fileSystem, logPath)).map((line) => line.detail)).toEqual(["d5"]);
      for (const file of [logPath, rotatedLogPath(logPath)]) {
        expect(Number((yield* fileSystem.stat(file)).size)).toBeLessThanOrEqual(options.maxBytes);
      }
    }),
  );
});
