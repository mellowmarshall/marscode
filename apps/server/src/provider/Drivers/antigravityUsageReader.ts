// @effect-diagnostics-next-line nodeBuiltinImport:off - Needs ctime for cache fingerprints and dirent types to avoid per-entry syscalls.
import * as NodeFSP from "node:fs/promises";
import { pipe } from "effect/Function";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import {
  type AntigravityMetadata,
  buildAntigravityCandidates,
  decodeAntigravityMetadata,
  decodeProtoFields,
  dedupeSingleDbCandidates,
  isConcreteAntigravityModel,
  protoNested,
  protoTimestamp,
  rememberAntigravityModel,
} from "./antigravityProtobuf.ts";
import { type AntigravityActiveFile, resolveAntigravityFiles } from "./antigravityUsageResolver.ts";

function blob(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new Error("Invalid Antigravity metadata blob");
  return value;
}

class AntigravityDatabaseDecodeError extends Schema.TaggedError<AntigravityDatabaseDecodeError>()(
  "AntigravityDatabaseDecodeError",
  { path: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return `Antigravity usage could not be decoded from ${this.path}.`;
  }
}

const GENERATION_PAGE_ROWS = 64;
const STEP_PAGE_ROWS = 256;
const METADATA_PAGE_MAX_BYTES = 256 * 1024;
const STAT_CONCURRENCY = 16;
const READ_CONCURRENCY = 1;

const readDatabase = Effect.fn("readDatabase")(function* (
  path: string,
  sessionId: string,
  fallbackTimestamp: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const decode = <A>(evaluate: () => A) =>
    Effect.try({
      try: evaluate,
      catch: (cause) => new AntigravityDatabaseDecodeError({ path, cause }),
    });
  yield* sql.unsafe("PRAGMA busy_timeout = 100");
  return yield* Effect.gen(function* () {
    const tables = new Set(
      (yield* sql.unsafe<{ readonly name: unknown }>(
        "SELECT name FROM sqlite_master WHERE type = 'table'",
      )).map((row) => row.name),
    );
    // Not a conversation store, e.g. agy's conversation_summaries.db index.
    if (!tables.has("gen_metadata") && !tables.has("steps")) return null;
    // Batch small rows by byte budget while isolating multi-MB blobs to single-row fetches.
    const readMetadata = Effect.fnUntraced(function* (
      sizeQuery: string,
      rangeQuery: string,
      pageRows: number,
      step: boolean,
    ) {
      const entries: Array<{ idx: number; entry: AntigravityMetadata }> = [];
      let after = -Infinity;
      while (true) {
        const meta = yield* sql
          .unsafe<{ readonly row_id: number; readonly byte_len: unknown }>(sizeQuery, [
            after,
            pageRows,
          ])
          .pipe(Effect.withTracerEnabled(false));
        if (meta.length === 0) break;
        const lastRowId = meta[meta.length - 1]!.row_id;
        const more = meta.length === pageRows;
        let offset = 0;
        while (offset < meta.length) {
          if (step && meta[offset]!.byte_len === null) {
            offset++;
            continue;
          }
          const startRowId = meta[offset]!.row_id;
          let bytes =
            typeof meta[offset]!.byte_len === "number" ? (meta[offset]!.byte_len as number) : 0;
          let endIdx = offset;
          while (endIdx + 1 < meta.length) {
            const nextLen = meta[endIdx + 1]!.byte_len;
            if (step && nextLen === null) break;
            const add = typeof nextLen === "number" ? nextLen : 0;
            if (bytes + add > METADATA_PAGE_MAX_BYTES) break;
            bytes += add;
            endIdx++;
          }
          const endRowId = meta[endIdx]!.row_id;
          offset = endIdx + 1;
          {
            const rows = yield* sql
              .unsafe<{ readonly idx: unknown; readonly data: unknown }>(rangeQuery, [
                startRowId,
                endRowId,
              ])
              .pipe(Effect.withTracerEnabled(false));
            for (const row of rows) {
              if (step && row.data === null) continue;
              const idx = row.idx;
              if (typeof idx !== "number") {
                return yield* new AntigravityDatabaseDecodeError({ path });
              }
              entries.push({
                idx,
                entry: yield* decode(() => decodeAntigravityMetadata(blob(row.data), step)),
              });
            }
          }
          yield* Effect.yieldNow;
        }
        if (!more) break;
        after = lastRowId;
      }
      return entries.sort((a, b) => a.idx - b.idx);
    });
    const generations = tables.has("gen_metadata")
      ? yield* readMetadata(
          "SELECT rowid AS row_id, LENGTH(data) AS byte_len FROM gen_metadata WHERE rowid > ? ORDER BY rowid LIMIT ?",
          "SELECT idx, data FROM gen_metadata WHERE rowid >= ? AND rowid <= ? ORDER BY rowid",
          GENERATION_PAGE_ROWS,
          false,
        )
      : [];
    let trajectoryTimestamp: number | null = null;
    if (tables.has("trajectory_metadata_blob")) {
      for (const row of yield* sql.unsafe<{ readonly data: unknown }>(
        "SELECT data FROM trajectory_metadata_blob",
      )) {
        trajectoryTimestamp ??= yield* decode(() =>
          pipe(blob(row.data), decodeProtoFields, (msg) => protoNested(msg, 2), protoTimestamp),
        );
      }
    }
    const steps = tables.has("steps")
      ? yield* readMetadata(
          "SELECT rowid AS row_id, LENGTH(metadata) AS byte_len FROM steps WHERE rowid > ? ORDER BY rowid LIMIT ?",
          "SELECT idx, metadata AS data FROM steps WHERE rowid >= ? AND rowid <= ? ORDER BY rowid",
          STEP_PAGE_ROWS,
          true,
        )
      : [];
    return yield* decode(() => {
      const models = new Map<number, string | null>();
      for (const { entry } of [...generations, ...steps]) {
        if (entry.modelId > 0 && isConcreteAntigravityModel(entry.model)) {
          rememberAntigravityModel(models, entry.modelId, entry.model);
        }
      }
      const candidates = dedupeSingleDbCandidates(
        buildAntigravityCandidates(
          sessionId,
          generations,
          steps,
          trajectoryTimestamp,
          fallbackTimestamp,
        ),
      );
      return { candidates, models };
    });
  }).pipe(sql.withTransaction);
});

