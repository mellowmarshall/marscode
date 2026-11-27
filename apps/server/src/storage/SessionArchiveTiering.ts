// @effect-diagnostics nodeBuiltinImport:off - Verified session archive tiering: copy, byte-compare and fsync, then move.
import type * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { SessionArchiveSettings, StorageCleanupReportEntry } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import {
  ephemeralRootsFromEntries,
  sweepEphemeralRoots,
} from "../devtools/reaper/ReaperEphemeralSweep.ts";
import {
  manifestHistoryRoots,
  PathGuard,
  reapableEphemeralEntries,
} from "../devtools/reaper/ReaperPathGuard.ts";
import {
  scanProcessPaths,
  trustedScan,
  type ProcPathScan,
} from "../devtools/reaper/ReaperProcPaths.ts";
import type { StorageManifest, StorageManifestEntry } from "../devtools/StorageManifest.ts";
import { ARCHIVE_PROBE_TIMEOUT_MS, runArchiveFsOp } from "../usage/usageArchiveFsGuard.ts";
import { probeArchiveRoot } from "../usage/usageArchiveWalk.ts";
import {
  ArchiveChangedError,
  archiveDevice,
  ArchiveMount,
  createArchiveRemoteShareCheck,
  updateRemoteLink,
  type ArchiveDeviceOf,
  type ArchiveShareCheck,
} from "./SessionArchiveMount.ts";

const DAY_MS = 86_400_000;
const CHUNK_BYTES = 1024 * 1024;
const MIN_COPY_TIMEOUT_MS = 30_000;
/** A share slower than 1 MB/s times out rather than holding the cleanup sweep. */
const COPY_BYTES_PER_MS = 1_000;
const MAX_FAILURE_ENTRIES = 20;
/** A session written within this window is likely still in use; the next pass copies it. */
const SETTLE_MS = 3_600_000;
const CODEX_DATE_RE = /^rollout-(\d{4})-(\d{2})-(\d{2})T/;

export class SessionArchivePassError extends Schema.TaggedError<SessionArchivePassError>()(
  "SessionArchivePassError",
  { cause: Schema.Defect() },
) {
  override get message() {
    return this.cause instanceof Error ? this.cause.message : String(this.cause);
  }
}

export interface SessionArchivePassInput {
  readonly settings: SessionArchiveSettings;
  readonly manifest: StorageManifest;
  readonly host: string;
  readonly homeDir: string;
  readonly uid: number;
  readonly platform: NodeJS.Platform;
  readonly nowMs: number;
  /** Live-process paths; the default reads /proc or lsof. Null or blind means no pass. */
  readonly processScan?: () => Promise<ProcPathScan | null>;
  /** Accept an archive folder that is not a mount point (a local test folder). */
  readonly allowLocalArchiveRoot?: boolean;
  /** Device lookup for the archive mount guard; a bounded stat unless a test stands in. */
  readonly archiveDeviceOf?: ArchiveDeviceOf;
  /** Filesystem-type check for the archive mount guard; bounded statfs/mount unless a test stands in. */
  readonly archiveIsRemoteShare?: ArchiveShareCheck;
  /** Runs between the copy and the move phases; tests write to a session here. */
  readonly afterCopy?: () => Promise<void>;
}

interface PassCounts {
  scanned: number;
  mirrored: number;
  moved: number;
  freedBytes: number;
  skippedOpen: number;
  skippedChanged: number;
  skippedSameFile: number;
  failures: Array<{ readonly path: string; readonly reason: string }>;
}

const entry = (
  outcome: StorageCleanupReportEntry["outcome"],
  reason: string,
  extra: Partial<Pick<StorageCleanupReportEntry, "path" | "bytes" | "files">> = {},
): StorageCleanupReportEntry => ({
  kind: "session-archive",
  outcome,
  reason,
  path: extra.path ?? null,
  projectPath: null,
  threadId: null,
  threadTitle: null,
  bytes: extra.bytes ?? null,
  files: extra.files ?? null,
});

/** Age from a Codex rollout's file name when it has a date, else from mtime. */
export function sessionAgeDays(fileName: string, mtimeMs: number, nowMs: number): number {
  const match = CODEX_DATE_RE.exec(fileName);
  const stampMs = match
    ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12)
    : mtimeMs;
  return Math.max(0, (nowMs - stampMs) / DAY_MS);
}

