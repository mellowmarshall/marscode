// @effect-diagnostics nodeBuiltinImport:off - Stale Cargo build output: 14-day empty and 7-day incremental rules with in-use checks.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { serviceNamedPaths, type NamedPathSources } from "./ReaperCargoInUse.ts";
import { inside, PathGuard } from "./ReaperPathGuard.ts";
import { scanProcessPaths, trustedScan, type ProcPathScan } from "./ReaperProcPaths.ts";
import { diskBytes, forceRemove, hasRecentEntry, holdsMount } from "./ReaperTreeOps.ts";
import type { ReaperCargoItem, ReaperCargoResult, ReaperLog } from "./ReaperTypes.ts";

const DAY_MS = 86_400_000;
const CARGO_FULL_DAYS = 14;
const CARGO_INCREMENTAL_DAYS = 7;
const MAX_DEPTH = 6;
const MAX_ITEMS = 200;
const PRUNE = new Set(["node_modules", ".git", ".venv", "cargo-home", ".cargo", ".rustup"]);
/** A folder with one of these at its top is a project that also holds build output, never a build folder. */
const SOURCE_MARKERS = ["Cargo.toml", "Cargo.lock", ".git", "src"];
const SESSION_RE = /^.+-[0-9a-z]+$/;

const lstatOrNull = (p: string) => NodeFSP.lstat(p).catch(() => null);
const isPlainDir = async (p: string) => (await lstatOrNull(p))?.isDirectory() === true;

export async function defaultCargoRoots(
  homeDir: string,
  env: NodeJS.ProcessEnv,
): Promise<string[]> {
  const candidates = [
    "/data/Dev",
    NodePath.join(homeDir, "Dev-data"),
    NodePath.join(homeDir, "Dev"),
    ...(env.CARGO_TARGET_DIR ? [env.CARGO_TARGET_DIR] : []),
    "/data/private-repo/cargo-target",
  ];
  const out: string[] = [];
  for (const root of candidates) {
    if ((await NodeFSP.stat(root).catch(() => null))?.isDirectory() === true) out.push(root);
  }
  return out;
}

/** CARGO_HOME and RUSTUP_HOME by real path: never entered. */
async function toolchainHomes(homeDir: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  const homes = [
    env.CARGO_HOME || NodePath.join(homeDir, ".cargo"),
    env.RUSTUP_HOME || NodePath.join(homeDir, ".rustup"),
  ];
  return Promise.all(homes.map((h) => NodeFSP.realpath(h).catch(() => h)));
}

/** Profile folders (holding `deps` and `.fingerprint`) at most three levels down. */
async function profileDirs(buildDir: string): Promise<string[]> {
  const found: string[] = [];
  let level = [buildDir];
  for (let depth = 0; depth < 3; depth += 1) {
    const next: string[] = [];
    for (const parent of level) {
      for (const entry of await NodeFSP.readdir(parent, { withFileTypes: true }).catch(() => [])) {
        if (!entry.isDirectory()) continue;
        const child = NodePath.join(parent, entry.name);
        if (
          (await isPlainDir(NodePath.join(child, "deps"))) &&
          (await isPlainDir(NodePath.join(child, ".fingerprint")))
        ) {
          found.push(child);
        } else {
          next.push(child);
        }
      }
    }
    level = next;
  }
  return found;
}

async function isBuildDir(p: string): Promise<boolean> {
  for (const marker of SOURCE_MARKERS) {
    if ((await lstatOrNull(NodePath.join(p, marker))) !== null) return false;
  }
  const info = await lstatOrNull(NodePath.join(p, ".rustc_info.json"));
  return info?.isFile() === true && (await profileDirs(p)).length > 0;
}

