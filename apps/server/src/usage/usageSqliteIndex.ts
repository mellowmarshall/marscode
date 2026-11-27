// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import type * as NodeSqlite from "node:sqlite";
import * as NodeZlib from "node:zlib";

import type { UsageProviderKind } from "@t3tools/contracts";
import type { TranscriptUsageFormat } from "@t3tools/provider-core/server/usage";

import type { CachedFile } from "./usageScanCache.ts";
import {
  decodeAntigravityPayload,
  decodeFilePayload,
  encodeFilePayload,
  makeStateValidators,
} from "./usageSqliteCodec.ts";
import {
  USAGE_SQLITE_INDEX_FILE,
  openUsageSqliteDatabase,
  type AntigravityCachedPayload,
  type ArchiveDirState,
  type ArchiveRootState,
  type CachedSourceMeta,
  type IndexedCachedFile,
} from "./usageSqliteSchema.ts";

export {
  USAGE_SQLITE_INDEX_FILE,
  type AntigravityCachedPayload,
  type ArchiveDirState,
  type ArchiveRootState,
  type CachedSourceMeta,
  type IndexedCachedFile,
} from "./usageSqliteSchema.ts";

export class UsageSqliteIndex {
  readonly #db: NodeSqlite.DatabaseSync;
  #closed = false;

