// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import type { UsageProviderKind } from "@t3tools/contracts";
import type { TranscriptUsageFormat, UsageRecord } from "@t3tools/provider-core/server/usage";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

import type { CachedFile, ScanCache } from "./usageScanCache.ts";
import {
  ARCHIVE_READ_CONCURRENCY,
  ARCHIVE_READ_TIMEOUT_MS,
  ARCHIVE_RESCAN_INTERVAL_MS,
  isArchivePathCachedOffline,
  markArchiveOffline,
} from "./usageArchiveFsGuard.ts";
import { listArchiveTranscriptFiles, probeArchiveRoot } from "./usageArchiveWalk.ts";
import type { ArchiveDirState, ArchiveRootState, UsageSqliteIndex } from "./usageSqliteIndex.ts";
import type { TranscriptFile } from "./usageTranscriptReader.ts";

const MTIME_SAFETY_MARGIN_MS = 5_000;

export interface LiveDuplicateIndex {
  readonly claudeByRelPath: ReadonlyMap<
    string,
    { readonly size: number; readonly mtimeMs: number }
  >;
  readonly codexByBaseName: ReadonlyMap<
    string,
    {
      readonly size: number;
      readonly mtimeMs: number;
      readonly compressed: boolean;
      readonly hasRecords: boolean;
    }
  >;
}

/** Builds a lookup of already-indexed live files so cold SMB archives skip redundant backup downloads. */
export function buildLiveDuplicateIndex(
  fileCache: ReadonlyMap<string, CachedFile>,
  liveRootsByProvider: ReadonlyMap<UsageProviderKind, readonly string[]>,
): LiveDuplicateIndex {
  const claudeByRelPath = new Map<string, { size: number; mtimeMs: number }>();
  const codexByBaseName = new Map<
    string,
    { size: number; mtimeMs: number; compressed: boolean; hasRecords: boolean }
  >();
  const claudeRoots = liveRootsByProvider.get("claude") ?? [];
  const codexRoots = liveRootsByProvider.get("codex") ?? [];

  const withinAny = (filePath: string, roots: readonly string[]): string | undefined => {
    for (const root of roots) {
      const rel = NodePath.relative(root, filePath);
      if (rel !== ".." && !rel.startsWith(`..${NodePath.sep}`) && !NodePath.isAbsolute(rel)) {
        return rel;
      }
    }
    return undefined;
  };

  for (const [filePath, entry] of fileCache) {
    if (entry.provider === "claude" && claudeRoots.length > 0) {
      const rel = withinAny(filePath, claudeRoots);
      if (rel !== undefined) {
        const prev = claudeByRelPath.get(rel);
        if (prev === undefined || entry.size > prev.size) {
          claudeByRelPath.set(rel, { size: entry.size, mtimeMs: entry.mtimeMs });
        }
      }
    } else if (entry.provider === "codex" && codexRoots.length > 0) {
      const rel = withinAny(filePath, codexRoots);
      if (rel !== undefined) {
        const compressed = filePath.endsWith(".jsonl.zst");
        const base = NodePath.basename(compressed ? filePath.slice(0, -4) : filePath);
        const hasRecords = entry.records.length + entry.tailRecords.length > 0;
        const prev = codexByBaseName.get(base);
        if (prev === undefined || entry.mtimeMs > prev.mtimeMs || entry.size > prev.size) {
          codexByBaseName.set(base, {
            size: entry.size,
            mtimeMs: entry.mtimeMs,
            compressed,
            hasRecords,
          });
        }
      }
    }
  }
  return { claudeByRelPath, codexByBaseName };
}

/** True when an archive file is a redundant backup of an equal-or-newer live file already indexed. */
export function isCoveredByLiveBackup(
  provider: UsageProviderKind,
  archiveRoot: string,
  file: TranscriptFile,
  liveIndex: LiveDuplicateIndex,
): boolean {
  if (provider === "claude") {
    const rel = NodePath.relative(archiveRoot, file.path);
    const projectsPrefix = `projects${NodePath.sep}`;
    const altRel = rel.startsWith(projectsPrefix) ? rel.slice(projectsPrefix.length) : undefined;
    const live =
      liveIndex.claudeByRelPath.get(rel) ??
      (altRel === undefined ? undefined : liveIndex.claudeByRelPath.get(altRel));
    return (
      live !== undefined &&
      live.size >= file.size &&
      live.mtimeMs >= file.mtimeMs - MTIME_SAFETY_MARGIN_MS
    );
  }
  if (provider === "codex") {
    const compressed = file.path.endsWith(".jsonl.zst");
    const base = NodePath.basename(compressed ? file.path.slice(0, -4) : file.path);
    const live = liveIndex.codexByBaseName.get(base);
    if (live === undefined || live.mtimeMs < file.mtimeMs - MTIME_SAFETY_MARGIN_MS) return false;
    if (live.compressed) return live.hasRecords;
    return !compressed && live.size >= file.size;
  }
  return false;
}