/** Build folders at most maxDepth below each root, by real path; no link followed, no mount crossed. */
async function findBuildDirs(
  roots: ReadonlyArray<string>,
  skip: ReadonlyArray<string>,
  maxDepth = MAX_DEPTH,
): Promise<string[]> {
  const found = new Set<string>();
  const seen = new Set<string>();
  for (const root of roots) {
    const real = await NodeFSP.realpath(root).catch(() => null);
    if (real === null || skip.some((s) => inside(real, s))) continue;
    const rootStat = await NodeFSP.stat(real).catch(() => null);
    if (rootStat?.isDirectory() !== true) continue;
    const stack: Array<[string, number]> = [[real, 0]];
    while (stack.length > 0) {
      const [dir, depth] = stack.pop()!;
      if (seen.has(dir)) continue;
      seen.add(dir);
      if (await isBuildDir(dir)) {
        found.add(dir);
        continue;
      }
      if (depth >= maxDepth) continue;
      for (const entry of await NodeFSP.readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const child = NodePath.join(dir, entry.name);
        if (PRUNE.has(entry.name) || !entry.isDirectory() || skip.includes(child)) continue;
        if ((await lstatOrNull(child))?.dev === rootStat.dev) stack.push([child, depth + 1]);
      }
    }
  }
  return [...found];
}

/** What the empty rule keeps: each profile's `.cargo-lock` and the folders that lead to it. */
async function keptPaths(buildDir: string): Promise<Set<string>> {
  const kept = new Set<string>();
  for (const profile of await profileDirs(buildDir)) {
    const lock = NodePath.join(profile, ".cargo-lock");
    if ((await lstatOrNull(lock))?.isFile() !== true) continue;
    kept.add(lock);
    for (let d = profile; d !== buildDir && inside(d, buildDir); d = NodePath.dirname(d))
      kept.add(d);
  }
  return kept;
}

async function emptyTree(dir: string, kept: ReadonlySet<string>, buildReal: string): Promise<void> {
  for (const entry of await NodeFSP.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const child = NodePath.join(dir, entry.name);
    if (entry.isDirectory() && kept.has(child)) {
      await emptyTree(child, kept, buildReal);
    } else if (!kept.has(child)) {
      const real = entry.isSymbolicLink()
        ? child
        : await NodeFSP.realpath(child).catch(() => child);
      if (inside(real, buildReal) && real !== buildReal) await forceRemove(child);
    }
  }
}

async function leftEntries(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await NodeFSP.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const child = NodePath.join(dir, entry.name);
    out.push(child);
    if (entry.isDirectory()) out.push(...(await leftEntries(child)));
  }
  return out;
}

export interface CargoReapOptions {
  readonly roots: ReadonlyArray<string>;
  readonly uid: number;
  readonly platform: NodeJS.Platform;
  readonly homeDir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly nowMs: number;
  readonly dryRun: boolean;
  readonly log: ReaperLog;
  readonly fullDays?: number;
  readonly incrementalDays?: number;
  readonly processScan?: () => Promise<ProcPathScan | null>;
  readonly namedPaths?: NamedPathSources;
}

interface Totals {
  removed: number;
  removedBytes: number;
  incremental: number;
  incrementalBytes: number;
  skippedInUse: number;
  items: ReaperCargoItem[];
}

async function reapIncremental(
  buildDir: string,
  cutoff: number,
  dryRun: boolean,
  totals: Totals,
): Promise<void> {
  for (const profile of await profileDirs(buildDir)) {
    const incr = NodePath.join(profile, "incremental");
    const incrStat = await lstatOrNull(incr);
    // A linked incremental/ is never followed: its sessions are not this folder's.
    if (incrStat?.isDirectory() !== true) continue;
    let removedAny = false;
    for (const name of (await NodeFSP.readdir(incr).catch(() => [] as string[])).toSorted()) {
      const session = NodePath.join(incr, name);
      if (!SESSION_RE.test(name) || !(await isPlainDir(session))) continue;
      if (await hasRecentEntry(session, cutoff)) continue;
      const bytes = await diskBytes(session);
      if (!dryRun && !(await forceRemove(session))) continue;
      removedAny = true;
      totals.incremental += 1;
      totals.incrementalBytes += bytes;
      totals.items.push({
        kind: "incremental",
        action: dryRun ? "would-remove" : "removed",
        path: session,
        bytes,
      });
    }
    // Keep incremental/'s own mtime so the empty rule still sees when the folder was last built.
    if (removedAny && !dryRun) {
      await NodeFSP.utimes(incr, incrStat.atimeMs / 1000, incrStat.mtimeMs / 1000).catch(
        () => undefined,
      );
    }
  }
}

