// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect FileSystem lacks fstat ownership checks and bounded offset reads.
import * as NodeFSP from "node:fs/promises";
import {
  CernoGitConflict,
  CernoLiveRun,
  CernoResourceKill,
  CernoRunOutcome,
  CernoRunState,
  type CernoLiveRunsResult,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  CERNO_SAFE_READ_FLAGS,
  isSensitiveCernoLogPath,
  readLinuxProcStartTicksPromise,
  readLinuxProcThreadIdPromise,
} from "./cernoProcGuard.ts";

const MAX_SNAPSHOT_BYTES = 16_384;
const DEFAULT_MAX_LOG_TAIL_BYTES = 8_192;
const MAX_SNAPSHOT_FILES = 64;
const MAX_SCAN_ENTRIES = 512;
const MAX_COMMAND_CHARS = 400;
const MAX_TAIL_CHARS = 300;
const STALE_SNAPSHOT_MS = 30_000;
const LIST_RUNS_TIMEOUT = Duration.seconds(2);

const SAFE_READ_FLAGS = CERNO_SAFE_READ_FLAGS;

const Probability = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }));

const RawCernoSnapshot = Schema.Struct({
  schema_version: Schema.Number,
  pid: Schema.Number,
  child_pid: Schema.Number,
  proc_start_ticks: Schema.optionalKey(Schema.Number),
  started_at_ms: Schema.Number,
  updated_at_ms: Schema.Number,
  elapsed_sec: Schema.Number,
  mode: Schema.String,
  engine: Schema.String,
  cwd: Schema.String,
  command: Schema.String,
  log_path: Schema.NullOr(Schema.String),
  state: CernoRunState,
  confidence: Probability,
  margin: Schema.Number,
  state_probs: Schema.Struct({
    RUNNING: Probability,
    SUCCEEDED: Probability,
    FAILED: Probability,
    NEEDS_INPUT: Probability,
    STUCK_LOOP: Probability,
  }),
  outcome: CernoRunOutcome,
  p_fail: Probability,
  fail_margin: Schema.Number,
  cutoffs: Schema.Struct({
    susp_thresh: Probability,
    susp_margin: Schema.Number,
    conf_thresh: Probability,
    conf_margin: Schema.Number,
  }),
  prompt: Schema.Boolean,
  hang_loop: Schema.Boolean,
  server_ready: Schema.Boolean,
  auth_required: Schema.Boolean,
  resource_kill: CernoResourceKill,
  git_conflict: CernoGitConflict,
  wchan: Schema.String,
  cpu_active: Schema.Boolean,
  has_remote_socket: Schema.Boolean,
  has_listen_socket: Schema.Boolean,
  has_ext_file_lock: Schema.Boolean,
  silence_sec: Schema.Number,
  stall_timeout_sec: Schema.Number,
  bytes_stdout: Schema.Number,
  bytes_stderr: Schema.Number,
  alert: Schema.NullOr(Schema.String),
  tail: Schema.String,
});

const decodeRawSnapshotJson = Schema.decodeUnknownEffect(Schema.fromJsonString(RawCernoSnapshot));
const decodeLiveRun = Schema.decodeUnknownEffect(CernoLiveRun);

class CernoSnapshotReadError extends Schema.TaggedError<CernoSnapshotReadError>()(
  "CernoSnapshotReadError",
  {
    operation: Schema.Literals(["readdir", "read", "tail"]),
    cause: Schema.Defect(),
  },
) {}

export interface CernoRunServiceOptions {
  readonly snapshotDirs?: ReadonlyArray<string>;
  readonly isPidAlive?: (pid: number) => boolean;
  readonly readProcStartTicks?: (pid: number) => Promise<number | null>;
  readonly readProcThreadId?: (pid: number) => Promise<string | null>;
  readonly expectedUid?: number | null;
  readonly nowMs?: () => number;
  readonly maxLogTailBytes?: number;
}

export class CernoRunService extends Context.Service<
  CernoRunService,
  {
    readonly listRuns: Effect.Effect<CernoLiveRunsResult>;
  }
>()("t3/cerno/CernoRunService") {}

function defaultIsPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function defaultSnapshotDirs(path: Path.Path): ReadonlyArray<string> {
  const dirs: string[] = [];
  const xdg = process.env.XDG_RUNTIME_DIR?.trim();
  if (xdg && xdg.startsWith("/")) {
    dirs.push(path.join(xdg, "cerno"));
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (uid !== null) {
    dirs.push(`/tmp/cerno-${uid}`);
  }
  return dirs;
}

function clampText(value: string, maxChars: number): string {
  return value.length > maxChars ? value.slice(0, maxChars) : value;
}

function readLogTailPromise(
  logPath: string,
  uid: number | null,
  maxBytes: number,
  path: Path.Path,
): Promise<string | undefined> {
  return (async () => {
    if (isSensitiveCernoLogPath(logPath)) return undefined;
    const parentReal = await NodeFSP.realpath(path.dirname(logPath)).catch(() => null);
    if (
      parentReal !== null &&
      isSensitiveCernoLogPath(path.join(parentReal, path.basename(logPath)))
    ) {
      return undefined;
    }
    const handle = await NodeFSP.open(logPath, SAFE_READ_FLAGS);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size <= 0) return undefined;
      if (uid !== null && stat.uid !== uid) return undefined;
      const length = Math.min(stat.size, maxBytes);
      const offset = stat.size - length;
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      if (bytesRead <= 0) return undefined;
      let text = buffer.subarray(0, bytesRead).toString("utf8");
      if (offset > 0) {
        const firstNewline = text.indexOf("\n");
        if (firstNewline >= 0 && firstNewline + 1 < text.length) {
          text = text.slice(firstNewline + 1);
        }
      }
      return text;
    } finally {
      await handle.close();
    }
  })();
}

