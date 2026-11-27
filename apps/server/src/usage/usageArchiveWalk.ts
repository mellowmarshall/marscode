// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import type { UsageProviderKind } from "@t3tools/contracts";

import {
  ARCHIVE_PROBE_TIMEOUT_MS,
  MAX_GLOBAL_ARCHIVE_FS_CONCURRENCY,
  clearArchiveOfflinePath,
  getCachedOfflineResult,
  isArchivePathCachedOffline,
  isTimeoutError,
  markArchiveOffline,
  registerArchiveAlias,
  runArchiveFsOp,
  type ArchiveProbeResult,
} from "./usageArchiveFsGuard.ts";
import type { ArchiveDirState } from "./usageSqliteIndex.ts";
import type { TranscriptFile } from "./usageTranscriptReader.ts";

const MAX_ARCHIVE_WALK_DEPTH = 16;
const MTIME_SAFETY_MARGIN_MS = 5_000;
const ARCHIVE_OP_TIMEOUT_MS = 10_000;
const statFile = NodeUtil.promisify(NodeFS.stat);

const inflightProbes = new Map<string, Promise<ArchiveProbeResult>>();

/** Resolves a symlinked archive path with process-wide FS concurrency cap, timeout, and negative-cache check. */
export async function boundedRealPath(
  dir: string,
  options?: { readonly timeoutMs?: number; readonly nowMs?: number },
): Promise<string | undefined> {
  const timeoutMs = options?.timeoutMs ?? ARCHIVE_PROBE_TIMEOUT_MS;
  const nowMs = options?.nowMs;
  if (nowMs !== undefined && isArchivePathCachedOffline(dir, nowMs)) return undefined;
  try {
    const resolved = await runArchiveFsOp(
      () =>
        nowMs !== undefined && isArchivePathCachedOffline(dir, nowMs)
          ? Promise.resolve(undefined)
          : NodeFSP.realpath(dir),
      timeoutMs,
      "realpath",
    );
    if (resolved !== undefined) registerArchiveAlias(dir, resolved);
    return resolved;
  } catch (error) {
    if (nowMs !== undefined && isTimeoutError(error)) {
      markArchiveOffline(dir, nowMs, "timeout");
    }
    return undefined;
  }
}

