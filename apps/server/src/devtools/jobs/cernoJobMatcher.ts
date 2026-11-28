// @effect-diagnostics nodeBuiltinImport:off - Deduplication and visibility coordination between live cerno OS processes and T3 background jobs.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { cernoIdStartTicks } from "./jobProcessLoad.ts";
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
  /** `timing.startedAt` in ms; NaN when unknown. */
  readonly startedAtMs?: number | undefined;
}

const MIN_COMMAND_MATCH_LEN = 6;
const MAX_COMMAND_MATCH_LEN = 64;

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

type RealpathFn = (p: string) => string;

function isPathInsideOrEqual(childPath: string, parentPath: string, realpath: RealpathFn): boolean {
  const realChild = realpath(childPath);
  const realParent = realpath(parentPath);
  return realChild === realParent || realChild.startsWith(realParent + NodePath.sep);
}

interface CernoMatchSide {
  readonly threadId?: string | undefined;
  readonly cwd?: string | undefined;
  readonly command: string;
  readonly logPath?: string | undefined;
}

interface BgMatchSide {
  readonly threadId?: string | undefined;
  readonly worktreePath?: string | undefined;
  readonly command?: string | undefined;
  readonly logPath?: string | undefined;
}

function cernoAbsLogPath(cerno: CernoMatchSide): string | null {
  if (!cerno.logPath) return null;
  if (NodePath.isAbsolute(cerno.logPath)) return cerno.logPath;
  return cerno.cwd && NodePath.isAbsolute(cerno.cwd)
    ? NodePath.resolve(cerno.cwd, cerno.logPath)
    : null;
}

function bgRawLogPath(bg: BgMatchSide): string | null {
  return (
    bg.logPath ?? (bg.command ? extractCommandLogPath(bg.command, bg.worktreePath ?? null) : null)
  );
}

function matchesWith(cerno: CernoMatchSide, bg: BgMatchSide, realpath: RealpathFn): boolean {
  if (cerno.threadId && bg.threadId && cerno.threadId !== bg.threadId) return false;
  if (cerno.threadId && !bg.threadId) return false;

  const cernoAbsLog = cernoAbsLogPath(cerno);
  const bgRawLog = bgRawLogPath(bg);
  const bgSubdirLog =
    !bg.logPath &&
    bg.command &&
    cerno.cwd &&
    bg.worktreePath &&
    isPathInsideOrEqual(cerno.cwd, bg.worktreePath, realpath)
      ? extractCommandLogPath(bg.command, cerno.cwd)
      : null;
  if (
    cernoAbsLog &&
    ((bgRawLog && realpath(cernoAbsLog) === realpath(bgRawLog)) ||
      (bgSubdirLog && realpath(cernoAbsLog) === realpath(bgSubdirLog)))
  ) {
    return true;
  }

  if (!cerno.threadId || !bg.threadId || !bg.command) return false;
  const normCerno = normalizeInnerCommand(cerno.command);
  const normBg = normalizeInnerCommand(bg.command);
  if (normCerno.length < MIN_COMMAND_MATCH_LEN || normBg.length < MIN_COMMAND_MATCH_LEN) {
    return false;
  }
  const cmpLen = Math.min(MAX_COMMAND_MATCH_LEN, normCerno.length, normBg.length);
  return normCerno.slice(0, cmpLen) === normBg.slice(0, cmpLen);
}

export function cernoMatchesBackgroundJob(cerno: CernoMatchSide, bg: BgMatchSide): boolean {
  return matchesWith(cerno, bg, tryRealpathSync);
}

/** The real path itself and every ancestor that `isPathInsideOrEqual` treats as a parent. */
function insideOrEqualKeys(realPath: string): ReadonlyArray<string> {
  const keys = [realPath];
  let dir = realPath;
  for (;;) {
    const up = NodePath.dirname(dir);
    // `root + sep` never prefixes a child, so the filesystem root contains only itself.
    if (up === dir || NodePath.dirname(up) === up) break;
    keys.push(up);
    dir = up;
  }
  return keys;
}