function result(
  dryRun: boolean,
  buildDirs: number,
  totals: Totals,
  aborted: string | null,
): ReaperCargoResult {
  return {
    dry_run: dryRun,
    build_dirs: buildDirs,
    removed: totals.removed,
    removed_bytes: totals.removedBytes,
    incremental: totals.incremental,
    incremental_bytes: totals.incrementalBytes,
    skipped_in_use: totals.skippedInUse,
    aborted_reason: aborted,
    items: totals.items.slice(0, MAX_ITEMS),
  };
}

/**
 * Empties each build folder of the user's that nothing changed for fullDays, and removes
 * incremental sessions unchanged for incrementalDays in the rest. A folder is skipped whole
 * when a process holds a path in it (cwd, open file, mapping, executable; cargo holds its
 * `.cargo-lock` open while it builds), a service names a path in it, or it holds a mount point.
 */
export async function reapCargo(options: CargoReapOptions): Promise<ReaperCargoResult> {
  const totals: Totals = {
    removed: 0,
    removedBytes: 0,
    incremental: 0,
    incrementalBytes: 0,
    skippedInUse: 0,
    items: [],
  };
  const builds = await findBuildDirs(
    options.roots,
    await toolchainHomes(options.homeDir, options.env),
  );
  if (builds.length === 0) return result(options.dryRun, 0, totals, null);
  const live = await (
    options.processScan ??
    (() =>
      scanProcessPaths({ uid: options.uid, platform: options.platform, includeMappings: true }))
  )();
  if (!trustedScan(live)) {
    const reason = live === null ? "the live-process scan failed" : "read no process but this one";
    options.log(`Cargo: ${reason}; nothing removed.`);
    return result(options.dryRun, builds.length, totals, reason);
  }
  const liveGuard = new PathGuard(live.paths);
  const namedGuard = new PathGuard(
    await serviceNamedPaths(options.namedPaths ?? { homeDir: options.homeDir }),
  );
  const cutFull = options.nowMs - (options.fullDays ?? CARGO_FULL_DAYS) * DAY_MS;
  const cutIncr = options.nowMs - (options.incrementalDays ?? CARGO_INCREMENTAL_DAYS) * DAY_MS;
  for (const bd of builds) {
    const st = await lstatOrNull(bd);
    if (st === null || st.uid !== options.uid) continue;
    const reason = liveGuard.holdsLivePath(bd)
      ? "a process uses it"
      : namedGuard.holdsLivePath(bd)
        ? "a service names it"
        : (await holdsMount(bd))
          ? "it holds a mount point"
          : "";
    if (reason) {
      totals.skippedInUse += 1;
      totals.items.push({ kind: "build-dir", action: "skipped", path: bd, reason });
      continue;
    }
    if (await hasRecentEntry(bd, cutFull)) {
      await reapIncremental(bd, cutIncr, options.dryRun, totals);
      continue;
    }
    const kept = await keptPaths(bd);
    let keptBytes = st.blocks * 512;
    for (const p of kept) keptBytes += ((await lstatOrNull(p))?.blocks ?? 0) * 512;
    const bytes = Math.max(0, (await diskBytes(bd)) - keptBytes);
    if (!options.dryRun) {
      await emptyTree(bd, kept, await NodeFSP.realpath(bd));
      if (!(await leftEntries(bd)).every((p) => kept.has(p))) {
        totals.items.push({
          kind: "build-dir",
          action: "failed",
          path: bd,
          reason: "could not remove all of it",
        });
        continue;
      }
    }
    totals.removed += 1;
    totals.removedBytes += bytes;
    totals.items.push({
      kind: "build-dir",
      action: options.dryRun ? "would-remove" : "removed",
      path: bd,
      bytes,
    });
  }
  options.log(
    `Cargo${options.dryRun ? " (dry run)" : ""}: ${builds.length} build folders; ${totals.removed} emptied, ` +
      `${totals.incremental} incremental removed, ${totals.skippedInUse} skipped in use`,
  );
  return result(options.dryRun, builds.length, totals, null);
}
