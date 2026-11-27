// @effect-diagnostics nodeBuiltinImport:off - Per-job worker version pinning, atomic bundle staging, containment checks, and race-safe pruning.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { isEnded, listJobIds, readJob } from "./jobStore.ts";
import { currentProcessIdentity, isProcessAlive, type ProcessIdentity } from "./processIdentity.ts";
import {
  claimLock,
  liveVersionedWorkers,
  releaseLock,
  versionsLockPath,
  type IsAlive,
} from "./processLocks.ts";
import type { Clock, JobRecord } from "./types.ts";

const SAFE_VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface WorkerRuntimeVersion {
  readonly version: string;
  readonly entryPath: string;
  readonly stagedAt?: string | undefined;
}

export interface StageWorkerVersionInput {
  readonly root: string;
  readonly version: string;
  /** Directory copied atomically into `<root>/versions/<version>` when staging a bundle. */
  readonly sourceDir?: string | undefined;
  /** Relative path to the CLI entrypoint inside `sourceDir` (default: `cli.ts`). */
  readonly entryRelPath?: string | undefined;
  /** Direct pre-staged CLI entrypoint path when not copying a directory. */
  readonly entryPath?: string | undefined;
  /** Optional trusted root directory that `entryPath` must resolve inside when not using `sourceDir`. */
  readonly allowedEntryRoot?: string | undefined;
  readonly clock?: Clock | undefined;
  readonly self?: ProcessIdentity | undefined;
  readonly isAlive?: IsAlive | undefined;
}

export interface PruneWorkerVersionsResult {
  readonly pruned: ReadonlyArray<string>;
  readonly kept: ReadonlyArray<string>;
  readonly skippedLocked?: boolean | undefined;
}

export function isSafeVersionId(version: string): boolean {
  return SAFE_VERSION_RE.test(version);
}

export function versionsDir(root: string): string {
  return NodePath.join(root, "versions");
}

export function versionBundleDir(root: string, version: string): string {
  if (!isSafeVersionId(version)) {
    throw new Error(`Invalid worker version id: ${JSON.stringify(version)}`);
  }
  return NodePath.join(versionsDir(root), version);
}

export function currentVersionPath(root: string): string {
  return NodePath.join(versionsDir(root), "current.json");
}