type Collect = (list: ReadonlyArray<number> | undefined) => void;

export interface CernoCandidateIndex {
  /** The first live candidate, in list order, that `cernoMatchesBackgroundJob` accepts. */
  find(bg: BgMatchSide): CernoJobMatchCandidate | undefined;
}

/**
 * Indexes live cerno candidates once per process table by log path, cwd and command prefix,
 * so matching a background job is a lookup. Path resolution is cached for the index's life.
 */
export function indexCernoCandidates(
  candidates: ReadonlyArray<CernoJobMatchCandidate>,
  realpathFn: RealpathFn = tryRealpathSync,
): CernoCandidateIndex {
  const resolved = new Map<string, string>();
  const realpath = (p: string): string => {
    let real = resolved.get(p);
    if (real === undefined) {
      real = realpathFn(p);
      resolved.set(p, real);
    }
    return real;
  };
  const live: CernoJobMatchCandidate[] = [];
  const byLog = new Map<string, number[]>();
  const byCwd = new Map<string, number[]>();
  const byPrefix = new Map<string, number[]>();
  const byExact = new Map<string, number[]>();
  const add = (map: Map<string, number[]>, key: string, i: number) => {
    const list = map.get(key);
    if (list) list.push(i);
    else map.set(key, [i]);
  };
  const indexCommand = (threadId: string, command: string, i: number) => {
    const norm = normalizeInnerCommand(command);
    if (norm.length < MIN_COMMAND_MATCH_LEN) return;
    const capped = Math.min(MAX_COMMAND_MATCH_LEN, norm.length);
    for (let len = MIN_COMMAND_MATCH_LEN; len <= capped; len += 1) {
      add(byPrefix, `${threadId}\0${norm.slice(0, len)}`, i);
    }
    if (norm.length < MAX_COMMAND_MATCH_LEN) add(byExact, `${threadId}\0${norm}`, i);
  };
  // A candidate at least as long as the job matches on the job's capped command; a shorter one
  // matches when its whole command is a prefix of the job's.
  const collectCommand = (threadId: string, command: string, collect: Collect) => {
    const norm = normalizeInnerCommand(command);
    if (norm.length < MIN_COMMAND_MATCH_LEN) return;
    const capped = Math.min(MAX_COMMAND_MATCH_LEN, norm.length);
    collect(byPrefix.get(`${threadId}\0${norm.slice(0, capped)}`));
    for (let len = MIN_COMMAND_MATCH_LEN; len < capped; len += 1) {
      collect(byExact.get(`${threadId}\0${norm.slice(0, len)}`));
    }
  };

  for (const c of candidates) {
    if (isTerminalJobState(c.state) || !c.pidStats?.alive) continue;
    const i = live.push(c) - 1;
    const absLog = cernoAbsLogPath(c);
    if (absLog) add(byLog, realpath(absLog), i);
    if (c.cwd) for (const key of insideOrEqualKeys(realpath(c.cwd))) add(byCwd, key, i);
    if (c.threadId) indexCommand(c.threadId, c.command, i);
  }

  return {
    find(bg) {
      const hits = new Set<number>();
      const collect: Collect = (list) => {
        for (const i of list ?? []) hits.add(i);
      };
      const rawLog = bgRawLogPath(bg);
      if (rawLog) collect(byLog.get(realpath(rawLog)));
      if (!bg.logPath && bg.command && bg.worktreePath) {
        collect(byCwd.get(realpath(bg.worktreePath)));
      }
      if (bg.threadId && bg.command) collectCommand(bg.threadId, bg.command, collect);
      for (const i of [...hits].toSorted((a, b) => a - b)) {
        if (matchesWith(live[i]!, bg, realpath)) return live[i];
      }
      return undefined;
    },
  };
}