function readSnapshotFilePromise(filePath: string, uid: number | null): Promise<string | null> {
  return (async () => {
    const handle = await NodeFSP.open(filePath, SAFE_READ_FLAGS);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_SNAPSHOT_BYTES) return null;
      if (uid !== null && stat.uid !== uid) return null;
      const buffer = Buffer.alloc(MAX_SNAPSHOT_BYTES + 1);
      const { bytesRead } = await handle.read(buffer, 0, MAX_SNAPSHOT_BYTES + 1, 0);
      if (bytesRead <= 0 || bytesRead > MAX_SNAPSHOT_BYTES) return null;
      return buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
  })();
}

function listCandidateFilesPromise(
  dirPath: string,
  uid: number | null,
  path: Path.Path,
): Promise<ReadonlyArray<string>> {
  return (async () => {
    const stat = await NodeFSP.lstat(dirPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return [];
    if (uid !== null && (stat.uid !== uid || (stat.mode & 0o077) !== 0)) return [];
    const entries = await NodeFSP.readdir(dirPath);
    const matches = entries.filter((name) => /^\d+\.json$/u.test(name)).slice(0, MAX_SCAN_ENTRIES);
    const ranked: Array<{ readonly filePath: string; readonly mtimeMs: number }> = [];
    for (const name of matches) {
      const filePath = path.join(dirPath, name);
      const entryStat = await NodeFSP.lstat(filePath).catch(() => null);
      if (!entryStat || !entryStat.isFile()) continue;
      if (entryStat.size <= 0 || entryStat.size > MAX_SNAPSHOT_BYTES) continue;
      if (uid !== null && entryStat.uid !== uid) continue;
      ranked.push({ filePath, mtimeMs: entryStat.mtimeMs });
    }
    ranked.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return ranked.slice(0, MAX_SNAPSHOT_FILES).map((entry) => entry.filePath);
  })();
}

export const layerWithOptions = (options: CernoRunServiceOptions = {}) =>
  Layer.effect(
    CernoRunService,
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
      const readProcStartTicks = options.readProcStartTicks ?? readLinuxProcStartTicksPromise;
      const maxLogTailBytes = options.maxLogTailBytes ?? DEFAULT_MAX_LOG_TAIL_BYTES;
      const uid =
        options.expectedUid !== undefined
          ? options.expectedUid
          : typeof process.getuid === "function"
            ? process.getuid()
            : null;
      const readProcThreadId =
        options.readProcThreadId ?? ((pid: number) => readLinuxProcThreadIdPromise(pid, uid));

      // Per-file helper shares the enclosing listRuns span to avoid per-snapshot trace noise.
      const readOneSnapshot = Effect.fnUntraced(function* (
        filePath: string,
        sampledAt: number,
        onReadError: () => void,
      ) {
        const rawText = yield* Effect.tryPromise({
          try: () => readSnapshotFilePromise(filePath, uid),
          catch: (cause) => new CernoSnapshotReadError({ operation: "read", cause }),
        }).pipe(
          Effect.catchTags({
            CernoSnapshotReadError: () => {
              onReadError();
              return Effect.succeed(null);
            },
          }),
        );
        if (!rawText) return null;

        const raw = yield* decodeRawSnapshotJson(rawText).pipe(Effect.orElseSucceed(() => null));
        if (!raw || raw.schema_version !== 1) return null;
        if (!isPidAlive(raw.pid)) return null;
        if (raw.proc_start_ticks !== undefined && raw.proc_start_ticks > 0) {
          const liveTicks = yield* Effect.promise(() => readProcStartTicks(Math.trunc(raw.pid)));
          if (liveTicks === null || liveTicks !== Math.trunc(raw.proc_start_ticks)) {
            return null;
          }
        }
        if (sampledAt - raw.updated_at_ms > STALE_SNAPSHOT_MS) {
          return null;
        }

        const resolvedLogPath = (() => {
          const trimmed = raw.log_path?.trim();
          if (!trimmed) return null;
          if (trimmed.startsWith("/")) return path.resolve(trimmed);
          if (raw.cwd.startsWith("/")) return path.resolve(raw.cwd, trimmed);
          return null;
        })();

        const logTail = resolvedLogPath
          ? yield* Effect.tryPromise({
              try: () => readLogTailPromise(resolvedLogPath, uid, maxLogTailBytes, path),
              catch: (cause) => new CernoSnapshotReadError({ operation: "tail", cause }),
            }).pipe(
              Effect.catchTags({
                CernoSnapshotReadError: () => {
                  onReadError();
                  return Effect.undefined;
                },
              }),
            )
          : undefined;

        const canonicalLogPath = resolvedLogPath
          ? yield* Effect.promise(() =>
              NodeFSP.realpath(resolvedLogPath).catch(() => resolvedLogPath),
            )
          : null;

        const pidInt = Math.trunc(raw.pid);
        const childPidInt = Math.max(0, Math.trunc(raw.child_pid));
        let threadId = yield* Effect.promise(() => readProcThreadId(pidInt));
        if (!threadId && childPidInt > 0 && childPidInt !== pidInt) {
          threadId = yield* Effect.promise(() => readProcThreadId(childPidInt));
        }

        return yield* decodeLiveRun({
          schemaVersion: Math.trunc(raw.schema_version),
          pid: pidInt,
          childPid: childPidInt,
          startedAtMs: Math.max(0, Math.trunc(raw.started_at_ms)),
          updatedAtMs: Math.max(0, Math.trunc(raw.updated_at_ms)),
          elapsedSec: Math.max(0, raw.elapsed_sec),
          mode: clampText(raw.mode, 32),
          engine: clampText(raw.engine, 64),
          cwd: clampText(raw.cwd, 400),
          command: clampText(raw.command, MAX_COMMAND_CHARS),
          logPath: canonicalLogPath ? clampText(canonicalLogPath, 400) : null,
          state: raw.state,
          confidence: raw.confidence,
          margin: raw.margin,
          stateProbs: raw.state_probs,
          outcome: raw.outcome,
          pFail: raw.p_fail,
          failMargin: raw.fail_margin,
          cutoffs: {
            suspThresh: raw.cutoffs.susp_thresh,
            suspMargin: raw.cutoffs.susp_margin,
            confThresh: raw.cutoffs.conf_thresh,
            confMargin: raw.cutoffs.conf_margin,
          },
          prompt: raw.prompt,
          hangLoop: raw.hang_loop,
          serverReady: raw.server_ready,
          authRequired: raw.auth_required,
          resourceKill: raw.resource_kill,
          gitConflict: raw.git_conflict,
          wchan: clampText(raw.wchan, 64),
          cpuActive: raw.cpu_active,
          hasRemoteSocket: raw.has_remote_socket,
          hasListenSocket: raw.has_listen_socket,
          hasExtFileLock: raw.has_ext_file_lock,
          silenceSec: Math.max(0, raw.silence_sec),
          stallTimeoutSec: Math.max(0, raw.stall_timeout_sec),
          bytesStdout: Math.max(0, Math.trunc(raw.bytes_stdout)),
          bytesStderr: Math.max(0, Math.trunc(raw.bytes_stderr)),
          alert: raw.alert ? clampText(raw.alert, 64) : null,
          tail: clampText(raw.tail, MAX_TAIL_CHARS),
          ...(logTail !== undefined ? { logTail } : {}),
          ...(threadId ? { threadId } : {}),
        }).pipe(Effect.orElseSucceed(() => null));
      });

      const listRuns = Effect.fn("CernoRunService.listRuns")(function* () {
        const currentMs = options.nowMs ? options.nowMs() : yield* Clock.currentTimeMillis;
        const sampledAt = Math.max(0, Math.trunc(currentMs));
        const dirs = options.snapshotDirs ?? defaultSnapshotDirs(path);
        let readErrors = 0;
        const onReadError = () => {
          readErrors += 1;
        };

        const scanEffect = Effect.gen(function* () {
          const byPid = new Map<number, CernoLiveRun>();

          for (const dir of dirs) {
            const files = yield* Effect.tryPromise({
              try: () => listCandidateFilesPromise(dir, uid, path),
              catch: (cause) => new CernoSnapshotReadError({ operation: "readdir", cause }),
            }).pipe(
              Effect.catchTags({
                CernoSnapshotReadError: () => {
                  onReadError();
                  return Effect.succeed([] as ReadonlyArray<string>);
                },
              }),
            );
            for (const filePath of files) {
              const run = yield* readOneSnapshot(filePath, sampledAt, onReadError);
              if (!run) continue;
              const prev = byPid.get(run.pid);
              if (!prev || run.updatedAtMs > prev.updatedAtMs) {
                byPid.set(run.pid, run);
              }
            }
          }

          return [...byPid.values()].toSorted((a, b) => b.startedAtMs - a.startedAtMs);
        });

        const timed = yield* Effect.timeoutOption(scanEffect, LIST_RUNS_TIMEOUT);
        if (Option.isNone(timed)) {
          yield* Effect.annotateCurrentSpan({
            "cerno.timedOut": true,
            "cerno.readErrors": readErrors,
          });
          return { sampledAt, runs: [] };
        }
        const runs = timed.value;
        yield* Effect.annotateCurrentSpan({
          "cerno.runCount": runs.length,
          "cerno.readErrors": readErrors,
        });
        return { sampledAt, runs };
      });

      return CernoRunService.of({
        listRuns: listRuns(),
      });
    }),
  );

export const layer = layerWithOptions();
