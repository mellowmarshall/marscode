import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const isNativeSessionId = Schema.is(Schema.String.check(Schema.isUUID(4)));
const decodeSessionMetadata = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ cwd: Schema.String })),
);

const CORTEX_STEP_STATUS_PENDING = 1;
const CORTEX_STEP_STATUS_RUNNING = 2;
const CORTEX_STEP_STATUS_CANCELED = 6;
const CORTEX_STEP_STATUS_GENERATING = 8;
const CORTEX_STEP_STATUS_WAITING = 9;
const CORTEX_STEP_STATUS_QUEUED = 11;
const CORTEX_STEP_STATUS_FIELD_NUMBER = 4;

const NON_TERMINAL_STEP_STATUSES: ReadonlySet<bigint> = new Set([
  BigInt(CORTEX_STEP_STATUS_PENDING),
  BigInt(CORTEX_STEP_STATUS_RUNNING),
  BigInt(CORTEX_STEP_STATUS_GENERATING),
  BigInt(CORTEX_STEP_STATUS_WAITING),
  BigInt(CORTEX_STEP_STATUS_QUEUED),
]);

function readVarint(
  bytes: Uint8Array,
  startOffset: number,
): { readonly value: bigint; readonly nextOffset: number } | undefined {
  let value = 0n;
  let offset = startOffset;
  for (let shift = 0n; shift < 70n; shift += 7n) {
    const byte = bytes[offset++];
    if (byte === undefined || (shift === 63n && byte > 1)) {
      return undefined;
    }
    value |= BigInt(byte & 127) << shift;
    if (byte < 128) {
      return { value, nextOffset: offset };
    }
  }
  return undefined;
}

function encodeVarint(value: bigint): Uint8Array {
  const out: Array<number> = [];
  let remaining = value;
  while (remaining >= 128n) {
    out.push(Number(remaining & 127n) | 128);
    remaining >>= 7n;
  }
  out.push(Number(remaining));
  return Uint8Array.from(out);
}

/**
 * Rewrites top-level `CortexStep.status` (field 4, wire type 0) from
 * `CORTEX_STEP_STATUS_RUNNING` (2) to `CORTEX_STEP_STATUS_CANCELED` (6)
 * so `localharness_external`'s `agent_state_rehydrator` does not rehydrate
 * orphaned running steps as permanent background tasks when resuming a session.
 */
export function rewriteAntigravityStepPayloadRunningStatus(
  bytes: Uint8Array,
  nextStatus = CORTEX_STEP_STATUS_CANCELED,
): { readonly payload: Uint8Array; readonly changed: boolean } {
  const chunks: Array<Uint8Array> = [];
  let offset = 0;
  let changed = false;

  while (offset < bytes.length) {
    const fieldStart = offset;
    const tagVarint = readVarint(bytes, offset);
    if (tagVarint === undefined) {
      return { payload: bytes, changed: false };
    }
    offset = tagVarint.nextOffset;
    const fieldNumber = Number(tagVarint.value >> 3n);
    const wireType = Number(tagVarint.value & 7n);
    if (fieldNumber === 0) {
      return { payload: bytes, changed: false };
    }

    if (wireType === 0) {
      const valueStart = offset;
      const valueVarint = readVarint(bytes, offset);
      if (valueVarint === undefined) {
        return { payload: bytes, changed: false };
      }
      offset = valueVarint.nextOffset;
      if (
        fieldNumber === CORTEX_STEP_STATUS_FIELD_NUMBER &&
        NON_TERMINAL_STEP_STATUSES.has(valueVarint.value)
      ) {
        chunks.push(bytes.subarray(fieldStart, valueStart));
        chunks.push(encodeVarint(BigInt(nextStatus)));
        changed = true;
      } else {
        chunks.push(bytes.subarray(fieldStart, offset));
      }
      continue;
    }

    if (wireType === 1) {
      if (offset + 8 > bytes.length) {
        return { payload: bytes, changed: false };
      }
      offset += 8;
      chunks.push(bytes.subarray(fieldStart, offset));
      continue;
    }

    if (wireType === 2) {
      const lengthVarint = readVarint(bytes, offset);
      if (
        lengthVarint === undefined ||
        lengthVarint.value > BigInt(bytes.length - lengthVarint.nextOffset)
      ) {
        return { payload: bytes, changed: false };
      }
      offset = lengthVarint.nextOffset + Number(lengthVarint.value);
      chunks.push(bytes.subarray(fieldStart, offset));
      continue;
    }

    if (wireType === 5) {
      if (offset + 4 > bytes.length) {
        return { payload: bytes, changed: false };
      }
      offset += 4;
      chunks.push(bytes.subarray(fieldStart, offset));
      continue;
    }

    return { payload: bytes, changed: false };
  }

  if (!changed) {
    return { payload: bytes, changed: false };
  }
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const rewritten = new Uint8Array(totalLength);
  let writeOffset = 0;
  for (const chunk of chunks) {
    rewritten.set(chunk, writeOffset);
    writeOffset += chunk.byteLength;
  }
  return { payload: rewritten, changed: true };
}

