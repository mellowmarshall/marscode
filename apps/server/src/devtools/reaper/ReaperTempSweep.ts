// @effect-diagnostics nodeBuiltinImport:off - Socket-aware stale /tmp and /data/Dev/<repo> exhaust sweep.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { inside, type PathGuard } from "./ReaperPathGuard.ts";
import {
  diskBytes,
  forceRemove,
  gitDataAtRoot,
  gitDataIn,
  hasRecentEntry,
  lstatDevice,
  onRootDevice,
  type DeviceOf,
} from "./ReaperTreeOps.ts";
import type { ReaperLog } from "./ReaperTypes.ts";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/**
 * mktemp's `.XXXXXX`: six random letters/digits. A digit, or an upper-case letter after the
 * first, marks it; a word in any case (`.backup`, `.Golden`, `.ASSETS`) never matches.
 */
export function isMktempName(name: string): boolean {
  const suffix = /\.([A-Za-z0-9]{6})$/.exec(name)?.[1];
  if (suffix === undefined) return false;
  return /\d/.test(suffix) || (/[a-z]/.test(suffix) && /[A-Z]/.test(suffix.slice(1)));
}
const EXHAUST_RE =
  /(?:^\d+-|(?:^|-)(?:evidence|validation|proof|frames|shots|walk|scratch|audit|bench|bundle|work|notes)(?:-|$|\.))/;
/** Shared caches and tools under /data/Dev/<repo> that look like exhaust but are not. */
const SHARED_KEEP = new Set([
  "avd",
  "avd-cache",
  "devlease-avds",
  "pyenv",
  "skin-engine",
  "eas-update",
  "android-development-client",
  "tools",
  "fsq-2026-08-11",
  "local-builds",
  "native-contract-cache",
  "_branch-archive",
  "cargo-home",
  "go-build",
  "go-cache",
  "go-mod",
  "go-path",
  "uv-cache",
  "uv-tools",
  "tool-cache",
  "sysroot-webkit",
  "muse-recovery",
  "browser-cache",
  "tooling",
]);
const SKIPPED_REPOS = new Set(["model-lab", "security-sweeps", "npm-cache", "pnpm-store"]);
/** Persistent evidence/test lanes whose run folders are reaped one by one. */
const CONTAINER_DIRS = new Set(["evidence", "test-client"]);

export interface SweepContext {
  readonly uid: number;
  readonly nowMs: number;
  readonly guard: PathGuard;
  readonly dryRun: boolean;
  readonly log: ReaperLog;
  /** Device lookup for the mount-point guard; lstat unless a test stands in a mount. */
  readonly deviceOf?: DeviceOf;
}

export interface TmpSweepResult {
  readonly roots: ReadonlyArray<string>;
  dirs: number;
  files: number;
  bytes: number;
  skippedActive: number;
}

async function isPlainDir(p: string): Promise<boolean> {
  const st = await NodeFSP.lstat(p).catch(() => null);
  return st !== null && st.isDirectory();
}

async function lexists(p: string): Promise<boolean> {
  return (await NodeFSP.lstat(p).catch(() => null)) !== null;
}

async function listSorted(dir: string): Promise<string[]> {
  return (await NodeFSP.readdir(dir).catch(() => [] as string[])).toSorted();
}

/** /tmp, macOS's temp folders, /data/tmp and each /data/Dev/<repo>/tmp that is not a checkout. */
export async function tmpCandidateRoots(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  devRoot = "/data/Dev",
): Promise<string[]> {
  const roots = ["/tmp"];
  if (platform === "darwin") {
    roots.push("/private/tmp");
    if (env.TMPDIR && (await isPlainDir(env.TMPDIR))) roots.push(env.TMPDIR);
  }
  if (await isPlainDir("/data/tmp")) roots.push("/data/tmp");
  for (const repo of await listSorted(devRoot)) {
    const repoTmp = NodePath.join(devRoot, repo, "tmp");
    if ((await isPlainDir(repoTmp)) && !(await lexists(NodePath.join(devRoot, repo, ".git")))) {
      roots.push(repoTmp);
    }
  }
  return roots;
}

/**
 * Removes the user's top-level entries older than maxAgeHours in each root. Never one a live
 * process holds: its cwd, an open file, or a bound unix socket at it, inside it or above it.
 */
