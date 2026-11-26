// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import type { UsageProviderKind } from "@t3tools/contracts";
import type { UsageRecord } from "@t3tools/provider-core/server/usage";

import type { CachedFile } from "./usageScanCache.ts";

export const USAGE_SQLITE_INDEX_FILE = "usage-index-v1.sqlite";
const USAGE_SQLITE_SCHEMA_VERSION = 1;
const SQLITE_CORRUPT = 11;
const SQLITE_NOTADB = 26;

export interface CachedSourceMeta {
  readonly dir: string;
  readonly volumeId: string;
}

export interface ArchiveRootState {
  readonly provider: UsageProviderKind;
  readonly rootDir: string;
  readonly coveredSinceMs: number;
  readonly lastScannedMs: number;
  readonly complete: boolean;
  readonly liveRootsKey?: string;
}

export interface ArchiveDirState {
  readonly provider: UsageProviderKind;
  readonly dirPath: string;
  readonly rootDir: string;
  readonly dirMtimeMs: number;
  readonly coveredSinceMs: number;
  readonly childSubdirs: readonly string[];
  readonly complete: boolean;
  readonly hasLiveSkips?: boolean;
}

export interface IndexedCachedFile {
  readonly path: string;
  readonly entry: CachedFile;
  readonly orderIdx: number;
}

export interface AntigravityCachedPayload {
  readonly fingerprint: string;
  readonly data: {
    readonly candidates: ReadonlyArray<{
      readonly record: UsageRecord;
      readonly modelId: number;
      readonly modelQuality: number;
      readonly keys: readonly string[];
      readonly timestampQuality: number;
    }>;
    readonly models: ReadonlyMap<number, string | null>;
  } | null;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS usage_files (
  path TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime_ms REAL NOT NULL,
  order_idx INTEGER NOT NULL,
  payload BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_files_mtime ON usage_files(mtime_ms);
CREATE INDEX IF NOT EXISTS idx_usage_files_provider_mtime ON usage_files(provider, mtime_ms);
CREATE INDEX IF NOT EXISTS idx_usage_files_order ON usage_files(order_idx);

CREATE TABLE IF NOT EXISTS usage_meta (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_archive_roots (
  provider TEXT NOT NULL,
  root_dir TEXT NOT NULL,
  covered_since_ms REAL NOT NULL,
  last_scanned_ms REAL NOT NULL,
  complete INTEGER NOT NULL,
  live_roots_key TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (provider, root_dir)
);

CREATE TABLE IF NOT EXISTS usage_archive_dirs (
  provider TEXT NOT NULL,
  dir_path TEXT NOT NULL,
  root_dir TEXT NOT NULL,
  dir_mtime_ms REAL NOT NULL,
  covered_since_ms REAL NOT NULL,
  child_subdirs_json TEXT NOT NULL,
  complete INTEGER NOT NULL,
  has_live_skips INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (provider, dir_path)
);
CREATE INDEX IF NOT EXISTS idx_usage_archive_dirs_root ON usage_archive_dirs(provider, root_dir);

CREATE TABLE IF NOT EXISTS antigravity_dbs (
  canonical_path TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  payload BLOB NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
`;

function isSqliteCorruptionError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const errcode = "errcode" in error ? Number((error as { errcode?: unknown }).errcode) : NaN;
  if (errcode === SQLITE_CORRUPT || errcode === SQLITE_NOTADB) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /database disk image is malformed|file is not a database|sqlite_corrupt|sqlite_notadb/i.test(
    message,
  );
}

export function openUsageSqliteDatabase(dbPath: string): NodeSqlite.DatabaseSync {
  NodeFS.mkdirSync(NodePath.dirname(dbPath), { recursive: true });
  const init = () => {
    const db = new NodeSqlite.DatabaseSync(dbPath);
    try {
      // Set busy_timeout before WAL/DDL so concurrent openers wait instead of failing.
      db.exec("PRAGMA busy_timeout = 500;");
      db.exec("PRAGMA journal_mode = WAL;");
      db.exec("PRAGMA synchronous = NORMAL;");
      const versionRow = db.prepare("PRAGMA user_version").get() as { user_version?: number };
      const version = versionRow?.user_version ?? 0;
      if (version > USAGE_SQLITE_SCHEMA_VERSION) {
        throw new Error(`Unsupported usage index schema version ${version}`);
      }
      db.exec(SCHEMA_SQL);
      const rootCols = db.prepare("PRAGMA table_info(usage_archive_roots)").all() as Array<{
        name?: string;
      }>;
      if (!rootCols.some((col) => col.name === "live_roots_key")) {
        db.exec(
          "ALTER TABLE usage_archive_roots ADD COLUMN live_roots_key TEXT NOT NULL DEFAULT '';",
        );
      }
      const dirCols = db.prepare("PRAGMA table_info(usage_archive_dirs)").all() as Array<{
        name?: string;
      }>;
      if (!dirCols.some((col) => col.name === "has_live_skips")) {
        db.exec(
          "ALTER TABLE usage_archive_dirs ADD COLUMN has_live_skips INTEGER NOT NULL DEFAULT 0;",
        );
      }
      if (version < USAGE_SQLITE_SCHEMA_VERSION) {
        db.exec(`PRAGMA user_version = ${USAGE_SQLITE_SCHEMA_VERSION};`);
      }
      return db;
    } catch (error) {
      try {
        db.close();
      } catch {
        // Ignore close error during failed init.
      }
      throw error;
    }
  };
  try {
    return init();
  } catch (error) {
    // Only delete on genuine database corruption; never unlink on lock contention (SQLITE_BUSY).
    if (!isSqliteCorruptionError(error)) throw error;
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        NodeFS.rmSync(`${dbPath}${suffix}`, { force: true });
      } catch {
        // Ignore cleanup failure and retry open.
      }
    }
    return init();
  }
}
