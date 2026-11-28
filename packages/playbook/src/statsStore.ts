// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Review-stats files on disk: challenge records, ship-queue job reviews, review-stats.jsonl.
/**
 * Review verdicts on disk: challenge records, ship-queue job reviews, review-stats.jsonl.
 * Every reader (`playbook stats`, the server's Review Stats) and writer uses this module.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  challengeRecordFromJson,
  parseJsonlRecords,
  parseStructuredReviewText,
} from "./statsParse.ts";
import type { ReviewStatRecord, ReviewStatsPaths } from "./statsTypes.ts";

function defaultStateHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.XDG_STATE_HOME?.trim() || NodePath.join(NodeOS.homedir(), ".local", "state");
}

export function defaultPlaybookStateDir(env: NodeJS.ProcessEnv = process.env): string {
  return NodePath.join(defaultStateHome(env), "playbook");
}

export function defaultShipJobsDir(env: NodeJS.ProcessEnv = process.env): string {
  const envRoot = env.SHIP_QUEUE_ROOT?.trim();
  if (envRoot) return NodePath.join(envRoot, "jobs");
  for (const p of [
    NodePath.join(NodeOS.homedir(), ".local", "lib", "host-guards.conf"),
    NodePath.join(NodeOS.homedir(), ".local", "lib", "host-guards", "host-guards.conf"),
  ]) {
    try {
      const m = /^queue_root=(.+)$/m.exec(NodeFS.readFileSync(p, "utf8"));
      if (m?.[1]?.trim()) return NodePath.join(m[1].trim(), "jobs");
    } catch {
      continue;
    }
  }
  return "/data/Dev/.ship-queue/jobs";
}

export function defaultReviewStatsJsonlPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.T3_REVIEW_STATS_JSONL?.trim();
  if (override) return override;
  return NodePath.join(defaultStateHome(env), "devtools", "review-stats.jsonl");
}

interface FileCacheEntry {
  readonly mtimeMs: number;
  readonly size: number;
  readonly record: ReviewStatRecord | null;
}

const fileRecordCache = new Map<string, FileCacheEntry>();

function cachedRead(
  path: string,
  parse: (st: NodeFS.Stats) => ReviewStatRecord | null,
): ReviewStatRecord | null {
  try {
    const st = NodeFS.statSync(path);
    const cached = fileRecordCache.get(path);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.record;
    const record = parse(st);
    fileRecordCache.set(path, { mtimeMs: st.mtimeMs, size: st.size, record });
    return record;
  } catch {
    return null;
  }
}

function readChallengeFile(fullPath: string, repoDir: string, fileName: string) {
  return cachedRead(fullPath, () => {
    try {
      return challengeRecordFromJson(
        JSON.parse(NodeFS.readFileSync(fullPath, "utf8")) as unknown,
        repoDir,
        fileName,
      );
    } catch {
      return null;
    }
  });
}

function readShipJob(jobDir: string, jobId: string): ReviewStatRecord | null {
  const reviewPath = NodePath.join(jobDir, "adversarial-review.md");
  return cachedRead(reviewPath, (st) => {
    const text = NodeFS.readFileSync(reviewPath, "utf8").slice(0, 256 * 1024);
    let job: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(NodeFS.readFileSync(NodePath.join(jobDir, "job.json"), "utf8"));
      if (parsed && typeof parsed === "object") job = parsed as Record<string, unknown>;
    } catch {
      // job.json is optional
    }
    const review = parseStructuredReviewText(text);
    return {
      id: `ship:${jobId}`,
      source: "ship_queue_review",
      timestamp:
        typeof job.submitted_at === "string" && job.submitted_at
          ? job.submitted_at
          : new Date(st.mtimeMs).toISOString(),
      repo: String(job.repo ?? "unknown"),
      branch: String(job.branch ?? ""),
      commit: String(job.bootstrap_sha ?? ""),
      worktree: String(job.worktree ?? ""),
      threadId: String(job.thread_id ?? ""),
      reviewThreadId: String(job.review_thread_id ?? job.reviewThreadId ?? review.reviewThreadId),
      verdict: review.verdict,
      reviewer: review.reviewer,
      submitter: review.submitter,
      counts: review.counts,
      bypassDetected: false,
      playbookFriction: false,
      rejectedRisesCount: 0,
      fallbackUsed: false,
      durationS: null,
    };
  });
}

/** A queue repo (`owner_name`) and a challenge's repo (`name`) name the same repository. */
function sameRepo(queueRepo: string, challengeRepo: string): boolean {
  const q = queueRepo.toLowerCase();
  const c = challengeRepo.toLowerCase();
  return q === c || q.endsWith(`_${c}`) || q.endsWith(`/${c}`);
}

