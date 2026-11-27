// @effect-diagnostics nodeBuiltinImport:off - O_NOFOLLOW and fchmod have no Effect FileSystem equivalent.
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";

import { CallerIdentity } from "./callerIdentity.ts";

/** One rotation step past this size; at most two files of this size exist on disk. */
const DEFAULT_MAX_LOG_BYTES = 10 * 1024 * 1024;

export const AccessLogEvent = Schema.Literals([
  "started",
  /** A Secret Service call other than session plumbing or GetSecrets. */
  "call",
  /** GetSecrets on a quiet item: logged, never notified. */
  "quiet-read",
  /** GetSecrets on anything else: logged and notified. */
  "unexpected-read",
  /** Audit calls the monitor could not keep up with; `dropped` says how many. */
  "dropped",
  "error",
]);
export type AccessLogEvent = typeof AccessLogEvent.Type;

export const AccessLogEntry = Schema.Struct({
  event: AccessLogEvent,
  interface: Schema.optional(Schema.String),
  member: Schema.optional(Schema.String),
  sender: Schema.optional(Schema.String),
  paths: Schema.optional(Schema.Array(Schema.String)),
  caller: Schema.optional(CallerIdentity),
  detail: Schema.optional(Schema.String),
  dropped: Schema.optional(Schema.Number),
});
export type AccessLogEntry = typeof AccessLogEntry.Type;

/** One JSONL line: the entry stamped with the time it was written. */
export const AccessLogLine = Schema.Struct({ at: Schema.String, ...AccessLogEntry.fields });
export type AccessLogLine = typeof AccessLogLine.Type;

const encodeLine = Schema.encodeEffect(Schema.fromJsonString(AccessLogLine));

export interface AccessLogOptions {
  readonly path: string;
  readonly maxBytes?: number | undefined;
}

export class AccessLogUnavailable extends Schema.TaggedError<AccessLogUnavailable>()(
  "AccessLogUnavailable",
  { path: Schema.String, reason: Schema.String },
) {}

export const rotatedLogPath = (path: string): string => `${path}.1`;

// O_NOFOLLOW refuses a symlink planted at the log path, so the log cannot be redirected into
// another file.
const LOG_OPEN_FLAGS =
  NodeFS.constants.O_WRONLY |
  NodeFS.constants.O_APPEND |
  NodeFS.constants.O_CREAT |
  NodeFS.constants.O_NOFOLLOW;

const logFailure = (path: string) => (error: unknown) =>
  new AccessLogUnavailable({
    path,
    reason: error instanceof Error ? error.message : String(error),
  });

const withLogFile = <A>(path: string, use: (file: NodeFSP.FileHandle) => Promise<A>) =>
  Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => NodeFSP.open(path, LOG_OPEN_FLAGS, 0o600),
      catch: logFailure(path),
    }),
    (file) => Effect.tryPromise({ try: () => use(file), catch: logFailure(path) }),
    (file) => Effect.promise(() => file.close().catch(() => undefined)),
  );

/**
 * Appends one JSON line. The file and its directory are owner-only: the log names which
 * processes read which keyring items. Before the file passes `maxBytes` it moves to `<path>.1`,
 * replacing the previous rotation.
 */
export const appendAccessLog = Effect.fn("SecretMonitor.appendAccessLog")(function* (
  options: AccessLogOptions,
  entry: AccessLogEntry,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_LOG_BYTES;
  const at = DateTime.formatIso(yield* DateTime.now);
  const line = `${yield* encodeLine({ at, ...entry })}\n`;
  const directory = path.dirname(options.path);

  yield* fileSystem.makeDirectory(directory, { recursive: true, mode: 0o700 });
  // `mode` applies only when the directory is created; tighten one that already existed.
  yield* fileSystem.chmod(directory, 0o700);
  const size = yield* withLogFile(options.path, async (file) => (await file.stat()).size);
  if (size > 0 && size + Buffer.byteLength(line) > maxBytes) {
    yield* fileSystem.rename(options.path, rotatedLogPath(options.path));
  }
  yield* withLogFile(options.path, async (file) => {
    // The open mode applies only on creation; fchmod tightens a file that predates this writer.
    await file.chmod(0o600);
    await file.write(line);
  });
});
