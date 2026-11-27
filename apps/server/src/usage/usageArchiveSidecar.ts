// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import type { UsageProviderKind } from "@t3tools/contracts";
import type { TranscriptUsageFormat } from "@t3tools/provider-core/server/usage";

import type { CachedFile } from "./usageScanCache.ts";
import { decodeFilePayload, makeStateValidators } from "./usageSqliteCodec.ts";
import {
  ARCHIVE_PROBE_TIMEOUT_MS,
  ARCHIVE_READ_TIMEOUT_MS,
  isArchivePathCachedOffline,
  isTimeoutError,
  markArchiveOffline,
  runArchiveFsOp,
} from "./usageArchiveFsGuard.ts";

export const ARCHIVE_SIDECAR_FILE = "usage-archive-index-v1.sqlite";
const SIDECAR_COPY_CHUNK_BYTES = 256 * 1024;
const MAX_SIDECAR_BYTES = 512 * 1024 * 1024;
const SIDECAR_COPY_DEADLINE_MS = 120_000;
export const SIDECAR_SCHEMA_VERSION = 1;

export const SIDECAR_SCHEMA_SQL = `
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
`;

export interface LoadedSidecarFile {
  readonly path: string;
  readonly entry: CachedFile;
}

export type ArchiveSidecarCopyResult =
  | { readonly path: string }
  | { readonly timedOut: true }
  | null;

export type ArchiveSidecarLoadResult =
  | { readonly kind: "absent" }
  | { readonly kind: "timeout" }
  | { readonly kind: "unchanged"; readonly fingerprint: string }
  | {
      readonly kind: "loaded";
      readonly fingerprint: string;
      readonly builtAtMs: number;
      readonly files: readonly LoadedSidecarFile[];
      readonly allPaths: ReadonlySet<string>;
      readonly failedCount: number;
    };

/**
 * Shares copied local temp copies of remote archive SQLite sidecars across sibling subdirs
 * (e.g. claude, codex, codex_codex_archived-sessions) within one scan pass and cleans them up.
 */
export class ArchiveSidecarSession {
  readonly #copies = new Map<string, Promise<ArchiveSidecarCopyResult>>();
  readonly #tempPaths: string[] = [];

  getLocalCopy(
    sidecarPath: string,
    fingerprint: string,
    expectedSize: number,
    nowMs: number,
  ): Promise<ArchiveSidecarCopyResult> {
    const key = `${sidecarPath}\0${fingerprint}`;
    let pending = this.#copies.get(key);
    if (pending === undefined) {
      pending = (async (): Promise<ArchiveSidecarCopyResult> => {
        let srcHandle: NodeFSP.FileHandle | undefined;
        let dstHandle: NodeFSP.FileHandle | undefined;
        let openTimedOut = false;
        let timedOut = false;
        const deadlineMs = Date.now() + SIDECAR_COPY_DEADLINE_MS;
        const maxBytes = Math.min(expectedSize, MAX_SIDECAR_BYTES);
        try {
          const tempDir = await NodeFSP.mkdtemp(
            NodePath.join(NodeOS.tmpdir(), "t3-usage-sidecar-"),
          );
          const tempFile = NodePath.join(tempDir, ARCHIVE_SIDECAR_FILE);
          this.#tempPaths.push(tempDir);
          srcHandle = await runArchiveFsOp(
            () => {
              const opened = NodeFSP.open(sidecarPath, "r");
              void opened.then(
                (h) => {
                  if (openTimedOut) {
                    void runArchiveFsOp(
                      () => h.close(),
                      ARCHIVE_PROBE_TIMEOUT_MS,
                      "sidecar close",
                    ).catch(() => undefined);
                  }
                },
                () => undefined,
              );
              return opened;
            },
            ARCHIVE_READ_TIMEOUT_MS,
            "archive sidecar open",
          );
          dstHandle = await NodeFSP.open(tempFile, "w");
          const buffer = Buffer.allocUnsafe(SIDECAR_COPY_CHUNK_BYTES);
          let position = 0;
          for (;;) {
            if (isArchivePathCachedOffline(sidecarPath, nowMs) || Date.now() > deadlineMs) {
              timedOut = true;
              markArchiveOffline(sidecarPath, nowMs, "timeout");
              return { timedOut: true };
            }
            const { bytesRead } = await runArchiveFsOp(
              () => srcHandle!.read(buffer, 0, buffer.length, position),
              ARCHIVE_READ_TIMEOUT_MS,
              "archive sidecar read",
            );
            if (bytesRead === 0) break;
            if (position + bytesRead > maxBytes) return null;
            await dstHandle.write(buffer, 0, bytesRead, position);
            position += bytesRead;
          }
          if (position !== expectedSize) return null;
          return { path: tempFile };
        } catch (error) {
          if (isTimeoutError(error)) {
            openTimedOut = true;
            timedOut = true;
            markArchiveOffline(sidecarPath, nowMs, "timeout");
            return { timedOut: true };
          }
          return null;
        } finally {
          if (dstHandle !== undefined) await dstHandle.close().catch(() => undefined);
          if (srcHandle !== undefined) {
            if (timedOut) {
              void runArchiveFsOp(
                () => srcHandle!.close(),
                ARCHIVE_PROBE_TIMEOUT_MS,
                "sidecar close",
              ).catch(() => undefined);
            } else {
              await srcHandle.close().catch(() => undefined);
            }
          }
        }
      })();
      this.#copies.set(key, pending);
    }
    return pending;
  }

