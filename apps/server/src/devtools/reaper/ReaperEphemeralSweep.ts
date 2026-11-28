// @effect-diagnostics nodeBuiltinImport:off - TTL sweep of StorageManifest ephemeral roots and operator-approved policy paths.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { sweepTimeRuleRefusal } from "../ReaperPolicy.ts";
import type { ReaperPolicyRule } from "../ReaperPolicyToml.ts";
import type { GitTracksFiles } from "../ReaperRulePathChecks.ts";
import type { StorageManifestEntry } from "../StorageManifest.ts";
import { overlapsAny, safeReapRoot } from "./ReaperPathGuard.ts";
import type { SweepContext } from "./ReaperTempSweep.ts";
import {
  diskBytes,
  forceRemove,
  gitDataIn,
  hasRecentEntry,
  lstatDevice,
  onRootDevice,
} from "./ReaperTreeOps.ts";

const HOUR_MS = 3_600_000;
const MIN_AGE_HOURS = 1;
const DEFAULT_EPHEMERAL_AGE_HOURS = 24;

export interface EphemeralRoot {
  readonly path: string;
  readonly maxAgeHours: number;
  readonly label: string;
}

export interface EphemeralSweepContext extends SweepContext {
  readonly homeDir: string;
  /** Real paths of StorageManifest history roots: never removed from, at any depth. */
  readonly historyRoots: ReadonlyArray<string>;
}

export interface EphemeralSweepTotals {
  removed: number;
  bytes: number;
  /** Modification times of the oldest and newest item removed, for dry-run previews. */
  oldestMtimeMs?: number;
  newestMtimeMs?: number;
}

export function ephemeralRootsFromEntries(
  entries: ReadonlyArray<StorageManifestEntry>,
): EphemeralRoot[] {
  return entries.map((entry) => ({
    path: entry.path,
    maxAgeHours: Math.max(MIN_AGE_HOURS, entry.maxAgeHours ?? DEFAULT_EPHEMERAL_AGE_HOURS),
    label: entry.id,
  }));
}

interface Candidate {
  readonly path: string;
  readonly mtimeMs: number;
  readonly isDir: boolean;
}

async function ownedChildren(root: string, uid: number): Promise<Candidate[]> {
  const names = await NodeFSP.readdir(root).catch(() => [] as string[]);
  const out: Candidate[] = [];
  for (const name of names.toSorted()) {
    if (name.startsWith(".")) continue;
    const target = NodePath.join(root, name);
    const st = await NodeFSP.lstat(target).catch(() => null);
    if (st === null || st.uid !== uid || st.isSymbolicLink()) continue;
    out.push({ path: target, mtimeMs: st.mtimeMs, isDir: st.isDirectory() });
  }
  return out;
}

async function removeIfStale(
  candidate: Candidate,
  root: string,
  cutoff: number,
  ctx: EphemeralSweepContext,
  totals: EphemeralSweepTotals,
  label: string,
): Promise<void> {
  if (candidate.mtimeMs >= cutoff) return;
  const real = await NodeFSP.realpath(candidate.path).catch(() => candidate.path);
  if (overlapsAny(real, ctx.historyRoots) || ctx.guard.isProtectedUnder(real, root)) return;
  if (!(await onRootDevice(candidate.path, root, ctx.deviceOf ?? lstatDevice))) return;
  const gitData = await gitDataIn(candidate.path);
  if (gitData !== null) {
    ctx.log(`  Kept stale ${label} ${candidate.path}: it holds ${gitData}`);
    return;
  }
  if (candidate.isDir && (await hasRecentEntry(candidate.path, cutoff, { gitIsRecent: true }))) {
    return;
  }
  const bytes = await diskBytes(candidate.path);
  if (!ctx.dryRun && !(await forceRemove(candidate.path))) return;
  totals.removed += 1;
  totals.bytes += bytes;
  totals.oldestMtimeMs = Math.min(totals.oldestMtimeMs ?? Infinity, candidate.mtimeMs);
  totals.newestMtimeMs = Math.max(totals.newestMtimeMs ?? -Infinity, candidate.mtimeMs);
  ctx.log(`  ${ctx.dryRun ? "Would remove" : "Removed"} stale ${label} ${candidate.path}`);
}

/** Stale children of each ephemeral root; a root that is or holds a history root is skipped whole. */
export async function sweepEphemeralRoots(
  roots: ReadonlyArray<EphemeralRoot>,
  ctx: EphemeralSweepContext,
): Promise<EphemeralSweepTotals> {
  const totals: EphemeralSweepTotals = { removed: 0, bytes: 0 };
  for (const root of roots) {
    const safe = await safeReapRoot(root.path, ctx.homeDir);
    if (safe === null || overlapsAny(safe, ctx.historyRoots)) continue;
    const cutoff = ctx.nowMs - root.maxAgeHours * HOUR_MS;
    for (const candidate of await ownedChildren(safe, ctx.uid)) {
      const base = NodePath.basename(candidate.path);
      if (base.endsWith(".lock") || base.endsWith(".pid")) continue;
      await removeIfStale(candidate, safe, cutoff, ctx, totals, root.label);
    }
  }
  if (totals.removed > 0) {
    ctx.log(
      `${ctx.dryRun ? "Would clean" : "Cleaned"} ${totals.removed} stale ephemeral items ` +
        `(${(totals.bytes / 1024 ** 2).toFixed(1)} MB)`,
    );
  }
  return totals;
}

/** Enabled `[[approved]]` rules from ReaperPolicy: stale entries past keepLatest. */
export async function sweepApprovedPolicy(
  rules: ReadonlyArray<ReaperPolicyRule>,
  ctx: EphemeralSweepContext,
  tracksFiles: GitTracksFiles,
): Promise<EphemeralSweepTotals> {
  const totals: EphemeralSweepTotals = { removed: 0, bytes: 0 };
  for (const rule of rules) {
    if (!rule.enabled) continue;
    const safe = await safeReapRoot(rule.path, ctx.homeDir);
    if (safe === null || overlapsAny(safe, ctx.historyRoots)) continue;
    // A parent may have become a repo since the rule was saved, or the rule predates a check.
    const refusal = await sweepTimeRuleRefusal(safe, ctx.homeDir, tracksFiles);
    if (refusal !== null) {
      ctx.log(`Skipped approved rule ${rule.path}: ${refusal}`);
      continue;
    }
    const cutoff = ctx.nowMs - Math.max(1, rule.maxAgeDays) * 24 * HOUR_MS;
    const newestFirst = (await ownedChildren(safe, ctx.uid)).toSorted(
      (a, b) => b.mtimeMs - a.mtimeMs,
    );
    for (const candidate of newestFirst.slice(Math.max(0, rule.keepLatest))) {
      await removeIfStale(candidate, safe, cutoff, ctx, totals, "approved-policy item");
    }
  }
  return totals;
}