export interface OverrideDecision {
  readonly repo: string;
  readonly tip: string;
  readonly at: string;
  readonly job: string;
}

interface OverrideIndexState {
  readonly mtimeMs: number;
  readonly size: number;
  readonly decisions: ReadonlyArray<OverrideDecision>;
}

const overrideIndexCache = new Map<string, OverrideIndexState>();

function parseDecisions(text: string): ReadonlyArray<OverrideDecision> {
  const out: OverrideDecision[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as Record<string, unknown>;
      if (
        typeof row.repo === "string" &&
        typeof row.tip === "string" &&
        /^[0-9a-f]{40,64}$/i.test(row.tip) &&
        typeof row.at === "string"
      ) {
        out.push({
          repo: row.repo,
          tip: row.tip.toLowerCase(),
          at: row.at,
          job: String(row.job ?? ""),
        });
      }
    } catch {
      // A torn line adds nothing.
    }
  }
  return out;
}

/**
 * Every override decision in the queue's index (`<queue root>/challenge-overrides.jsonl`, beside
 * the jobs directory). The file only grows, so after an append only the new bytes are read.
 */
export function readOverrideDecisions(shipJobsDir: string): ReadonlyArray<OverrideDecision> {
  const indexPath = NodePath.join(NodePath.dirname(shipJobsDir), "challenge-overrides.jsonl");
  let st: NodeFS.Stats;
  try {
    st = NodeFS.statSync(indexPath);
  } catch {
    overrideIndexCache.delete(indexPath);
    return [];
  }
  const prev = overrideIndexCache.get(indexPath);
  if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs) return prev.decisions;
  const from = prev && st.size > prev.size ? prev.size : 0;
  let added: ReadonlyArray<OverrideDecision> = [];
  try {
    const fd = NodeFS.openSync(indexPath, "r");
    try {
      const buf = Buffer.alloc(st.size - from);
      NodeFS.readSync(fd, buf, 0, buf.length, from);
      added = parseDecisions(buf.toString("utf8"));
    } finally {
      NodeFS.closeSync(fd);
    }
  } catch {
    return prev?.decisions ?? [];
  }
  const decisions = from > 0 && prev ? [...prev.decisions, ...added] : added;
  overrideIndexCache.set(indexPath, { mtimeMs: st.mtimeMs, size: st.size, decisions });
  return decisions;
}