interface CachedDatabase {
  readonly fingerprint: string;
  readonly data: Effect.Success<ReturnType<typeof readDatabase>>;
}

interface DiscoveredFile {
  readonly root: string;
  readonly path: string;
  readonly canonical: string;
  readonly hasWal: boolean;
}

/** Fingerprint canonical DB/WAL paths by size, mtime and ctime; WAL holds new rows, and ctime catches restored mtimes. */
export const makeAntigravityUsageCache = () => new Map<string, CachedDatabase>();

function statPart(file: string) {
  return Effect.tryPromise({
    try: () => NodeFSP.stat(file),
    catch: (cause) => new AntigravityDatabaseDecodeError({ path: file, cause }),
  }).pipe(Effect.map((stat) => ({ stat, part: `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}` })));
}

export const readAntigravityUsage = Effect.fn("readAntigravityUsage")(function* (
  conversationsDirectories: string | readonly string[],
  sinceMs: number,
  cache?: Map<string, CachedDatabase>,
) {
  const pathService = yield* Path.Path;
  const roots =
    typeof conversationsDirectories === "string"
      ? [conversationsDirectories]
      : conversationsDirectories;
  const errors: string[] = [];
  const discovered: DiscoveredFile[] = [];
  const visited = new Set<string>();

  const walk = Effect.fn("antigravityUsageReader.walk")(function* (
    directory: string,
    root: string,
  ): Effect.fn.Return<void> {
    const entries = yield* Effect.tryPromise({
      try: () => NodeFSP.readdir(directory, { withFileTypes: true }),
      catch: (cause) => ({
        notFound: (cause as NodeJS.ErrnoException)?.code === "ENOENT",
      }),
    }).pipe(
      Effect.catch(({ notFound }) => {
        if (!notFound) errors.push(directory);
        return Effect.succeed(null);
      }),
    );
    if (entries === null) return;
    entries.sort((a, b) => a.name.localeCompare(b.name));
    const resolvedDir = yield* Effect.tryPromise({
      try: () => NodeFSP.realpath(directory),
      catch: () => directory,
    }).pipe(Effect.orElseSucceed(() => directory));
    const entryNames = new Set(entries.map((entry) => entry.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const entryPath = pathService.join(directory, entry.name);
      let kind: "dir" | "file" | "other";
      if (entry.isDirectory()) {
        kind = "dir";
      } else if (entry.isFile()) {
        kind = "file";
      } else {
        // Fallback for filesystems that return DT_UNKNOWN.
        kind = yield* Effect.tryPromise({
          try: () => NodeFSP.lstat(entryPath),
          catch: () => null,
        }).pipe(
          Effect.map((st) =>
            st.isSymbolicLink()
              ? "other"
              : st.isDirectory()
                ? "dir"
                : st.isFile()
                  ? "file"
                  : "other",
          ),
          Effect.orElseSucceed(() => (entry.name.endsWith(".db") ? "file" : "other")),
        );
      }
      if (kind === "dir") {
        yield* walk(entryPath, root);
      } else if (kind === "file" && entry.name.endsWith(".db")) {
        const canonical = pathService.join(resolvedDir, entry.name);
        if (visited.has(canonical)) continue;
        visited.add(canonical);
        discovered.push({
          root,
          path: entryPath,
          canonical,
          hasWal: entryNames.has(`${entry.name}-wal`),
        });
      }
    }
  });

  for (const root of roots) yield* walk(root, root);
  if (cache !== undefined) {
    for (const key of cache.keys()) if (!visited.has(key)) cache.delete(key);
  }

  const fingerprinted = yield* Effect.forEach(
    discovered,
    (entry) =>
      Effect.gen(function* () {
        const main = yield* statPart(entry.path);
        const wal = entry.hasWal ? yield* statPart(`${entry.path}-wal`).pipe(Effect.option) : null;
        const fingerprint = `${main.part}/${wal?._tag === "Some" ? wal.value.part : "-"}`;
        const cached = cache?.get(entry.canonical);
        if (cached?.fingerprint === fingerprint) {
          return { kind: "hit" as const, entry, fingerprint, data: cached.data };
        }
        return { kind: "miss" as const, entry, fingerprint, mtimeMs: main.stat.mtimeMs };
      }).pipe(Effect.orElseSucceed(() => ({ kind: "error" as const, entry }))),
    { concurrency: STAT_CONCURRENCY },
  );

  const misses = fingerprinted.filter(
    (item): item is Extract<typeof item, { kind: "miss" }> => item.kind === "miss",
  );
  const readResults = new Map<string, { ok: true; data: CachedDatabase["data"] } | { ok: false }>();
  yield* Effect.forEach(
    misses,
    (miss) =>
      readDatabase(
        miss.entry.path,
        pathService.basename(miss.entry.path, ".db"),
        miss.mtimeMs,
      ).pipe(
        Effect.provide(NodeSqliteClient.layer({ filename: miss.entry.path, readonly: true })),
        Effect.tap((data) =>
          Effect.sync(() => {
            cache?.set(miss.entry.canonical, { fingerprint: miss.fingerprint, data });
            readResults.set(miss.entry.canonical, { ok: true, data });
          }),
        ),
        Effect.catch(() =>
          Effect.sync(() => {
            readResults.set(miss.entry.canonical, { ok: false });
          }),
        ),
      ),
    { concurrency: READ_CONCURRENCY },
  );

  const activeFiles: AntigravityActiveFile[] = [];
  for (const item of fingerprinted) {
    if (item.kind === "error") {
      errors.push(item.entry.path);
      continue;
    }
    const data =
      item.kind === "hit"
        ? item.data
        : (() => {
            const result = readResults.get(item.entry.canonical);
            if (!result || !result.ok) {
              errors.push(item.entry.path);
              return null;
            }
            return result.data;
          })();
    if (data === null) continue;
    activeFiles.push({
      root: item.entry.root,
      path: item.entry.path,
      canonical: item.entry.canonical,
      fingerprint: item.fingerprint,
      data,
    });
  }

  const files = yield* resolveAntigravityFiles(activeFiles, sinceMs, cache, errors.length === 0);
  return { files, errors };
});