function writeJsonAtomic(filePath: string, payload: unknown): void {
  NodeFS.mkdirSync(NodePath.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.${NodeCrypto.randomUUID()}.tmp`;
  NodeFS.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  NodeFS.renameSync(tmp, filePath);
}

export function resolveCanonicalPath(filePath: string): string {
  try {
    return NodeFS.realpathSync(filePath);
  } catch {
    return NodePath.resolve(filePath);
  }
}

function isSafeRelativeEntryPath(rel: string): boolean {
  if (!rel || NodePath.isAbsolute(rel) || rel.includes("\0")) return false;
  const parts = rel.split(/[\\/]+/);
  return parts.every((seg) => seg.length > 0 && seg !== "." && seg !== "..");
}

/**
 * Verifies that `candidatePath` resolves canonically to an existing regular file strictly inside `rootDir`.
 * Returns the canonical file path, or `null` on missing file, non-file, or symlink escape.
 */
export function resolveContainedRegularFile(candidatePath: string, rootDir: string): string | null {
  if (!candidatePath || candidatePath.includes("\0") || !NodePath.isAbsolute(candidatePath)) {
    return null;
  }
  let canonicalFile: string;
  let canonicalRoot: string;
  try {
    canonicalFile = NodeFS.realpathSync(candidatePath);
    canonicalRoot = NodeFS.realpathSync(rootDir);
    if (!NodeFS.statSync(canonicalFile).isFile()) return null;
  } catch {
    return null;
  }
  const rel = NodePath.relative(canonicalRoot, canonicalFile);
  if (!rel || rel.startsWith("..") || NodePath.isAbsolute(rel)) return null;
  return canonicalFile;
}

/**
 * Validates that `(version, entryPath)` names a safe version id and that `entryPath` resolves
 * to an existing regular file inside `<root>/versions/<version>` (or equals canonical `allowedEntryPath`).
 */
export function validateWorkerEntryForVersion(input: {
  readonly root: string;
  readonly version: string;
  readonly entryPath: string;
  readonly allowedEntryPath?: string | undefined;
}): string | null {
  if (!isSafeVersionId(input.version)) return null;
  if (!input.entryPath || input.entryPath.includes("\0") || !NodePath.isAbsolute(input.entryPath)) {
    return null;
  }
  const bundleDir = versionBundleDir(input.root, input.version);
  const insideBundle = resolveContainedRegularFile(input.entryPath, bundleDir);
  if (insideBundle) return insideBundle;

  if (input.allowedEntryPath) {
    try {
      const canonicalEntry = NodeFS.realpathSync(input.entryPath);
      const canonicalAllowed = NodeFS.realpathSync(input.allowedEntryPath);
      if (canonicalEntry === canonicalAllowed && NodeFS.statSync(canonicalEntry).isFile()) {
        return canonicalEntry;
      }
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Coordinates version-directory mutations (`stageWorkerVersion`, `submitJob`, `pruneUnreferencedWorkerVersions`)
 * under `<root>/versions/.versions.lock` so concurrent staging/submits cannot race with pruning.
 */
export function withVersionsLock<T>(
  root: string,
  options: {
    readonly self?: ProcessIdentity | undefined;
    readonly isAlive?: IsAlive | undefined;
  },
  fn: () => T,
): { readonly acquired: true; readonly value: T } | { readonly acquired: false } {
  const self = options.self ?? currentProcessIdentity();
  const alive = options.isAlive ?? isProcessAlive;
  const lockPath = versionsLockPath(root);
  if (!claimLock(lockPath, self, alive)) {
    return { acquired: false };
  }
  try {
    return { acquired: true, value: fn() };
  } finally {
    releaseLock(lockPath, self);
  }
}

/**
 * Computes a deterministic runtime version identifier from an entrypoint's canonical path
 * and file contents so symlink swaps or in-place updates yield a distinct version id.
 */
export function computeEntryVersion(entryPath: string): WorkerRuntimeVersion {
  const canonical = resolveCanonicalPath(entryPath);
  const hash = NodeCrypto.createHash("sha256").update(canonical).update("\0");
  try {
    hash.update(NodeFS.readFileSync(canonical));
  } catch {
    // Entry may be virtual in unit tests; canonical path still identifies it.
  }
  return {
    version: `local-${hash.digest("hex").slice(0, 12)}`,
    entryPath: canonical,
  };
}

/** Reads `<root>/versions/current.json` if valid and its entrypoint resolves inside its version bundle (or `allowedEntryPath`). */
export function readCurrentWorkerVersion(
  root: string,
  allowedEntryPath?: string,
): WorkerRuntimeVersion | null {
  const filePath = currentVersionPath(root);
  if (!NodeFS.existsSync(filePath)) return null;
  try {
    const raw = JSON.parse(NodeFS.readFileSync(filePath, "utf8")) as Record<string, unknown>;
    const version = typeof raw.version === "string" ? raw.version.trim() : "";
    const entryPath = typeof raw.entryPath === "string" ? raw.entryPath.trim() : "";
    const stagedAt = typeof raw.stagedAt === "string" ? raw.stagedAt : undefined;
    const verifiedEntry = validateWorkerEntryForVersion({
      root,
      version,
      entryPath,
      allowedEntryPath,
    });
    if (!verifiedEntry) return null;
    return {
      version,
      entryPath: verifiedEntry,
      ...(stagedAt ? { stagedAt } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Resolves the worker runtime version for spawning a new job:
 * 1. Explicit env override (`SHIP_QUEUE_WORKER_VERSION` + `SHIP_QUEUE_WORKER_ENTRY`) if valid & contained
 * 2. Staged pointer `<root>/versions/current.json` if valid & contained
 * 3. Canonicalized fallback CLI path (`computeEntryVersion`)
 */
export function resolveCurrentWorkerVersion(input: {
  readonly root: string;
  readonly fallbackCliPath: string;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
}): WorkerRuntimeVersion {
  const envVersion = input.env?.SHIP_QUEUE_WORKER_VERSION?.trim();
  const envEntry = input.env?.SHIP_QUEUE_WORKER_ENTRY?.trim();
  if (envVersion && envEntry) {
    const verifiedEnvEntry = validateWorkerEntryForVersion({
      root: input.root,
      version: envVersion,
      entryPath: envEntry,
      allowedEntryPath: input.fallbackCliPath,
    });
    if (verifiedEnvEntry) {
      return { version: envVersion, entryPath: verifiedEnvEntry };
    }
  }
  const staged = readCurrentWorkerVersion(input.root, input.fallbackCliPath);
  if (staged) return staged;
  return computeEntryVersion(input.fallbackCliPath);
}

/**
 * Atomically stages a new worker version bundle and flips `<root>/versions/current.json`
 * under `<root>/versions/.versions.lock` without touching or draining any in-flight workers.
 */
export function stageWorkerVersion(input: StageWorkerVersionInput): WorkerRuntimeVersion {
  if (!isSafeVersionId(input.version)) {
    throw new Error(`Invalid worker version id: ${JSON.stringify(input.version)}`);
  }
  const locked = withVersionsLock(input.root, { self: input.self, isAlive: input.isAlive }, () => {
    const baseDir = versionsDir(input.root);
    NodeFS.mkdirSync(baseDir, { recursive: true, mode: 0o700 });

    let resolvedEntry: string;
    const targetDir = versionBundleDir(input.root, input.version);
    if (input.sourceDir) {
      const entryRel = input.entryRelPath ?? "cli.ts";
      if (!isSafeRelativeEntryPath(entryRel)) {
        throw new Error(`Invalid worker entry relative path: ${JSON.stringify(entryRel)}`);
      }
      const stagedEntry = NodePath.join(targetDir, entryRel);
      if (!NodeFS.existsSync(targetDir)) {
        const tmpDir = NodePath.join(
          baseDir,
          `.staging-${input.version}-${process.pid}-${NodeCrypto.randomUUID()}`,
        );
        try {
          NodeFS.cpSync(input.sourceDir, tmpDir, { recursive: true, dereference: false });
          const checkedInTmp = resolveContainedRegularFile(NodePath.join(tmpDir, entryRel), tmpDir);
          if (!checkedInTmp) {
            throw new Error(`Staged bundle entrypoint missing or escapes sourceDir: ${entryRel}`);
          }
          try {
            NodeFS.renameSync(tmpDir, targetDir);
          } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            if (
              (code === "EEXIST" || code === "ENOTEMPTY") &&
              resolveContainedRegularFile(stagedEntry, targetDir)
            ) {
              NodeFS.rmSync(tmpDir, { recursive: true, force: true });
            } else {
              throw err;
            }
          }
        } catch (err) {
          NodeFS.rmSync(tmpDir, { recursive: true, force: true });
          throw err;
        }
      }
      const checked = resolveContainedRegularFile(stagedEntry, targetDir);
      if (!checked) {
        throw new Error(
          `Staged bundle entrypoint missing or escapes version directory: ${stagedEntry}`,
        );
      }
      resolvedEntry = checked;
    } else if (input.entryPath) {
      const containRoot = input.allowedEntryRoot ?? targetDir;
      const checked = resolveContainedRegularFile(input.entryPath, containRoot);
      if (!checked) {
        throw new Error(
          `Worker entrypoint does not resolve to a regular file inside ${containRoot}: ${input.entryPath}`,
        );
      }
      resolvedEntry = checked;
    } else {
      throw new Error("stageWorkerVersion requires either sourceDir or entryPath");
    }

    const record: WorkerRuntimeVersion = {
      version: input.version,
      entryPath: resolvedEntry,
      ...(input.clock ? { stagedAt: input.clock.now() } : {}),
    };
    writeJsonAtomic(currentVersionPath(input.root), record);
    return record;
  });
  if (!locked.acquired) {
    throw new Error("Could not acquire versions lock to stage worker version");
  }
  return locked.value;
}

/** Collects every version id pinned by `current.json`, any open job, or any live worker. */
export function activePinnedVersions(root: string, isAlive: IsAlive): ReadonlySet<string> {
  const pinned = new Set<string>();
  const current = readCurrentWorkerVersion(root);
  if (current) pinned.add(current.version);

  for (const id of listJobIds(root, { open: true })) {
    const job = readJob(root, id);
    if (job && !isEnded(job) && job.worker_version && isSafeVersionId(job.worker_version)) {
      pinned.add(job.worker_version);
    }
  }
  for (const worker of liveVersionedWorkers(root, isAlive)) {
    pinned.add(worker.version);
  }
  return pinned;
}

function listCandidateVersionDirs(dir: string): ReadonlyArray<string> {
  if (!NodeFS.existsSync(dir)) return [];
  const names: string[] = [];
  for (const entry of NodeFS.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".staging-")) continue;
    if (!isSafeVersionId(entry.name)) continue;
    names.push(entry.name);
  }
  return names.toSorted();
}

/**
 * Removes staged bundles under `<root>/versions/` that are no longer referenced by
 * `current.json`, any open/running job, or any live worker process.
 * Coordinates via `<root>/versions/.versions.lock`, enumerates candidates BEFORE reading
 * active pins, and re-checks active pins immediately before each deletion.
 */
export function pruneUnreferencedWorkerVersions(input: {
  readonly root: string;
  readonly isAlive: IsAlive;
  readonly self?: ProcessIdentity | undefined;
  readonly keepVersions?: ReadonlyArray<string> | undefined;
}): PruneWorkerVersionsResult {
  const dir = versionsDir(input.root);
  if (!NodeFS.existsSync(dir)) return { pruned: [], kept: [] };

  const locked = withVersionsLock(
    input.root,
    { self: input.self, isAlive: input.isAlive },
    (): PruneWorkerVersionsResult => {
      // Enumerate candidate directories BEFORE reading active pins to close the stage-vs-prune window.
      const candidates = listCandidateVersionDirs(dir);
      const keepSet = new Set<string>((input.keepVersions ?? []).filter((v) => isSafeVersionId(v)));
      const initialActive = activePinnedVersions(input.root, input.isAlive);

      const pruned: string[] = [];
      const kept: string[] = [];
      for (const name of candidates) {
        if (keepSet.has(name) || initialActive.has(name)) {
          kept.push(name);
          continue;
        }
        // Re-check active pins right before unlinking to defend against uncoordinated readers.
        if (activePinnedVersions(input.root, input.isAlive).has(name)) {
          kept.push(name);
          continue;
        }
        NodeFS.rmSync(NodePath.join(dir, name), { recursive: true, force: true });
        pruned.push(name);
      }
      return { pruned, kept };
    },
  );

  if (!locked.acquired) {
    return { pruned: [], kept: listCandidateVersionDirs(dir), skippedLocked: true };
  }
  return locked.value;
}

/**
 * Determines whether a worker running `selfVersion` is allowed to advance `job`.
 * - Pinned jobs only run on their pinned worker version.
 * - Unpinned jobs run on the current worker version (never pulled into an older worker after upgrade).
 */
export function jobMatchesWorkerVersion(
  job: JobRecord,
  selfVersion: string | undefined,
  currentVersion: string | undefined,
): boolean {
  if (!selfVersion) return true;
  if (job.worker_version) return job.worker_version === selfVersion;
  return !currentVersion || currentVersion === selfVersion;
}