/** Byte-for-byte comparison of two files, chunk by chunk. */
export async function sameBytes(left: string, right: string): Promise<boolean> {
  const [a, b] = await Promise.all([NodeFSP.open(left, "r"), NodeFSP.open(right, "r")]);
  try {
    const [sa, sb] = await Promise.all([a.stat(), b.stat()]);
    if (sa.size !== sb.size) return false;
    const bufA = Buffer.alloc(CHUNK_BYTES);
    const bufB = Buffer.alloc(CHUNK_BYTES);
    for (let offset = 0; offset < sa.size; offset += CHUNK_BYTES) {
      const [ra, rb] = await Promise.all([
        a.read(bufA, 0, CHUNK_BYTES, offset),
        b.read(bufB, 0, CHUNK_BYTES, offset),
      ]);
      if (
        ra.bytesRead !== rb.bytesRead ||
        !bufA.subarray(0, ra.bytesRead).equals(bufB.subarray(0, rb.bytesRead))
      ) {
        return false;
      }
    }
    return true;
  } finally {
    await Promise.all([a.close(), b.close()]);
  }
}

async function fsyncDir(dir: string): Promise<void> {
  const handle = await NodeFSP.open(dir, "r").catch(() => null);
  // Some shares refuse a directory fsync; the file itself is already synced.
  await handle?.sync().catch(() => undefined);
  await handle?.close();
}

