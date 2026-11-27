// @effect-diagnostics nodeBuiltinImport:off - Deduplication and visibility coordination between live cerno OS processes and T3 background jobs.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { extractCommandLogPath } from "./commandJobParser.ts";
import {
  isTerminalJobState,
  type JobCernoVerdict,
  type JobDetail,
  type JobPidStats,
  type JobSummary,
  type TrackedJobState,
} from "./types.ts";

export interface CernoJobMatchCandidate {
  readonly id: string;
  readonly threadId?: string | undefined;
  readonly cwd?: string | undefined;
  readonly state: TrackedJobState;
  readonly command: string;
  readonly logPath?: string | undefined;
  readonly cerno?: JobCernoVerdict | undefined;
  readonly pidStats?: JobPidStats | undefined;
}

export interface BgMatchEntry {
  readonly id: string;
  readonly state: TrackedJobState;
  readonly threadId?: string | undefined;
  readonly worktreePath?: string | undefined;
  readonly command?: string | undefined;
  readonly logPath?: string | undefined;
}

function normalizeInnerCommand(raw: string): string {
  let text = raw.replace(/\s+/gu, " ").trim();
  while (/^(?:cd|rm\s+-f|mkdir\s+-p)\s+[^&;]+&&\s*/u.test(text)) {
    text = text.replace(/^(?:cd|rm\s+-f|mkdir\s+-p)\s+[^&;]+&&\s*/u, "");
  }
  const cernoIdx = text.indexOf(" -- ");
  if (/^cerno\s+watch\b/u.test(text) && cernoIdx !== -1) {
    text = text.slice(cernoIdx + 4).trim();
  }
  return text.replace(/['"]/gu, "").replace(/\s+/gu, " ").trim();
}

function tryRealpathSync(p: string): string {
  try {
    return NodeFS.realpathSync(p);
  } catch {
    return NodePath.resolve(p);
  }
}

function isPathInsideOrEqual(childPath: string, parentPath: string): boolean {
  const realChild = tryRealpathSync(childPath);
  const realParent = tryRealpathSync(parentPath);
  return realChild === realParent || realChild.startsWith(realParent + NodePath.sep);
}

export function cernoMatchesBackgroundJob(
  cerno: {
    readonly threadId?: string | undefined;
    readonly cwd?: string | undefined;
    readonly command: string;
    readonly logPath?: string | undefined;
  },
  bg: {
    readonly threadId?: string | undefined;
    readonly worktreePath?: string | undefined;
    readonly command?: string | undefined;
    readonly logPath?: string | undefined;
  },
): boolean {
  if (cerno.threadId && bg.threadId && cerno.threadId !== bg.threadId) return false;
  if (cerno.threadId && !bg.threadId) return false;

  const cernoAbsLog = cerno.logPath
    ? NodePath.isAbsolute(cerno.logPath)
      ? cerno.logPath
      : cerno.cwd && NodePath.isAbsolute(cerno.cwd)
        ? NodePath.resolve(cerno.cwd, cerno.logPath)
        : null
    : null;
  const bgRawLog =
    bg.logPath ?? (bg.command ? extractCommandLogPath(bg.command, bg.worktreePath ?? null) : null);
  const bgSubdirLog =
    !bg.logPath &&
    bg.command &&
    cerno.cwd &&
    bg.worktreePath &&
    isPathInsideOrEqual(cerno.cwd, bg.worktreePath)
      ? extractCommandLogPath(bg.command, cerno.cwd)
      : null;
  if (
    cernoAbsLog &&
    ((bgRawLog && tryRealpathSync(cernoAbsLog) === tryRealpathSync(bgRawLog)) ||
      (bgSubdirLog && tryRealpathSync(cernoAbsLog) === tryRealpathSync(bgSubdirLog)))
  ) {
    return true;
  }

  if (!cerno.threadId || !bg.threadId || !bg.command) return false;
  const normCerno = normalizeInnerCommand(cerno.command);
  const normBg = normalizeInnerCommand(bg.command);
  if (normCerno.length < 6 || normBg.length < 6) return false;
  const cmpLen = Math.min(64, normCerno.length, normBg.length);
  return normCerno.slice(0, cmpLen) === normBg.slice(0, cmpLen);
}

export interface CernoVisibilityCallbacks {
  readonly listBgSummaries: () => ReadonlyArray<JobSummary>;
  readonly getBgSummary: (id: string) => JobSummary | undefined;
  readonly getBgDetail: (id: string) => JobDetail | null;
  readonly listCernoCandidates: () => ReadonlyArray<CernoJobMatchCandidate>;
  readonly markDirty: (id: string, urgent: boolean) => void;
  readonly markRemoved: (id: string) => void;
}

/**
 * Single owner of `visibleCernoIds` and `suppressedBgIds` for `JobRegistry`.
 * Guarantees every visibility change broadcasts deltas to SSE subscribers and avoids
 * O(cerno * bg) detail rebuilds on non-urgent background log ticks.
 */
export class CernoVisibilityCoordinator {
  private readonly bgMatchCache = new Map<string, BgMatchEntry>();
  readonly visibleCernoIds = new Set<string>();
  readonly suppressedBgIds = new Set<string>();
  private readonly cb: CernoVisibilityCallbacks;

  constructor(callbacks: CernoVisibilityCallbacks) {
    this.cb = callbacks;
  }

  hasBgCached(jobId: string): boolean {
    return this.bgMatchCache.has(jobId);
  }

  refreshBgEntry(jobId: string): boolean {
    const summary = this.cb.getBgSummary(jobId);
    if (!summary) return this.bgMatchCache.delete(jobId);
    const prev = this.bgMatchCache.get(jobId);
    const detail = this.cb.getBgDetail(jobId);
    const next: BgMatchEntry = {
      id: jobId,
      state: summary.state,
      threadId: summary.binding.threadId,
      worktreePath: summary.binding.worktreePath,
      command: detail?.command,
      logPath: detail?.logPath,
    };
    this.bgMatchCache.set(jobId, next);
    return (
      !prev ||
      isTerminalJobState(prev.state) !== isTerminalJobState(next.state) ||
      prev.logPath !== next.logPath ||
      prev.command !== next.command
    );
  }

  removeBgEntry(jobId: string): void {
    this.bgMatchCache.delete(jobId);
    this.suppressedBgIds.delete(jobId);
  }

  private syncBgCacheAll(): void {
    const present = new Set<string>();
    for (const s of this.cb.listBgSummaries()) {
      present.add(s.id);
      const prev = this.bgMatchCache.get(s.id);
      if (!prev || prev.state !== s.state) {
        this.refreshBgEntry(s.id);
      }
    }
    for (const id of this.bgMatchCache.keys()) {
      if (!present.has(id)) this.bgMatchCache.delete(id);
    }
  }

  sync(changedCernoIds?: ReadonlySet<string>, removedCernoIds?: ReadonlyArray<string>): void {
    this.syncBgCacheAll();
    if (removedCernoIds) {
      for (const id of removedCernoIds) {
        if (this.visibleCernoIds.delete(id)) this.cb.markRemoved(id);
      }
    }
    const bgEntries = [...this.bgMatchCache.values()];
    const nextSuppressedBg = new Set<string>();
    const presentCernoIds = new Set<string>();

    for (const candidate of this.cb.listCernoCandidates()) {
      presentCernoIds.add(candidate.id);
      const candidateLive = !isTerminalJobState(candidate.state);
      let suppressed = false;
      for (const bg of bgEntries) {
        if (!cernoMatchesBackgroundJob(candidate, bg)) continue;
        if (!isTerminalJobState(bg.state)) {
          suppressed = true;
          break;
        }
        if (candidateLive) {
          nextSuppressedBg.add(bg.id);
        } else {
          suppressed = true;
        }
      }
      if (suppressed) {
        if (this.visibleCernoIds.delete(candidate.id)) this.cb.markRemoved(candidate.id);
      } else {
        const wasVisible = this.visibleCernoIds.has(candidate.id);
        this.visibleCernoIds.add(candidate.id);
        if (!wasVisible || changedCernoIds?.has(candidate.id)) {
          this.cb.markDirty(candidate.id, true);
        }
      }
    }

    for (const id of this.visibleCernoIds) {
      if (!presentCernoIds.has(id)) {
        this.visibleCernoIds.delete(id);
        this.cb.markRemoved(id);
      }
    }
    for (const bgId of nextSuppressedBg) {
      if (!this.suppressedBgIds.has(bgId)) {
        this.suppressedBgIds.add(bgId);
        this.cb.markRemoved(bgId);
      }
    }
    for (const bgId of this.suppressedBgIds) {
      if (!nextSuppressedBg.has(bgId)) {
        this.suppressedBgIds.delete(bgId);
        if (this.cb.getBgSummary(bgId)) this.cb.markDirty(bgId, true);
      }
    }
  }

  findLiveCernoForBg(
    bgSummary: JobSummary,
    bgDetail: JobDetail,
  ): CernoJobMatchCandidate | undefined {
    if (isTerminalJobState(bgSummary.state)) return undefined;
    return this.cb.listCernoCandidates().find(
      (c) =>
        !isTerminalJobState(c.state) &&
        cernoMatchesBackgroundJob(c, {
          threadId: bgSummary.binding.threadId,
          worktreePath: bgSummary.binding.worktreePath,
          command: bgDetail.command,
          logPath: bgDetail.logPath,
        }),
    );
  }
}