function listDir(dir: string): ReadonlyArray<NodeFS.Dirent> {
  try {
    return NodeFS.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function readJsonl(path: string): ReadonlyArray<ReviewStatRecord> {
  try {
    return parseJsonlRecords(NodeFS.readFileSync(path, "utf8"));
  } catch {
    return [];
  }
}

/**
 * Every stored record by id: challenges, ship-queue job reviews, then the
 * JSONL. A `t3-review:` record (a delegated review thread) for a ship job's
 * review thread fills that job's unknown actors instead of standing alone.
 * EXTRA records (built by the caller, e.g. from live review threads) merge last.
 */
export function collectReviewRecords(
  paths: ReviewStatsPaths = {},
  extra: ReadonlyArray<ReviewStatRecord> = [],
): ReadonlyArray<ReviewStatRecord> {
  const byId = new Map<string, ReviewStatRecord>();
  const pbDir = paths.playbookStateDir ?? defaultPlaybookStateDir();
  for (const repoEntry of listDir(pbDir)) {
    if (!repoEntry.isDirectory()) continue;
    for (const file of listDir(NodePath.join(pbDir, repoEntry.name))) {
      if (!file.name.endsWith(".challenge.json")) continue;
      const full = NodePath.join(pbDir, repoEntry.name, file.name);
      const rec = readChallengeFile(full, repoEntry.name, file.name);
      if (rec) byId.set(rec.id, rec);
    }
  }
  const shipIdByReviewThread = new Map<string, string>();
  const shipJobsDir = paths.shipJobsDir ?? defaultShipJobsDir();
  // Each override decision credits one challenge: the newest of that repo and challenged tip
  // made before the decision. A later challenge of the same tip gets no credit.
  const challenges = [...byId.values()].filter(
    (rec) =>
      rec.source === "playbook_challenge" &&
      rec.commit.length >= 7 &&
      (rec.verdict === "challenged" || rec.verdict === "rejected_budget"),
  );
  for (const decision of readOverrideDecisions(shipJobsDir)) {
    let best: ReviewStatRecord | undefined;
    for (const rec of challenges) {
      if (rec.commit.toLowerCase() !== decision.tip) continue;
      if (!sameRepo(decision.repo, rec.repo) || rec.timestamp > decision.at) continue;
      if (!best || rec.timestamp > best.timestamp) best = rec;
    }
    if (best) {
      const current = byId.get(best.id) ?? best;
      byId.set(best.id, { ...current, overridden: true });
    }
  }
  for (const entry of listDir(shipJobsDir)) {
    if (!entry.isDirectory()) continue;
    const rec = readShipJob(NodePath.join(shipJobsDir, entry.name), entry.name);
    if (!rec) continue;
    byId.set(rec.id, rec);
    if (rec.reviewThreadId) shipIdByReviewThread.set(rec.reviewThreadId, rec.id);
  }
  const mergeOrInsert = (rec: ReviewStatRecord) => {
    const shipId = rec.reviewThreadId ? shipIdByReviewThread.get(rec.reviewThreadId) : undefined;
    const ship = rec.id.startsWith("t3-review:") && shipId ? byId.get(shipId) : undefined;
    if (ship) {
      byId.set(ship.id, {
        ...ship,
        reviewer:
          ship.reviewer.model === "unknown" || !ship.reviewer.effort ? rec.reviewer : ship.reviewer,
        submitter: ship.submitter.model === "unknown" ? rec.submitter : ship.submitter,
        durationS: ship.durationS ?? rec.durationS,
      });
      return;
    }
    if (!byId.has(rec.id)) byId.set(rec.id, rec);
  };
  for (const rec of readJsonl(paths.jsonlPath ?? defaultReviewStatsJsonlPath())) {
    if (rec.id.startsWith("t3-review:")) {
      mergeOrInsert(rec);
      continue;
    }
    byId.set(rec.id, rec);
    if (rec.source === "ship_queue_review" && rec.reviewThreadId) {
      shipIdByReviewThread.set(rec.reviewThreadId, rec.id);
    }
  }
  for (const rec of extra) mergeOrInsert(rec);
  return [...byId.values()];
}

const writtenIdsByPath = new Map<string, Set<string>>();
let writeGeneration = 0;

/** Bumped on every append, so a reader's cache knows its snapshot is stale. */
export const reviewStatsWriteGeneration = () => writeGeneration;

function writtenIds(jsonlPath: string): Set<string> {
  let seen = writtenIdsByPath.get(jsonlPath);
  if (seen) return seen;
  seen = new Set(readJsonl(jsonlPath).map((r) => r.id));
  writtenIdsByPath.set(jsonlPath, seen);
  return seen;
}

/** Append RECORD once (by id); false when it was already written or the write failed. */
export function appendReviewStatRecord(
  record: ReviewStatRecord,
  jsonlPath: string = defaultReviewStatsJsonlPath(),
): boolean {
  try {
    const seen = writtenIds(jsonlPath);
    if (seen.has(record.id)) return false;
    NodeFS.mkdirSync(NodePath.dirname(jsonlPath), { recursive: true, mode: 0o755 });
    const line = JSON.stringify({
      id: record.id,
      source: record.source,
      timestamp: record.timestamp,
      repo: record.repo,
      branch: record.branch,
      commit: record.commit,
      worktree: record.worktree,
      thread_id: record.threadId,
      review_thread_id: record.reviewThreadId,
      verdict: record.verdict,
      reviewer: record.reviewer,
      submitter: record.submitter,
      counts: record.counts,
      bypass_detected: record.bypassDetected,
      playbook_friction: record.playbookFriction,
      rejected_rises_count: record.rejectedRisesCount,
      fallback_used: record.fallbackUsed,
      duration_s: record.durationS,
    });
    NodeFS.appendFileSync(jsonlPath, `${line}\n`, { mode: 0o600 });
    seen.add(record.id);
    writeGeneration += 1;
    return true;
  } catch {
    return false;
  }
}