export interface ArchiveReadFileResult {
  readonly records: readonly UsageRecord[];
  readonly malformedRecords: readonly number[];
  readonly failed?: true;
  readonly update?: { readonly entry: CachedFile; readonly replaces: CachedFile | undefined };
}

export interface ArchiveScanContext {
  readonly provider: UsageProviderKind;
  readonly format: TranscriptUsageFormat<unknown>;
  readonly dir: string;
  readonly volumeId: string;
  readonly physicalSourceId: string | undefined;
  readonly fileName: string | undefined;
  readonly windowStartMs: number;
  readonly retentionCutoffMs: number;
  readonly fromMemory: boolean;
  readonly liveDuplicateIndex: LiveDuplicateIndex | undefined;
  readonly liveRootsKey: string;
  readonly fileCache: ScanCache;
  readonly pendingArchiveDirs: Map<string, ArchiveDirState>;
  readonly pendingArchiveRoots: Map<string, ArchiveRootState>;
  readonly getSqliteIndex: (nowMs: number) => UsageSqliteIndex | null;
  readonly isWithinDirectory: (filePath: string, dir: string) => boolean;
  readonly isLaterRead: (next: CachedFile, current: CachedFile) => boolean;
  readonly correctedBatch: (records: readonly UsageRecord[]) => readonly UsageRecord[];
  readonly setCachedFile: (filePath: string, entry: CachedFile) => void;
  readonly deleteCachedFile: (filePath: string) => boolean;
  readonly markDirty: () => void;
  readonly cover: (sinceMs: number) => void;
  readonly readFileRecords: (
    filePath: string,
    size: number,
    mtimeMs: number,
    provider: UsageProviderKind,
    format: TranscriptUsageFormat<unknown>,
    options?: {
      readonly readTimeoutMs?: number;
      readonly onTimeout?: () => void;
      readonly useArchiveSlot?: boolean;
    },
  ) => Effect.Effect<ArchiveReadFileResult>;
}

/**
 * Scans a cold archive root with fresh-root skipping, dir-mtime skipping, live-backup skipping,
 * process-wide FS slot limiting, timeout circuit breaking, and offline SQLite fallback.
 */