/** Copies to a temp name beside dest, fsyncs, compares every byte, then renames into place. */
async function copyVerified(source: string, dest: string, mtime: Date): Promise<void> {
  const tmp = NodePath.join(
    NodePath.dirname(dest),
    `.${NodePath.basename(dest)}.${process.pid}.partial`,
  );
  try {
    await NodeFSP.copyFile(source, tmp);
    const handle = await NodeFSP.open(tmp, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (!(await sameBytes(source, tmp))) throw new Error("archive copy does not match the session");
    await NodeFSP.utimes(tmp, mtime, mtime);
    await NodeFSP.rename(tmp, dest);
    await fsyncDir(NodePath.dirname(dest));
  } catch (error) {
    await NodeFSP.rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function listSessionFiles(
  root: string,
  extensions: ReadonlyArray<string>,
): Promise<string[]> {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const child of await NodeFSP.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const target = NodePath.join(dir, child.name);
      if (child.isDirectory()) stack.push(target);
      else if (child.isFile() && extensions.some((ext) => child.name.endsWith(ext)))
        out.push(target);
    }
  }
  return out;
}

const isArchiveChanged = Schema.is(ArchiveChangedError);

const archiveOp = <A>(fn: () => Promise<A>, bytes: number, label: string) =>
  runArchiveFsOp(fn, Math.max(MIN_COPY_TIMEOUT_MS, bytes / COPY_BYTES_PER_MS), label);

interface MoveCandidate {
  readonly file: string;
  readonly dest: string;
  readonly seen: NodeFS.Stats;
}

const unchanged = (now: NodeFS.Stats | null, seen: NodeFS.Stats) =>
  now !== null &&
  now.isFile() &&
  now.size === seen.size &&
  now.mtimeMs === seen.mtimeMs &&
  now.ino === seen.ino &&
  now.dev === seen.dev;

const isOpen = async (file: string, scan: ProcPathScan) =>
  scan.paths.has(await NodeFSP.realpath(file).catch(() => file));

/** Phase one: copy and verify one closed, settled session; a move candidate when it is old. */
async function mirrorFile(
  file: string,
  dest: string,
  input: SessionArchivePassInput,
  scan: ProcPathScan,
  mount: ArchiveMount,
  counts: PassCounts,
): Promise<MoveCandidate | null> {
  counts.scanned += 1;
  const local = await NodeFSP.lstat(file);
  if (!local.isFile() || input.nowMs - local.mtimeMs < SETTLE_MS) return null;
  if (await isOpen(file, scan)) {
    counts.skippedOpen += 1;
    return null;
  }
  const remote = await archiveOp(() => NodeFSP.stat(dest).catch(() => null), 0, "archive stat");
  // A copy this pass verified keeps the session's mtime, so a matching size and mtime is that copy.
  if (
    remote === null ||
    remote.size !== local.size ||
    Math.abs(remote.mtimeMs - local.mtimeMs) >= 1
  ) {
    await mount.ensureDir(NodePath.dirname(dest));
    await mount.assertOnline();
    await archiveOp(() => copyVerified(file, dest, local.mtime), local.size * 2, "archive copy");
    counts.mirrored += 1;
  }
  if (input.settings.mode !== "move") return null;
  const ageDays = sessionAgeDays(NodePath.basename(file), local.mtimeMs, input.nowMs);
  return ageDays > input.settings.localKeepDays ? { file, dest, seen: local } : null;
}

/** True when both paths name one file: removing the source would remove the archive copy. */
async function sameFile(file: string, dest: string): Promise<boolean> {
  const [src, dst] = await Promise.all([
    NodeFSP.stat(file).catch(() => null),
    archiveOp(() => NodeFSP.stat(dest).catch(() => null), 0, "archive stat"),
  ]);
  if (src === null || dst === null) return true;
  if (src.dev === dst.dev && src.ino === dst.ino) return true;
  const [realSrc, realDst] = await Promise.all([
    NodeFSP.realpath(file).catch(() => file),
    archiveOp(() => NodeFSP.realpath(dest).catch(() => dest), 0, "archive realpath"),
  ]);
  return realSrc === realDst;
}

/**
 * Phase two: takes one verified session off local disk. It must be unchanged since its copy
 * (size, mtime, inode), closed in a fresh scan, a different file from its copy, and still
 * byte-equal to it; the share must still be the one probed. Then it is removed, or replaced
 * by a link to its copy with `symlinkTiered`.
 */
async function moveFile(
  candidate: MoveCandidate,
  input: SessionArchivePassInput,
  scan: ProcPathScan,
  mount: ArchiveMount,
  counts: PassCounts,
): Promise<void> {
  const { file, dest, seen } = candidate;
  if (!unchanged(await NodeFSP.lstat(file).catch(() => null), seen) || (await isOpen(file, scan))) {
    counts.skippedChanged += 1;
    return;
  }
  if (await sameFile(file, dest)) {
    counts.skippedSameFile += 1;
    return;
  }
  await mount.assertOnline();
  if (!(await archiveOp(() => sameBytes(file, dest), seen.size * 2, "archive verify"))) {
    throw new Error("archive copy no longer matches the session");
  }
  if (!unchanged(await NodeFSP.lstat(file).catch(() => null), seen)) {
    counts.skippedChanged += 1;
    return;
  }
  await mount.assertOnline();
  if (input.settings.symlinkTiered) {
    const link = NodePath.join(
      NodePath.dirname(file),
      `.${NodePath.basename(file)}.${process.pid}.link`,
    );
    await NodeFSP.rm(link, { force: true });
    await NodeFSP.symlink(dest, link);
    await NodeFSP.lutimes(link, seen.mtime, seen.mtime).catch(() => undefined);
    await NodeFSP.rename(link, file);
  } else {
    await NodeFSP.unlink(file);
  }
  counts.moved += 1;
  counts.freedBytes += seen.blocks * 512;
}

/**
 * The folder under `<archiveRoot>/<host>/` a source tiers to. The default Codex and Claude
 * homes keep the share's existing `codex` and `claude` folders, which usage history reads.
 */
function archiveSubdir(source: StorageManifestEntry): string {
  if (source.id === "codex:codex:sessions") return "codex";
  if (source.id === "claudeAgent:claudeAgent:projects") return "claude";
  return source.id.replace(/[^A-Za-z0-9._-]+/g, "_");
}

function archiveSources(manifest: StorageManifest): ReadonlyArray<StorageManifestEntry> {
  return manifest.entries.filter(
    (e) => e.trust === "history" && e.kind === "session-files" && e.tierAction === "move",
  );
}

/** Codex temp folders and every provider's shell snapshots, with this host's ages. */
function hygieneRoots(input: SessionArchivePassInput) {
  return ephemeralRootsFromEntries(
    reapableEphemeralEntries(input.manifest)
      .filter(
        (e) => e.kind === "shell-snapshots" || (e.provider === "codex" && e.kind === "temp-dir"),
      )
      .map((e) => ({
        ...e,
        maxAgeHours:
          e.kind === "shell-snapshots"
            ? input.settings.shellSnapshotsAfterDays * 24
            : input.settings.codexTmpAfterHours,
      })),
  );
}

/**
 * One pass for this host: sweeps Codex temp and shell snapshots, mirrors every closed session
 * file to `<archiveRoot>/<host>/<source>/`, and in `move` mode takes sessions older than
 * localKeepDays off local disk once their copy is verified. Nothing is removed without a
 * trusted live-process scan, and nothing is written unless the share is the one probed.
 */
export async function runSessionArchivePass(
  input: SessionArchivePassInput,
): Promise<StorageCleanupReportEntry[]> {
  const { settings } = input;
  if (settings.mode === "off" || settings.archiveRoot === "") return [];
  const readScan =
    input.processScan ?? (() => scanProcessPaths({ uid: input.uid, platform: input.platform }));
  const scan = await readScan();
  if (!trustedScan(scan)) {
    return [
      entry("kept", "Could not read live processes; nothing archived or removed", {
        path: settings.archiveRoot,
      }),
    ];
  }
  const entries: StorageCleanupReportEntry[] = [];
  const historyRoots = await manifestHistoryRoots(input.manifest);
  const hygiene = await sweepEphemeralRoots(hygieneRoots(input), {
    uid: input.uid,
    nowMs: input.nowMs,
    guard: new PathGuard([...scan.paths, ...historyRoots]),
    dryRun: false,
    log: () => undefined,
    homeDir: input.homeDir,
    historyRoots,
  });
  if (hygiene.removed > 0) {
    entries.push(
      entry("removed", `Removed ${hygiene.removed} stale Codex temp and shell snapshot items`, {
        bytes: hygiene.bytes,
        files: hygiene.removed,
      }),
    );
  }
  const probe = await probeArchiveRoot(settings.archiveRoot, {
    nowMs: input.nowMs,
    timeoutMs: ARCHIVE_PROBE_TIMEOUT_MS,
  });
  const mount = probe.accessible
    ? await ArchiveMount.open({
        archiveRoot: settings.archiveRoot,
        host: input.host,
        homeDir: input.homeDir,
        platform: input.platform,
        allowLocal: input.allowLocalArchiveRoot === true,
        deviceOf: input.archiveDeviceOf ?? archiveDevice,
        isRemoteShare: input.archiveIsRemoteShare ?? createArchiveRemoteShareCheck(input.platform),
      })
    : probe.reason;
  if (typeof mount === "string") {
    entries.push(
      entry("kept", `Session archive unavailable (${mount}); sessions stay local`, {
        path: settings.archiveRoot,
      }),
    );
    return entries;
  }
  await updateRemoteLink(input.homeDir, mount.hostDir);
  const counts: PassCounts = {
    scanned: 0,
    mirrored: 0,
    moved: 0,
    freedBytes: 0,
    skippedOpen: 0,
    skippedChanged: 0,
    skippedSameFile: 0,
    failures: [],
  };
  const fail = (path: string) => (error: unknown) => {
    if (isArchiveChanged(error)) throw error;
    counts.failures.push({ path, reason: error instanceof Error ? error.message : String(error) });
    return null;
  };
  try {
    const candidates: MoveCandidate[] = [];
    for (const source of archiveSources(input.manifest)) {
      const destRoot = NodePath.join(mount.hostDir, archiveSubdir(source));
      for (const file of await listSessionFiles(source.path, source.extensions ?? [".jsonl"])) {
        const dest = NodePath.join(destRoot, NodePath.relative(source.path, file));
        const candidate = await mirrorFile(file, dest, input, scan, mount, counts).catch(
          fail(file),
        );
        if (candidate !== null) candidates.push(candidate);
      }
    }
    await input.afterCopy?.();
    // A fresh scan: a session opened since the copy phase must stay.
    const moveScan = candidates.length > 0 ? await readScan() : null;
    if (candidates.length > 0 && !trustedScan(moveScan)) {
      counts.failures.push({
        path: mount.hostDir,
        reason: "Could not re-read live processes; nothing moved",
      });
    } else if (moveScan !== null) {
      for (const candidate of candidates) {
        await moveFile(candidate, input, moveScan, mount, counts).catch(fail(candidate.file));
      }
    }
  } catch (error) {
    if (!isArchiveChanged(error)) throw error;
    counts.failures.push({ path: mount.archiveRoot, reason: error.message });
  }
  entries.push(
    entry(
      counts.moved > 0 ? "removed" : "kept",
      `Archived to ${mount.hostDir}: ${counts.mirrored} copied, ${counts.moved} moved to the archive, ` +
        `${counts.skippedOpen} open sessions skipped, ${counts.skippedChanged} changed since copy, ` +
        `${counts.skippedSameFile} already the archive copy, ${counts.scanned} checked`,
      {
        path: mount.hostDir,
        ...(counts.moved > 0 ? { bytes: counts.freedBytes, files: counts.moved } : {}),
      },
    ),
    ...counts.failures
      .slice(0, MAX_FAILURE_ENTRIES)
      .map((f) => entry("failed", f.reason, { path: f.path })),
  );
  return entries;
}