/**
 * Cancels orphaned `status = 2` (`CORTEX_STEP_STATUS_RUNNING`) steps in an
 * Antigravity conversation database before a fresh runtime opens the session.
 */
export const sanitizeAntigravityConversationDb = Effect.fn("sanitizeAntigravityConversationDb")(
  function* (input: { readonly profileDirectory: string; readonly sessionId: string | undefined }) {
    if (input.sessionId === undefined || !isNativeSessionId(input.sessionId)) {
      return;
    }
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dbPath = path.join(
      input.profileDirectory,
      "antigravity-acp",
      "conversations",
      `${input.sessionId}.db`,
    );
    if (!(yield* fs.exists(dbPath))) {
      return;
    }
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.unsafe("PRAGMA busy_timeout = 500");
      yield* Effect.gen(function* () {
        const tables = yield* sql.unsafe<{ readonly name: unknown }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'steps'",
        );
        if (tables.length === 0) {
          return;
        }
        const rows = yield* sql.unsafe<{
          readonly idx: unknown;
          readonly status: unknown;
          readonly step_payload: unknown;
        }>(
          "SELECT idx, status, step_payload FROM steps WHERE status IN (?, ?, ?, ?, ?, ?)",
          [
            CORTEX_STEP_STATUS_PENDING,
            CORTEX_STEP_STATUS_RUNNING,
            CORTEX_STEP_STATUS_CANCELED,
            CORTEX_STEP_STATUS_GENERATING,
            CORTEX_STEP_STATUS_WAITING,
            CORTEX_STEP_STATUS_QUEUED,
          ],
        );
        for (const row of rows) {
          if (typeof row.idx !== "number") {
            continue;
          }
          if (row.step_payload instanceof Uint8Array) {
            const { payload, changed } = rewriteAntigravityStepPayloadRunningStatus(
              row.step_payload,
              CORTEX_STEP_STATUS_CANCELED,
            );
            if (row.status !== CORTEX_STEP_STATUS_CANCELED || changed) {
              yield* sql.unsafe("UPDATE steps SET status = ?, step_payload = ? WHERE idx = ?", [
                CORTEX_STEP_STATUS_CANCELED,
                payload,
                row.idx,
              ]);
            }
          } else if (row.status !== CORTEX_STEP_STATUS_CANCELED) {
            yield* sql.unsafe("UPDATE steps SET status = ? WHERE idx = ?", [
              CORTEX_STEP_STATUS_CANCELED,
              row.idx,
            ]);
          }
        }
      }).pipe(sql.withTransaction);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })), Effect.scoped);
  },
  Effect.catchCause((cause) =>
    Effect.logWarning("Could not sanitize Antigravity conversation database.", { cause }),
  ),
);

/** Call after the process closes. The unique temporary cwd proves which session we own. */
export const removeAntigravitySessionFiles = Effect.fn("removeAntigravitySessionFiles")(
  function* (input: {
    readonly profileDirectory: string;
    readonly sessionId: string | undefined;
    readonly cwd: string;
  }) {
    if (input.sessionId === undefined || !isNativeSessionId(input.sessionId)) {
      return;
    }
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const acpDirectory = path.join(input.profileDirectory, "antigravity-acp");
    const base = path.join(acpDirectory, "conversations", input.sessionId);
    if (!(yield* fs.exists(`${base}.meta`))) {
      return;
    }
    const metadata = yield* fs
      .readFileString(`${base}.meta`)
      .pipe(Effect.flatMap(decodeSessionMetadata));
    if (metadata.cwd !== input.cwd) {
      return;
    }
    for (const suffix of [".db", ".db-wal", ".db-shm", ".db-journal", ".meta"]) {
      yield* fs.remove(`${base}${suffix}`, { force: true });
    }
    yield* fs.remove(path.join(acpDirectory, "brain", input.sessionId), {
      recursive: true,
      force: true,
    });
  },
  Effect.catch(() => Effect.logWarning("Could not remove temporary Antigravity session files.")),
);

/** Sweep only private runtimes before launch; Windows does not protect live extracted data files from deletion. */
export const removeAntigravityRuntimeTempDirs = Effect.fn("removeAntigravityRuntimeTempDirs")(
  function* (tempDirectory: string) {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.remove(tempDirectory, { recursive: true, force: true });
  },
  Effect.catch(() =>
    Effect.logWarning("Could not remove leftover Antigravity runtime temp files."),
  ),
);