  constructor(stateDir: string) {
    this.#db = openUsageSqliteDatabase(NodePath.join(stateDir, USAGE_SQLITE_INDEX_FILE));
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#db.close();
    } catch {
      // Best-effort close on shutdown.
    }
  }

  #invalidateCorruptRows(
    rows: ReadonlyArray<{ readonly path: string; readonly provider: UsageProviderKind }>,
  ): void {
    if (this.#closed || rows.length === 0) return;
    try {
      const delFile = this.#db.prepare("DELETE FROM usage_files WHERE path = ?");
      const resetDir = this.#db.prepare(
        "UPDATE usage_archive_dirs SET complete = 0 WHERE provider = ? AND dir_path = ?",
      );
      const resetRoot = this.#db.prepare(
        `UPDATE usage_archive_roots SET complete = 0
         WHERE provider = ? AND root_dir IN (
           SELECT root_dir FROM usage_archive_dirs WHERE provider = ? AND dir_path = ?
         )`,
      );
      this.#db.exec("BEGIN IMMEDIATE");
      try {
        for (const row of rows) {
          delFile.run(row.path);
          const dirPath = NodePath.dirname(row.path);
          resetDir.run(row.provider, dirPath);
          resetRoot.run(row.provider, row.provider, dirPath);
        }
        this.#db.prepare("DELETE FROM usage_meta WHERE key = 'coveredSince'").run();
        this.#db.exec("COMMIT");
      } catch {
        try {
          this.#db.exec("ROLLBACK");
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* best-effort */
    }
  }

  loadMeta(): {
    readonly sources: Record<string, CachedSourceMeta>;
    readonly coveredSince: Record<string, number>;
  } {
    if (this.#closed) return { sources: {}, coveredSince: {} };
    const read = (key: string): unknown => {
      const row = this.#db.prepare("SELECT value_json FROM usage_meta WHERE key = ?").get(key) as
        | { value_json?: string }
        | undefined;
      if (typeof row?.value_json !== "string") return undefined;
      try {
        return JSON.parse(row.value_json);
      } catch {
        return undefined;
      }
    };
    const rawSources = read("sources");
    const rawCovered = read("coveredSince");
    const sources: Record<string, CachedSourceMeta> = {};
    if (typeof rawSources === "object" && rawSources !== null) {
      for (const [k, v] of Object.entries(rawSources as Record<string, unknown>)) {
        if (
          typeof v === "object" &&
          v !== null &&
          typeof (v as CachedSourceMeta).dir === "string" &&
          typeof (v as CachedSourceMeta).volumeId === "string"
        ) {
          sources[k] = {
            dir: (v as CachedSourceMeta).dir,
            volumeId: (v as CachedSourceMeta).volumeId,
          };
        }
      }
    }
    const coveredSince: Record<string, number> = {};
    if (typeof rawCovered === "object" && rawCovered !== null) {
      for (const [k, v] of Object.entries(rawCovered as Record<string, unknown>)) {
        if (typeof v === "number" && Number.isFinite(v)) coveredSince[k] = v;
      }
    }
    return { sources, coveredSince };
  }

  getMaxOrderIdx(): number {
    if (this.#closed) return 0;
    const row = this.#db
      .prepare("SELECT COALESCE(MAX(order_idx), 0) AS max_idx FROM usage_files")
      .get() as { max_idx?: number } | undefined;
    return typeof row?.max_idx === "number" && Number.isFinite(row.max_idx) ? row.max_idx : 0;
  }

  loadFilesRange(
    formats: ReadonlyMap<UsageProviderKind, TranscriptUsageFormat<unknown>>,
    minMtimeMs: number,
    maxMtimeMsExclusive: number,
    onCorrupt?: () => void,
  ): readonly IndexedCachedFile[] {
    const out: IndexedCachedFile[] = [];
    if (this.#closed) return out;
    const validators = makeStateValidators(formats);
    type FileRow = {
      path: string;
      provider: UsageProviderKind;
      size: number;
      mtime_ms: number;
      order_idx: number;
      payload: Uint8Array;
    };
    const rows = (
      minMtimeMs === -Infinity && maxMtimeMsExclusive === Infinity
        ? this.#db
            .prepare(
              "SELECT path, provider, size, mtime_ms, order_idx, payload FROM usage_files ORDER BY order_idx ASC",
            )
            .all()
        : this.#db
            .prepare(
              "SELECT path, provider, size, mtime_ms, order_idx, payload FROM usage_files WHERE mtime_ms >= ? AND mtime_ms < ? ORDER BY order_idx ASC",
            )
            .all(minMtimeMs, maxMtimeMsExclusive)
    ) as FileRow[];
    const corrupt: Array<{ path: string; provider: UsageProviderKind }> = [];
    for (const row of rows) {
      const validate = validators.get(row.provider);
      if (validate === undefined) continue;
      const decoded = decodeFilePayload(
        row.payload,
        row.provider,
        row.size,
        row.mtime_ms,
        validate,
      );
      if (decoded !== null) out.push({ path: row.path, entry: decoded, orderIdx: row.order_idx });
      else corrupt.push({ path: row.path, provider: row.provider });
    }
    if (corrupt.length > 0) {
      this.#invalidateCorruptRows(corrupt);
      onCorrupt?.();
    }
    return out;
  }

  getFile(
    filePath: string,
    formats: ReadonlyMap<UsageProviderKind, TranscriptUsageFormat<unknown>>,
    onCorrupt?: () => void,
  ): IndexedCachedFile | undefined {
    if (this.#closed) return undefined;
    const row = this.#db
      .prepare(
        "SELECT path, provider, size, mtime_ms, order_idx, payload FROM usage_files WHERE path = ?",
      )
      .get(filePath) as
      | {
          path: string;
          provider: UsageProviderKind;
          size: number;
          mtime_ms: number;
          order_idx: number;
          payload: Uint8Array;
        }
      | undefined;
    if (row === undefined) return undefined;
    const validate = makeStateValidators(formats).get(row.provider);
    if (validate === undefined) return undefined;
    const decoded = decodeFilePayload(row.payload, row.provider, row.size, row.mtime_ms, validate);
    if (decoded === null) {
      this.#invalidateCorruptRows([{ path: row.path, provider: row.provider }]);
      onCorrupt?.();
      return undefined;
    }
    return { path: row.path, entry: decoded, orderIdx: row.order_idx };
  }

  flushTranscriptChanges(input: {
    readonly upserts: ReadonlyMap<string, CachedFile>;
    readonly deletes: ReadonlySet<string>;
    readonly orderIndices?: ReadonlyMap<string, number>;
    readonly orderUpdates?: ReadonlyMap<string, number>;
    readonly archiveDirs?: readonly ArchiveDirState[];
    readonly archiveRoots?: readonly ArchiveRootState[];
    readonly sources: Readonly<Record<string, CachedSourceMeta>>;
    readonly coveredSince: Readonly<Record<string, number>>;
  }): void {
    if (this.#closed) return;
    const upsertStmt = this.#db.prepare(
      `INSERT INTO usage_files (path, provider, size, mtime_ms, order_idx, payload)
       VALUES (?, ?, ?, ?, COALESCE(?, (SELECT order_idx FROM usage_files WHERE path = ?), (SELECT COALESCE(MAX(order_idx), 0) + 1 FROM usage_files)), ?)
       ON CONFLICT(path) DO UPDATE SET
         provider = excluded.provider,
         size = excluded.size,
         mtime_ms = excluded.mtime_ms,
         payload = excluded.payload`,
    );
    const deleteStmt = this.#db.prepare("DELETE FROM usage_files WHERE path = ?");
    const updateOrderStmt = this.#db.prepare("UPDATE usage_files SET order_idx = ? WHERE path = ?");
    const upsertDirStmt = this.#db.prepare(
      `INSERT INTO usage_archive_dirs (provider, dir_path, root_dir, dir_mtime_ms, covered_since_ms, child_subdirs_json, complete, has_live_skips)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider, dir_path) DO UPDATE SET
         root_dir = excluded.root_dir,
         dir_mtime_ms = excluded.dir_mtime_ms,
         covered_since_ms = CASE
           WHEN excluded.complete = 1 THEN MIN(usage_archive_dirs.covered_since_ms, excluded.covered_since_ms)
           ELSE usage_archive_dirs.covered_since_ms
         END,
         child_subdirs_json = excluded.child_subdirs_json,
         complete = excluded.complete,
         has_live_skips = excluded.has_live_skips`,
    );
    const upsertRootStmt = this.#db.prepare(
      `INSERT INTO usage_archive_roots (provider, root_dir, covered_since_ms, last_scanned_ms, complete, live_roots_key, sidecar_fingerprint)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider, root_dir) DO UPDATE SET
         covered_since_ms = CASE
           WHEN excluded.complete = 1 THEN MIN(usage_archive_roots.covered_since_ms, excluded.covered_since_ms)
           ELSE usage_archive_roots.covered_since_ms
         END,
         last_scanned_ms = excluded.last_scanned_ms,
         complete = excluded.complete,
         live_roots_key = excluded.live_roots_key,
         sidecar_fingerprint = excluded.sidecar_fingerprint`,
    );
    const upsertMetaStmt = this.#db.prepare(
      "INSERT INTO usage_meta (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
    );

    this.#db.exec("BEGIN IMMEDIATE");
    try {
      for (const path of input.deletes) deleteStmt.run(path);
      for (const [filePath, entry] of input.upserts) {
        upsertStmt.run(
          filePath,
          entry.provider,
          entry.size,
          entry.mtimeMs,
          input.orderIndices?.get(filePath) ?? null,
          filePath,
          encodeFilePayload(entry),
        );
      }
      if (input.orderUpdates !== undefined) {
        for (const [filePath, orderIdx] of input.orderUpdates) {
          updateOrderStmt.run(orderIdx, filePath);
        }
      }
      for (const dir of input.archiveDirs ?? []) {
        upsertDirStmt.run(
          dir.provider,
          dir.dirPath,
          dir.rootDir,
          dir.dirMtimeMs,
          dir.coveredSinceMs,
          JSON.stringify(dir.childSubdirs),
          dir.complete ? 1 : 0,
          dir.hasLiveSkips ? 1 : 0,
        );
      }
      for (const root of input.archiveRoots ?? []) {
        upsertRootStmt.run(
          root.provider,
          root.rootDir,
          root.coveredSinceMs,
          root.lastScannedMs,
          root.complete ? 1 : 0,
          root.liveRootsKey ?? "",
          root.sidecarFingerprint ?? "",
        );
      }
      upsertMetaStmt.run("sources", JSON.stringify(input.sources));
      upsertMetaStmt.run("coveredSince", JSON.stringify(input.coveredSince));
      this.#db.exec("COMMIT");
    } catch (error) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {
        // Ignore rollback errors.
      }
      throw error;
    }
  }

  pruneFilesBefore(retentionCutoffMs: number): number {
    if (this.#closed || retentionCutoffMs <= 0) return 0;
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.#db
        .prepare("DELETE FROM usage_files WHERE mtime_ms < ?")
        .run(retentionCutoffMs);
      const removed = Number(result.changes);
      // Raise archive coverage floors to match pruned files so widening retention re-scans them.
      this.#db
        .prepare("UPDATE usage_archive_roots SET covered_since_ms = ? WHERE covered_since_ms < ?")
        .run(retentionCutoffMs, retentionCutoffMs);
      this.#db
        .prepare("UPDATE usage_archive_dirs SET covered_since_ms = ? WHERE covered_since_ms < ?")
        .run(retentionCutoffMs, retentionCutoffMs);
      this.#db.exec("COMMIT");
      return removed;
    } catch (error) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {
        // Ignore rollback errors.
      }
      throw error;
    }
  }

  getArchiveRootState(provider: UsageProviderKind, rootDir: string): ArchiveRootState | undefined {
    if (this.#closed) return undefined;
    const row = this.#db
      .prepare(
        "SELECT covered_since_ms, last_scanned_ms, complete, live_roots_key, sidecar_fingerprint FROM usage_archive_roots WHERE provider = ? AND root_dir = ?",
      )
      .get(provider, rootDir) as
      | {
          covered_since_ms: number;
          last_scanned_ms: number;
          complete: number;
          live_roots_key: string;
          sidecar_fingerprint: string;
        }
      | undefined;
    if (row === undefined) return undefined;
    return {
      provider,
      rootDir,
      coveredSinceMs: row.covered_since_ms,
      lastScannedMs: row.last_scanned_ms,
      complete: row.complete === 1,
      liveRootsKey: row.live_roots_key,
      sidecarFingerprint: row.sidecar_fingerprint,
    };
  }

  loadArchiveDirStates(
    provider: UsageProviderKind,
    rootDir: string,
  ): ReadonlyMap<string, ArchiveDirState> {
    const out = new Map<string, ArchiveDirState>();
    if (this.#closed) return out;
    const rows = this.#db
      .prepare(
        "SELECT dir_path, dir_mtime_ms, covered_since_ms, child_subdirs_json, complete, has_live_skips FROM usage_archive_dirs WHERE provider = ? AND root_dir = ?",
      )
      .all(provider, rootDir) as Array<{
      dir_path: string;
      dir_mtime_ms: number;
      covered_since_ms: number;
      child_subdirs_json: string;
      complete: number;
      has_live_skips: number;
    }>;
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.child_subdirs_json);
        if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) continue;
        out.set(row.dir_path, {
          provider,
          dirPath: row.dir_path,
          rootDir,
          dirMtimeMs: row.dir_mtime_ms,
          coveredSinceMs: row.covered_since_ms,
          childSubdirs: parsed,
          complete: row.complete === 1,
          hasLiveSkips: row.has_live_skips === 1,
        });
      } catch {
        continue;
      }
    }
    return out;
  }

  clearArchiveDirStates(provider: UsageProviderKind, rootDir: string): void {
    if (this.#closed) return;
    this.#db
      .prepare("DELETE FROM usage_archive_dirs WHERE provider = ? AND root_dir = ?")
      .run(provider, rootDir);
  }

  loadAntigravityCache(): Map<string, AntigravityCachedPayload> {
    const out = new Map<string, AntigravityCachedPayload>();
    if (this.#closed) return out;
    const rows = this.#db
      .prepare("SELECT canonical_path, fingerprint, payload FROM antigravity_dbs")
      .all() as Array<{ canonical_path: string; fingerprint: string; payload: Uint8Array }>;
    for (const row of rows) {
      const data = decodeAntigravityPayload(row.payload);
      if (data !== undefined) {
        out.set(row.canonical_path, { fingerprint: row.fingerprint, data });
      }
    }
    return out;
  }

  saveAntigravityChanges(input: {
    readonly upserts: ReadonlyMap<string, AntigravityCachedPayload>;
    readonly deletes: ReadonlySet<string>;
    readonly updatedAtMs: number;
  }): void {
    if (this.#closed || (input.upserts.size === 0 && input.deletes.size === 0)) return;
    const upsertStmt = this.#db.prepare(
      `INSERT INTO antigravity_dbs (canonical_path, fingerprint, payload, updated_at_ms)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(canonical_path) DO UPDATE SET
         fingerprint = excluded.fingerprint,
         payload = excluded.payload,
         updated_at_ms = excluded.updated_at_ms`,
    );
    const deleteStmt = this.#db.prepare("DELETE FROM antigravity_dbs WHERE canonical_path = ?");
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      for (const key of input.deletes) deleteStmt.run(key);
      for (const [canonicalPath, entry] of input.upserts) {
        const serialized =
          entry.data === null
            ? null
            : { candidates: entry.data.candidates, models: [...entry.data.models.entries()] };
        const compressed = NodeZlib.zstdCompressSync(
          Buffer.from(JSON.stringify(serialized), "utf8"),
        );
        upsertStmt.run(canonicalPath, entry.fingerprint, compressed, input.updatedAtMs);
      }
      this.#db.exec("COMMIT");
    } catch (error) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {
        // Ignore rollback errors.
      }
      throw error;
    }
  }
}