  async dispose(): Promise<void> {
    for (const dir of this.#tempPaths) {
      await NodeFSP.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
    this.#tempPaths.length = 0;
    this.#copies.clear();
  }
}

function resolveSafeArchivePath(dir: string, relPath: string, subdirPrefix: string): string | null {
  const normalized = relPath.replaceAll("\\", "/");
  if (normalized.startsWith("/") || normalized.includes("\0")) return null;
  if (subdirPrefix.length > 0 && !normalized.startsWith(subdirPrefix)) return null;
  const subRel = subdirPrefix.length > 0 ? normalized.slice(subdirPrefix.length) : normalized;
  if (subRel.length === 0) return null;
  const segments = subRel.split("/");
  if (segments.some((seg) => seg === "" || seg === "." || seg === "..")) return null;
  const resolved = NodePath.resolve(dir, ...segments);
  const check = NodePath.relative(dir, resolved);
  if (check === ".." || check.startsWith(`..${NodePath.sep}`) || NodePath.isAbsolute(check)) {
    return null;
  }
  return resolved;
}

function readSidecarMeta(db: NodeSqlite.DatabaseSync, key: string): unknown {
  try {
    const row = db.prepare("SELECT value_json FROM usage_meta WHERE key = ?").get(key) as
      | { value_json?: string }
      | undefined;
    return typeof row?.value_json === "string" ? JSON.parse(row.value_json) : undefined;
  } catch {
    return undefined;
  }
}

/** Loads `usage-archive-index-v1.sqlite` from `dir` or its parent; authoritative for covered roots (updated in place via `usage:build-archive-index`). */
export async function loadArchiveSidecar(input: {
  readonly session: ArchiveSidecarSession;
  readonly provider: UsageProviderKind;
  readonly dir: string;
  readonly format: TranscriptUsageFormat<unknown>;
  readonly minMtimeMs: number;
  readonly nowMs: number;
  readonly previousFingerprint: string | undefined;
  readonly alreadyCoversWindow: boolean;
}): Promise<ArchiveSidecarLoadResult> {
  const {
    session,
    provider,
    dir,
    format,
    minMtimeMs,
    nowMs,
    previousFingerprint,
    alreadyCoversWindow,
  } = input;
  if (isArchivePathCachedOffline(dir, nowMs)) return { kind: "timeout" };

  const parentDir = NodePath.dirname(dir);
  const subdirName = NodePath.basename(dir);
  const candidates: Array<{ readonly sidecarPath: string; readonly subdirPrefix: string }> = [
    { sidecarPath: NodePath.join(dir, ARCHIVE_SIDECAR_FILE), subdirPrefix: "" },
    ...(parentDir !== dir
      ? [
          {
            sidecarPath: NodePath.join(parentDir, ARCHIVE_SIDECAR_FILE),
            subdirPrefix: `${subdirName}/`,
          },
        ]
      : []),
  ];

  let found:
    | {
        readonly sidecarPath: string;
        readonly subdirPrefix: string;
        readonly fingerprint: string;
        readonly size: number;
        readonly mtimeMs: number;
      }
    | undefined;
  for (const candidate of candidates) {
    try {
      const stats = await runArchiveFsOp(
        () => NodeFSP.stat(candidate.sidecarPath),
        ARCHIVE_PROBE_TIMEOUT_MS,
        "archive sidecar stat",
      );
      if (stats.isFile() && stats.size > 0 && stats.size <= MAX_SIDECAR_BYTES) {
        found = {
          ...candidate,
          fingerprint: `${stats.size}:${stats.mtimeMs}`,
          size: stats.size,
          mtimeMs: stats.mtimeMs,
        };
        break;
      }
    } catch (error) {
      if (isTimeoutError(error)) {
        markArchiveOffline(dir, nowMs, "timeout");
        return { kind: "timeout" };
      }
    }
  }
  if (found === undefined) return { kind: "absent" };

  if (alreadyCoversWindow && previousFingerprint === found.fingerprint) {
    return { kind: "unchanged", fingerprint: found.fingerprint };
  }

  const copied = await session.getLocalCopy(
    found.sidecarPath,
    found.fingerprint,
    found.size,
    nowMs,
  );
  if (copied === null) return { kind: "absent" };
  if ("timedOut" in copied) return { kind: "timeout" };

  const formats = new Map<UsageProviderKind, TranscriptUsageFormat<unknown>>([[provider, format]]);
  const validate = makeStateValidators(formats).get(provider);
  if (validate === undefined) return { kind: "absent" };

  let db: NodeSqlite.DatabaseSync | undefined;
  try {
    db = new NodeSqlite.DatabaseSync(copied.path, { readOnly: true });
    const versionRow = db.prepare("PRAGMA user_version").get() as { user_version?: number };
    if ((versionRow?.user_version ?? 0) !== SIDECAR_SCHEMA_VERSION) return { kind: "absent" };

    // Verify this sidecar actually covers this subdir/provider before trusting empty results.
    const coveredSubdirs = readSidecarMeta(db, "coveredSubdirs");
    const hasCoveredSubdirs =
      Array.isArray(coveredSubdirs) && coveredSubdirs.every((s) => typeof s === "string");
    const coveredProviders = readSidecarMeta(db, "coveredProviders");
    const hasCoveredProviders =
      Array.isArray(coveredProviders) && coveredProviders.every((s) => typeof s === "string");
    if (found.subdirPrefix.length > 0) {
      if (hasCoveredSubdirs && !coveredSubdirs.includes(subdirName)) return { kind: "absent" };
      if (hasCoveredProviders && !coveredProviders.includes(provider)) return { kind: "absent" };
    } else if (hasCoveredProviders && !coveredProviders.includes(provider)) {
      return { kind: "absent" };
    }

    const allPathRows = db
      .prepare("SELECT path FROM usage_files WHERE provider = ?")
      .all(provider) as Array<{ path: string }>;
    const allPaths = new Set<string>();
    for (const row of allPathRows) {
      const mapped = resolveSafeArchivePath(dir, row.path, found.subdirPrefix);
      if (mapped !== null) allPaths.add(mapped);
    }
    if (allPaths.size === 0) {
      const explicitlyCovered =
        found.subdirPrefix.length > 0
          ? hasCoveredSubdirs && coveredSubdirs.includes(subdirName)
          : hasCoveredProviders && coveredProviders.includes(provider);
      if (!explicitlyCovered) return { kind: "absent" };
    }

    const builtAtRaw = readSidecarMeta(db, "builtAtMs");
    const builtAtMs =
      typeof builtAtRaw === "number" && Number.isFinite(builtAtRaw) && builtAtRaw > 0
        ? builtAtRaw
        : found.mtimeMs;

    const failedBySubdir = readSidecarMeta(db, "failedBySubdir");
    const failedByProvider = readSidecarMeta(db, "failedByProvider");
    let failedCount = 0;
    if (
      found.subdirPrefix.length > 0 &&
      typeof failedBySubdir === "object" &&
      failedBySubdir !== null &&
      typeof (failedBySubdir as Record<string, unknown>)[subdirName] === "number"
    ) {
      failedCount = Math.max(0, (failedBySubdir as Record<string, number>)[subdirName]!);
    } else if (
      typeof failedByProvider === "object" &&
      failedByProvider !== null &&
      typeof (failedByProvider as Record<string, unknown>)[provider] === "number"
    ) {
      failedCount = Math.max(0, (failedByProvider as Record<string, number>)[provider]!);
    }

    const rows = db
      .prepare(
        "SELECT path, provider, size, mtime_ms, payload FROM usage_files WHERE provider = ? AND mtime_ms >= ? ORDER BY order_idx ASC",
      )
      .all(provider, minMtimeMs) as Array<{
      path: string;
      provider: UsageProviderKind;
      size: number;
      mtime_ms: number;
      payload: Uint8Array;
    }>;
    const files: LoadedSidecarFile[] = [];
    for (const row of rows) {
      if (row.provider !== provider) continue;
      const mappedPath = resolveSafeArchivePath(dir, row.path, found.subdirPrefix);
      if (mappedPath === null) continue;
      const decoded = decodeFilePayload(row.payload, provider, row.size, row.mtime_ms, validate);
      if (decoded !== null) files.push({ path: mappedPath, entry: decoded });
    }
    return {
      kind: "loaded",
      fingerprint: found.fingerprint,
      builtAtMs,
      files,
      allPaths,
      failedCount,
    };
  } catch {
    return { kind: "absent" };
  } finally {
    try {
      db?.close();
    } catch {
      // Ignore close errors on temp sidecar DB.
    }
  }
}