export async function sweepTmpRoots(
  roots: ReadonlyArray<string>,
  ctx: SweepContext,
  maxAgeHours = 24,
): Promise<TmpSweepResult> {
  const cutoff = ctx.nowMs - maxAgeHours * HOUR_MS;
  const seen = new Set<string>();
  const result: TmpSweepResult = { roots: [], dirs: 0, files: 0, bytes: 0, skippedActive: 0 };
  const scanned: string[] = [];
  for (const root of roots) {
    const realRoot = await NodeFSP.realpath(root).catch(() => null);
    if (realRoot === null || seen.has(realRoot) || !(await isPlainDir(realRoot))) continue;
    seen.add(realRoot);
    const rootGit = await gitDataAtRoot(realRoot);
    if (rootGit !== null) {
      ctx.log(`  Skipped temp root ${realRoot}: it holds ${rootGit}`);
      continue;
    }
    scanned.push(realRoot);
    for (const name of await listSorted(realRoot)) {
      const target = NodePath.join(realRoot, name);
      const st = await NodeFSP.lstat(target).catch(() => null);
      if (st === null || st.uid !== ctx.uid || st.mtimeMs >= cutoff) continue;
      if (ctx.guard.isProtected(target)) {
        result.skippedActive += 1;
        continue;
      }
      const isDir = st.isDirectory();
      if (!(await onRootDevice(target, realRoot, ctx.deviceOf ?? lstatDevice))) continue;
      if (isDir && (await hasRecentEntry(target, cutoff))) continue;
      const gitData = await gitDataIn(target);
      if (gitData !== null) {
        ctx.log(`  Kept stale temp ${target}: it holds ${gitData}`);
        continue;
      }
      const bytes = isDir ? await diskBytes(target) : st.blocks * 512;
      if (!ctx.dryRun && !(await forceRemove(target))) continue;
      if (isDir) result.dirs += 1;
      else result.files += 1;
      result.bytes += bytes;
    }
  }
  if (!ctx.dryRun) {
    ctx.log(
      `Cleaned stale temp (> ${maxAgeHours}h): ${result.dirs} dirs, ${result.files} files, ` +
        `${(result.bytes / 1024 ** 2).toFixed(1)} MB (active skipped: ${result.skippedActive})`,
    );
  }
  return { ...result, roots: scanned };
}

async function staleExhaustDir(
  target: string,
  name: string,
  root: string,
  ctx: SweepContext,
  cutoffs: { readonly tmp: number; readonly exhaust: number },
): Promise<boolean> {
  const st = await NodeFSP.lstat(target).catch(() => null);
  if (st === null || st.uid !== ctx.uid || !st.isDirectory()) return false;
  if (!(await onRootDevice(target, root, ctx.deviceOf ?? lstatDevice))) return false;
  const cutoff = isMktempName(name) ? cutoffs.tmp : cutoffs.exhaust;
  if (st.mtimeMs >= cutoff || (await hasRecentEntry(target, cutoff, { gitIsRecent: true }))) {
    return false;
  }
  const gitData = await gitDataIn(target);
  if (gitData !== null) {
    ctx.log(`  Kept stale exhaust ${target}: it holds ${gitData}`);
    return false;
  }
  return !ctx.guard.isProtected(await NodeFSP.realpath(target).catch(() => target));
}

/**
 * Leaked mktemp folders (older than maxAgeHours) and stale no-git exhaust folders (older than
 * exhaustDays) under each <devRoot>/<repo> that is not itself a checkout.
 */
export async function sweepDevExhaust(
  devRoot: string,
  ctx: SweepContext,
  options: { readonly maxAgeHours?: number; readonly exhaustDays?: number } = {},
): Promise<number> {
  if (!(await isPlainDir(devRoot))) return 0;
  const cutoffs = {
    tmp: ctx.nowMs - (options.maxAgeHours ?? 24) * HOUR_MS,
    exhaust: ctx.nowMs - (options.exhaustDays ?? 7) * DAY_MS,
  };
  const skipRoot = async (root: string) => {
    const rootGit = await gitDataAtRoot(root);
    if (rootGit !== null) ctx.log(`  Skipped exhaust root ${root}: it holds ${rootGit}`);
    return rootGit !== null;
  };
  if (await skipRoot(devRoot)) return 0;
  let reaped = 0;
  const remove = async (target: string, label: string) => {
    if (ctx.dryRun || (await forceRemove(target))) {
      reaped += 1;
      ctx.log(`  ${ctx.dryRun ? "Would remove" : "Removed"} stale ${label} ${target}`);
    }
  };
  for (const repo of await listSorted(devRoot)) {
    if (repo.startsWith(".") || SKIPPED_REPOS.has(repo)) continue;
    const repoDir = NodePath.join(devRoot, repo);
    if (!(await isPlainDir(repoDir)) || (await skipRoot(repoDir))) continue;
    for (const name of await listSorted(repoDir)) {
      if (name.startsWith(".") || SHARED_KEEP.has(name)) continue;
      const target = NodePath.join(repoDir, name);
      if (CONTAINER_DIRS.has(name)) {
        if (!(await isPlainDir(target)) || (await skipRoot(target))) continue;
        for (const child of await listSorted(target)) {
          if (child.startsWith(".") || SHARED_KEEP.has(child)) continue;
          const run = NodePath.join(target, child);
          if (inside(run, target) && (await staleExhaustDir(run, child, devRoot, ctx, cutoffs))) {
            await remove(run, "container run");
          }
        }
        continue;
      }
      if (
        (isMktempName(name) || EXHAUST_RE.test(name)) &&
        (await staleExhaustDir(target, name, devRoot, ctx, cutoffs))
      ) {
        await remove(target, "exhaust");
      }
    }
  }
  if (reaped > 0) ctx.log(`Cleaned ${reaped} stale no-git exhaust/mktemp dirs under ${devRoot}`);
  return reaped;
}