export const scanArchiveTranscriptDir = Effect.fn("UsageService.scanArchiveTranscriptDir")(
  function* (ctx: ArchiveScanContext) {
    const {
      provider,
      format,
      dir,
      volumeId,
      physicalSourceId,
      fileName,
      windowStartMs,
      retentionCutoffMs,
      fromMemory,
      liveDuplicateIndex,
      liveRootsKey,
      fileCache,
      pendingArchiveDirs,
      pendingArchiveRoots,
    } = ctx;
    const identity = {
      provider,
      dir,
      volumeId,
      ...(physicalSourceId === undefined ? {} : { physicalSourceId }),
    };

    if (fromMemory) return { ...identity, files: [] as const };
    const nowMs = yield* Clock.currentTimeMillis;
    const index = ctx.getSqliteIndex(nowMs);
    const effectiveSinceMs = Math.max(windowStartMs, retentionCutoffMs);
    const pendingRoot = pendingArchiveRoots.get(`${provider}\0${dir}`);
    const storedRoot = yield* Effect.try({
      try: () => index?.getArchiveRootState(provider, dir),
      catch: () => undefined,
    }).pipe(Effect.orElseSucceed(() => undefined));
    const rootState = pendingRoot ?? storedRoot;
    const liveRootsChanged =
      rootState !== undefined && (rootState.liveRootsKey ?? "") !== liveRootsKey;

    if (
      rootState !== undefined &&
      rootState.complete &&
      rootState.coveredSinceMs <= effectiveSinceMs &&
      !liveRootsChanged &&
      nowMs - rootState.lastScannedMs < ARCHIVE_RESCAN_INTERVAL_MS
    ) {
      return { ...identity, files: [] as const };
    }

    const probe = yield* Effect.promise(() => probeArchiveRoot(dir, { nowMs }));
    if (!probe.accessible) {
      const hasCached = [...fileCache.entries()].some(
        ([filePath, entry]) => entry.provider === provider && ctx.isWithinDirectory(filePath, dir),
      );
      if (probe.reason === "missing" && !hasCached) {
        ctx.cover(effectiveSinceMs);
        return { ...identity, files: null };
      }
      return {
        ...identity,
        files: [] as const,
        status: "partial" as const,
        message: "Archive directory is temporarily unreachable; showing cached usage.",
      };
    }

    // Keep the earliest covered horizon when refreshing a changed archive directory so
    // newly moved files with older mtimes are not filtered out by a narrower UI window.
    const walkSinceMs =
      rootState !== undefined
        ? Math.max(retentionCutoffMs, Math.min(effectiveSinceMs, rootState.coveredSinceMs))
        : effectiveSinceMs;
    const storedDirs = yield* Effect.try({
      try: () => index?.loadArchiveDirStates(provider, dir) ?? new Map<string, ArchiveDirState>(),
      catch: () => new Map<string, ArchiveDirState>(),
    }).pipe(Effect.orElseSucceed(() => new Map<string, ArchiveDirState>()));

    // When live roots changed, force re-walking only dirs that previously skipped live backups.
    const knownDirs = liveRootsChanged
      ? new Map(
          [...storedDirs.entries()].map(([dirPath, state]) => [
            dirPath,
            state.hasLiveSkips ? { ...state, complete: false } : state,
          ]),
        )
      : storedDirs;

    const walkResult = yield* Effect.promise(() =>
      listArchiveTranscriptFiles({
        provider,
        root: dir,
        sinceMs: walkSinceMs,
        knownDirs,
        nowMs,
        ...(fileName === undefined ? {} : { fileName }),
      }),
    );

    const skippedLiveDirs = new Set<string>();
    const filesToRead = walkResult.timedOut
      ? []
      : liveDuplicateIndex === undefined
        ? walkResult.files
        : walkResult.files.filter((file) => {
            if (isCoveredByLiveBackup(provider, dir, file, liveDuplicateIndex)) {
              skippedLiveDirs.add(NodePath.dirname(file.path));
              return false;
            }
            return true;
          });

    let readTimedOut = false;
    const read = yield* Effect.forEach(
      filesToRead,
      (file) =>
        (readTimedOut || isArchivePathCachedOffline(dir, nowMs)
          ? Effect.succeed<ArchiveReadFileResult>({
              records: [],
              malformedRecords: [],
              failed: true,
            })
          : ctx.readFileRecords(file.path, file.size, file.mtimeMs, provider, format, {
              readTimeoutMs: ARCHIVE_READ_TIMEOUT_MS,
              useArchiveSlot: true,
              onTimeout: () => {
                readTimedOut = true;
                markArchiveOffline(dir, nowMs, "timeout");
              },
            })
        ).pipe(Effect.map((result) => ({ path: file.path, ...result }))),
      { concurrency: ARCHIVE_READ_CONCURRENCY },
    );

    const failedReadDirs = new Set<string>();
    const parsedFiles = read.map(
      ({ path: filePath, records, malformedRecords, failed, update }) => {
        if (failed) failedReadDirs.add(NodePath.dirname(filePath));
        if (update === undefined) return { path: filePath, records, malformedRecords };
        const current = fileCache.get(filePath);
        if (
          current === update.replaces ||
          current === undefined ||
          ctx.isLaterRead(update.entry, current)
        ) {
          ctx.setCachedFile(filePath, {
            ...update.entry,
            records: ctx.correctedBatch(update.entry.records),
            tailRecords: ctx.correctedBatch(update.entry.tailRecords),
          });
        }
        return { path: filePath, records, malformedRecords };
      },
    );

    const livePaths = new Set(walkResult.files.map((file) => file.path));
    for (const file of read) {
      if (file.failed || !file.path.endsWith(".jsonl.zst")) continue;
      const originalPath = file.path.slice(0, -4);
      if (!livePaths.has(originalPath)) ctx.deleteCachedFile(originalPath);
    }

    const unread = walkResult.failedPaths + read.filter((file) => file.failed).length;
    const archiveTimedOut =
      walkResult.timedOut || readTimedOut || isArchivePathCachedOffline(dir, nowMs);
    // Preserve complete=true on dirs whose files all succeeded so a late read timeout stays resumable.
    const finalizedDirs = walkResult.updatedDirs.map((entry) => ({
      ...entry,
      complete: entry.complete && !walkResult.timedOut && !failedReadDirs.has(entry.dirPath),
      hasLiveSkips: skippedLiveDirs.has(entry.dirPath),
    }));

    // Queue archive dir/root state to commit atomically with usage_files in persistCaches.
    for (const entry of finalizedDirs) {
      pendingArchiveDirs.set(`${entry.provider}\0${entry.dirPath}`, entry);
    }
    pendingArchiveRoots.set(`${provider}\0${dir}`, {
      provider,
      rootDir: dir,
      coveredSinceMs: walkSinceMs,
      lastScannedMs: nowMs,
      complete: !archiveTimedOut && unread === 0,
      liveRootsKey,
    });
    ctx.markDirty();
    if (!archiveTimedOut && unread === 0) ctx.cover(walkSinceMs);

    yield* Effect.annotateCurrentSpan({
      "usage.files": walkResult.files.length,
      "usage.files_skipped_live_dup": walkResult.files.length - filesToRead.length,
      "usage.files_parsed": read.filter((file) => file.update !== undefined).length,
      "usage.archive_dirs_skipped": walkResult.skippedDirs,
      "usage.archive_dirs_walked": walkResult.walkedDirs,
    });

    return {
      ...identity,
      files: parsedFiles,
      ...(archiveTimedOut || unread > 0
        ? {
            status: "partial" as const,
            message: archiveTimedOut
              ? "Archive directory timed out; showing cached usage."
              : `${unread} transcript path(s) could not be read; usage may be incomplete.`,
          }
        : {}),
    };
  },
);