function byStartOrder(a: number, b: number): number {
  const ka = Number.isFinite(a) ? a : Number.POSITIVE_INFINITY;
  const kb = Number.isFinite(b) ? b : Number.POSITIVE_INFINITY;
  return ka - kb;
}

/**
 * Pairs each live cerno process with at most one live background job and the reverse, in start
 * order on both sides, so two runs of one command each keep their own verdict.
 */
function pairLiveCernoWithBg(
  candidates: ReadonlyArray<CernoJobMatchCandidate>,
  bgEntries: ReadonlyArray<BgMatchEntry>,
): Map<string, CernoJobMatchCandidate> {
  const liveBg = bgEntries
    .filter((bg) => !isTerminalJobState(bg.state))
    .toSorted((a, b) => byStartOrder(a.startedAtMs ?? NaN, b.startedAtMs ?? NaN));
  const liveCerno = candidates
    .filter((c) => !isTerminalJobState(c.state))
    .toSorted((a, b) =>
      byStartOrder(cernoIdStartTicks(a.id) ?? NaN, cernoIdStartTicks(b.id) ?? NaN),
    );
  const paired = new Map<string, CernoJobMatchCandidate>();
  for (const candidate of liveCerno) {
    const bg = liveBg.find((b) => !paired.has(b.id) && cernoMatchesBackgroundJob(candidate, b));
    if (bg) paired.set(bg.id, candidate);
  }
  return paired;
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
  /** Live background job id -> the live cerno process it hides, whose health the job carries. */
  private liveCernoByBg = new Map<string, CernoJobMatchCandidate>();
  private readonly cb: CernoVisibilityCallbacks;

  constructor(callbacks: CernoVisibilityCallbacks) {
    this.cb = callbacks;
  }

  /**
   * A live background job that hides its live cerno process carries that process's verdict,
   * so the sidebar and thread card show its health bar.
   */
  withLiveCerno(summary: JobSummary): JobSummary {
    if (summary.cerno || isTerminalJobState(summary.state)) return summary;
    const cerno = this.liveCernoByBg.get(summary.id)?.cerno;
    return cerno ? { ...summary, cerno } : summary;
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
      startedAtMs: Date.parse(summary.timing.startedAt),
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
    this.liveCernoByBg.delete(jobId);
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
    const candidates = this.cb.listCernoCandidates();
    const nextLiveCernoByBg = pairLiveCernoWithBg(candidates, bgEntries);

    for (const candidate of candidates) {
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
    // A background job whose hidden cerno process appeared, left, or changed its verdict re-sends.
    const prevLiveCernoByBg = this.liveCernoByBg;
    this.liveCernoByBg = nextLiveCernoByBg;
    for (const bgId of new Set([...prevLiveCernoByBg.keys(), ...nextLiveCernoByBg.keys()])) {
      const prevId = prevLiveCernoByBg.get(bgId)?.id;
      const nextId = nextLiveCernoByBg.get(bgId)?.id;
      if (prevId === nextId && !(nextId && changedCernoIds?.has(nextId))) continue;
      if (!this.suppressedBgIds.has(bgId) && this.cb.getBgSummary(bgId)) {
        this.cb.markDirty(bgId, true);
      }
    }
  }

  /** Root PID of the live cerno process matched to a live background job, from the match cache. */
  liveCernoRootForBg(
    bgId: string,
    candidates: CernoCandidateIndex,
  ): { readonly pid: number; readonly startTicks: number | null } | undefined {
    const bg = this.bgMatchCache.get(bgId);
    if (!bg || isTerminalJobState(bg.state)) return undefined;
    const matched = candidates.find(bg);
    return matched?.pidStats
      ? { pid: matched.pidStats.pid, startTicks: cernoIdStartTicks(matched.id) }
      : undefined;
  }

  /** The live cerno process paired with a live background job at the last sync. */
  liveCernoForBg(bgId: string): CernoJobMatchCandidate | undefined {
    return this.liveCernoByBg.get(bgId);
  }
}