async function inspectDanglingSymlinkChain(
  dir: string,
  timeoutMs: number,
): Promise<{
  readonly dangling: boolean;
  readonly brokenAncestor?: string;
  readonly timedOut?: boolean;
}> {
  let current = NodePath.resolve(dir);
  for (let depth = 0; depth < 8; depth += 1) {
    try {
      const link = await runArchiveFsOp(() => NodeFSP.lstat(current), timeoutMs, "archive lstat");
      if (link.isSymbolicLink()) {
        try {
          await runArchiveFsOp(
            () => NodeFSP.stat(current),
            timeoutMs,
            "archive symlink target stat",
          );
          return { dangling: false };
        } catch (error) {
          return { dangling: true, brokenAncestor: current, timedOut: isTimeoutError(error) };
        }
      }
      return { dangling: false };
    } catch (error) {
      if (isTimeoutError(error)) {
        return { dangling: true, brokenAncestor: current, timedOut: true };
      }
    }
    const parent = NodePath.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return { dangling: false };
}

/**
 * Bounded, deduplicated stat probe with negative caching so an offline or stalled SMB mount
 * falls back to cached archive records immediately without starving libuv worker threads.
 */
export async function probeArchiveRoot(
  dir: string,
  options?: {
    readonly timeoutMs?: number;
    readonly nowMs?: number;
    readonly bypassCache?: boolean;
  },
): Promise<ArchiveProbeResult> {
  const normalized = NodePath.resolve(dir);
  const timeoutMs = options?.timeoutMs ?? ARCHIVE_PROBE_TIMEOUT_MS;
  const nowMs = options?.nowMs;
  if (!options?.bypassCache && nowMs !== undefined) {
    const cached = getCachedOfflineResult(normalized, nowMs);
    if (cached !== undefined) return cached;
  }
  const existing = inflightProbes.get(normalized);
  if (existing !== undefined) return existing;

  const probe = (async (): Promise<ArchiveProbeResult> => {
    try {
      const stats = await runArchiveFsOp(
        () => {
          if (
            !options?.bypassCache &&
            nowMs !== undefined &&
            isArchivePathCachedOffline(normalized, nowMs)
          ) {
            return Promise.reject(new Error("archive stat timed out"));
          }
          return NodeFSP.stat(normalized);
        },
        timeoutMs,
        "archive stat",
      );
      clearArchiveOfflinePath(normalized);
      return stats.isDirectory()
        ? { accessible: true, mtimeMs: stats.mtimeMs }
        : { accessible: false, reason: "missing" };
    } catch (error) {
      if (isTimeoutError(error)) {
        const result: ArchiveProbeResult = { accessible: false, reason: "timeout" };
        if (nowMs !== undefined) markArchiveOffline(normalized, nowMs, "timeout");
        return result;
      }
      const code =
        error instanceof Error && "code" in error
          ? String((error as NodeJS.ErrnoException).code)
          : "";
      if (code === "ENOENT" || code === "ENOTDIR") {
        const chain = await inspectDanglingSymlinkChain(normalized, timeoutMs);
        const reason = chain.timedOut ? "timeout" : chain.dangling ? "offline" : "missing";
        const result: ArchiveProbeResult = { accessible: false, reason };
        if (chain.dangling && nowMs !== undefined) {
          markArchiveOffline(
            normalized,
            nowMs,
            chain.timedOut ? "timeout" : "offline",
            chain.brokenAncestor === undefined ? undefined : [chain.brokenAncestor],
          );
        }
        return result;
      }
      const result: ArchiveProbeResult = { accessible: false, reason: "error" };
      if (nowMs !== undefined) markArchiveOffline(normalized, nowMs, "error");
      return result;
    } finally {
      inflightProbes.delete(normalized);
    }
  })();

  inflightProbes.set(normalized, probe);
  return probe;
}

export interface ArchiveWalkResult {
  readonly files: readonly TranscriptFile[];
  readonly updatedDirs: readonly ArchiveDirState[];
  readonly skippedDirs: number;
  readonly walkedDirs: number;
  readonly failedPaths: number;
  readonly timedOut: boolean;
}

/**
 * Walks an immutable archive directory using stored directory mtimes.
 * Unchanged directories older than the mtime safety margin skip readdir and direct-file stats.
 * Aborts immediately on the first timeout (circuit breaker) so a stalled SMB mount cannot hang.
 */
export async function listArchiveTranscriptFiles(input: {
  readonly provider: UsageProviderKind;
  readonly root: string;
  readonly sinceMs: number;
  readonly knownDirs: ReadonlyMap<string, ArchiveDirState>;
  readonly nowMs: number;
  readonly forceWalk?: boolean;
  readonly fileName?: string;
}): Promise<ArchiveWalkResult> {
  const { provider, root, sinceMs, knownDirs, nowMs, forceWalk = false, fileName } = input;
  let failedPaths = 0;
  let skippedDirs = 0;
  let walkedDirs = 0;
  let timedOut = isArchivePathCachedOffline(root, nowMs);
  const updatedDirs: ArchiveDirState[] = [];

  const tripTimeout = () => {
    timedOut = true;
    markArchiveOffline(root, nowMs, "timeout");
  };

  const isAborted = () => timedOut || isArchivePathCachedOffline(root, nowMs);

  const walkChildren = async (
    parentDir: string,
    names: readonly string[],
    depth: number,
  ): Promise<readonly string[]> => {
    if (names.length === 0) return [];
    const results: Array<readonly string[]> = Array.from({ length: names.length }, () => []);
    // Fan out at most 2 workers at the root and walk sequentially below to avoid queuing hundreds of waiters.
    const concurrency = depth === 0 ? Math.min(MAX_GLOBAL_ARCHIVE_FS_CONCURRENCY, names.length) : 1;
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < names.length && !isAborted()) {
        const index = cursor;
        cursor += 1;
        results[index] = await walk(NodePath.join(parentDir, names[index]!), depth + 1);
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    return results.flat();
  };

  const walk = async (dir: string, depth: number): Promise<readonly string[]> => {
    if (isAborted()) {
      timedOut = true;
      return [];
    }
    if (depth > MAX_ARCHIVE_WALK_DEPTH) {
      failedPaths += 1;
      return [];
    }
    let dirStats: NodeFS.Stats;
    try {
      dirStats = await runArchiveFsOp(
        () =>
          isAborted() ? Promise.reject(new Error("archive dir stat timed out")) : statFile(dir),
        ARCHIVE_OP_TIMEOUT_MS,
        "archive dir stat",
      );
    } catch (error) {
      if (isTimeoutError(error)) {
        failedPaths += 1;
        tripTimeout();
        return [];
      }
      const code =
        error instanceof Error && "code" in error
          ? String((error as NodeJS.ErrnoException).code)
          : "";
      if (code !== "ENOENT") failedPaths += 1;
      return [];
    }
    if (isAborted() || !dirStats.isDirectory()) return [];

    const known = knownDirs.get(dir);
    if (
      !forceWalk &&
      known !== undefined &&
      known.complete &&
      known.dirMtimeMs === dirStats.mtimeMs &&
      known.coveredSinceMs <= sinceMs &&
      nowMs - dirStats.mtimeMs > MTIME_SAFETY_MARGIN_MS
    ) {
      skippedDirs += 1;
      if (known.childSubdirs.length === 0) return [];
      return walkChildren(dir, known.childSubdirs, depth);
    }

    walkedDirs += 1;
    let entries: NodeFS.Dirent[];
    try {
      entries = await runArchiveFsOp(
        () =>
          isAborted()
            ? Promise.reject(new Error("archive readdir timed out"))
            : NodeFSP.readdir(dir, { withFileTypes: true }),
        ARCHIVE_OP_TIMEOUT_MS,
        "archive readdir",
      );
    } catch (error) {
      failedPaths += 1;
      if (isTimeoutError(error)) tripTimeout();
      return [];
    }
    if (isAborted()) {
      timedOut = true;
      return [];
    }

    const childSubdirs: string[] = [];
    const directCandidates: string[] = [];
    const compressedBases = new Set<string>();
    if (fileName === undefined) {
      for (const entry of entries) {
        if (!entry.isDirectory() && entry.name.endsWith(".jsonl.zst")) {
          compressedBases.add(entry.name.slice(0, -4));
        }
      }
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        childSubdirs.push(entry.name);
      } else if (
        fileName !== undefined
          ? entry.name === fileName
          : entry.name.endsWith(".jsonl.zst") ||
            (entry.name.endsWith(".jsonl") && !compressedBases.has(entry.name))
      ) {
        directCandidates.push(NodePath.join(dir, entry.name));
      }
    }

    const failedBefore = failedPaths;
    const nested = await walkChildren(dir, childSubdirs, depth);
    updatedDirs.push({
      provider,
      dirPath: dir,
      rootDir: root,
      dirMtimeMs: dirStats.mtimeMs,
      coveredSinceMs: sinceMs,
      childSubdirs,
      complete: !timedOut && failedPaths === failedBefore,
    });
    return [...directCandidates, ...nested];
  };

  const candidates = await walk(root, 0);
  const found: Array<TranscriptFile | undefined> = Array.from({ length: candidates.length });
  const failedStatDirs = new Set<string>();
  if (!isAborted()) {
    const queue = candidates.entries();
    const statQueued = async (): Promise<void> => {
      for (const [index, filePath] of queue) {
        if (isAborted()) {
          timedOut = true;
          break;
        }
        try {
          const stats = await runArchiveFsOp(
            () =>
              isAborted()
                ? Promise.reject(new Error("archive file stat timed out"))
                : statFile(filePath),
            ARCHIVE_OP_TIMEOUT_MS,
            "archive file stat",
          );
          if (stats.mtimeMs >= sinceMs) {
            found[index] = { path: filePath, size: stats.size, mtimeMs: stats.mtimeMs };
          }
        } catch (error) {
          if (isTimeoutError(error)) {
            failedPaths += 1;
            failedStatDirs.add(NodePath.dirname(filePath));
            tripTimeout();
            break;
          }
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
            failedPaths += 1;
            failedStatDirs.add(NodePath.dirname(filePath));
          }
        }
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(MAX_GLOBAL_ARCHIVE_FS_CONCURRENCY, candidates.length) },
        statQueued,
      ),
    );
  }

  const finalizedDirs =
    !timedOut && failedStatDirs.size === 0
      ? updatedDirs
      : updatedDirs.map((dir) =>
          timedOut || failedStatDirs.has(dir.dirPath) ? { ...dir, complete: false } : dir,
        );

  return {
    files: found.filter((file) => file !== undefined),
    updatedDirs: finalizedDirs,
    skippedDirs,
    walkedDirs,
    failedPaths,
    timedOut,
  };
}
