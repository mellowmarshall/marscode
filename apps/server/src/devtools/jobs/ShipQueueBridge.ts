// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - Ship Queue adapter feeding JobRegistry with zero polling when idle.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as CliRunners from "../CliRunners.ts";
import { readShipJobLogInfo } from "./shipQueueLogParser.ts";
import {
  sanitizeJobText,
  type JobSummary,
  type JobsQueueMeta,
  type TrackedJobState,
} from "./types.ts";

const JOB_KEY_EPOCH_RE = /^(\d{9,11})-j/;

function mapShipState(raw: Record<string, unknown>): TrackedJobState {
  const s = String(raw.state ?? raw.display_state ?? "").toLowerCase();
  if (s === "done" || s === "merged") return "done";
  if (s === "cancelled") return "cancelled";
  if (s === "failed" || s.includes("fail")) return "failed";
  if (s === "queued" || s === "pending") return "queued";
  if (
    s.includes("wait") ||
    s.includes("parked") ||
    s.includes("needs-root") ||
    Boolean((raw.parked as { for?: unknown } | undefined)?.for)
  ) {
    return "waiting";
  }
  return "running";
}

function mapShipPhaseLabel(
  raw: Record<string, unknown>,
  state: TrackedJobState,
  stage: string,
): string {
  const marker = String(raw.last_marker ?? "").trim();
  const syncExit = raw.sync_exit;
  const hasSync =
    (typeof syncExit === "number" && Number.isFinite(syncExit)) ||
    (typeof syncExit === "string" && syncExit.trim() !== "");
  const rawState = String(raw.state ?? "").toLowerCase();
  const rawDisplay = String(raw.display_state ?? "").toLowerCase();
  const effectiveStage = (stage || String(raw.stage ?? "")).trim().toLowerCase();
  if (
    state === "running" &&
    !hasSync &&
    (effectiveStage === "deploy" ||
      effectiveStage === "deploying" ||
      /^POST_MERGE\b/i.test(marker) ||
      rawState === "deploy" ||
      rawState === "deploying" ||
      rawDisplay === "deploy" ||
      rawDisplay === "deploying")
  ) {
    return "Deploying";
  }
  return "Shipping";
}

function resolveShipStartedAt(raw: Record<string, unknown>): string {
  const sub = typeof raw.submitted_at === "string" ? raw.submitted_at : "";
  if (sub && Number.isFinite(Date.parse(sub))) return sub;
  const key = typeof raw.key === "string" ? raw.key : "";
  const m = JOB_KEY_EPOCH_RE.exec(key);
  if (m?.[1]) {
    const sec = Number(m[1]);
    if (Number.isFinite(sec) && sec > 0) return new Date(sec * 1000).toISOString();
  }
  return new Date().toISOString();
}

export function adaptShipQueueJob(
  raw: Record<string, unknown>,
  hostname: string,
  revision: number,
  jobsRootDir = "",
): JobSummary | null {
  const rawId = typeof raw.id === "string" ? raw.id.trim() : "";
  const fallbackId = `${String(raw.repo ?? "repo")}:${String(raw.branch ?? "job")}`;
  const id = `ship:${rawId || fallbackId}`;
  const state = mapShipState(raw);
  const live = state === "queued" || state === "running" || state === "waiting";
  const failedAfterMergeWithoutSync =
    state === "failed" &&
    (raw.merge_exit === 0 || raw.merge_exit === "0") &&
    (raw.sync_exit === undefined || raw.sync_exit === null || String(raw.sync_exit).trim() === "");
  const logInfo =
    rawId && (live || failedAfterMergeWithoutSync)
      ? readShipJobLogInfo(jobsRootDir, rawId)
      : { stage: "", hasPostMerge: false };
  const stage = live
    ? logInfo.stage || String(raw.stage ?? "").trim()
    : String(raw.stage ?? "").trim();
  const repo = typeof raw.repo === "string" ? raw.repo.trim() : undefined;
  const branch = typeof raw.branch === "string" ? raw.branch.trim() : undefined;
  const title =
    sanitizeJobText(typeof raw.title === "string" ? raw.title : undefined, 160) ||
    branch ||
    (rawId ? `Ship #${rawId}` : "Ship job");
  const routeHost =
    raw.route &&
    typeof raw.route === "object" &&
    typeof (raw.route as { host?: unknown }).host === "string"
      ? String((raw.route as { host: string }).host).trim()
      : undefined;
  const enrichedShipJob: Record<string, unknown> =
    stage || logInfo.hasPostMerge
      ? {
          ...raw,
          ...(stage ? { stage } : {}),
          ...(logInfo.hasPostMerge ? { post_merge: true } : {}),
        }
      : raw;

  return {
    id,
    revision,
    source: "ship-queue",
    kind: "ship",
    title,
    ...(branch ? { subtitle: branch } : {}),
    phaseLabel: mapShipPhaseLabel(enrichedShipJob, state, stage),
    state,
    binding: {
      ...(typeof raw.thread_id === "string" && raw.thread_id.trim()
        ? { threadId: raw.thread_id.trim() }
        : {}),
      ...(repo ? { repo, project: repo } : {}),
      ...(branch ? { branch } : {}),
      ...(typeof raw.worktree === "string" && raw.worktree.trim()
        ? { worktreePath: raw.worktree.trim() }
        : {}),
      host: routeHost || hostname,
    },
    timing: {
      startedAt: resolveShipStartedAt(raw),
    },
    cancellable: live && /^[0-9]{1,16}$/.test(rawId),
    shipJob: enrichedShipJob,
  };
}

export interface ShipQueueBridgeUpdate {
  readonly jobs: ReadonlyMap<string, JobSummary>;
  readonly changedIds: ReadonlyArray<string>;
  readonly removedIds: ReadonlyArray<string>;
  readonly queueMeta: JobsQueueMeta;
  readonly queueMetaChanged: boolean;
}

export class ShipQueueBridge {
  private readonly hostname = NodeOS.hostname();
  private readonly onUpdate: (update: ShipQueueBridgeUpdate) => void;
  private readonly watchers = new Map<string, NodeFS.FSWatcher>();
  private readonly current = new Map<
    string,
    { readonly fp: string; readonly summary: JobSummary }
  >();
  private queueMeta: JobsQueueMeta = {};
  private queueMetaFp = "";
  private jobsRootDir = "";
  private running = false;
  private runGeneration = 0;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(onUpdate: (update: ShipQueueBridgeUpdate) => void) {
    this.onUpdate = onUpdate;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const gen = ++this.runGeneration;
    void this.refresh(false).then(() => {
      if (!this.running || this.runGeneration !== gen) return;
      if (this.pollTimer !== null) {
        clearInterval(this.pollTimer);
        this.pollTimer = null;
      }
      const pollMs = this.watchers.size > 0 ? 60_000 : 10_000;
      this.pollTimer = setInterval(() => {
        void this.refresh(false);
      }, pollMs);
      this.pollTimer.unref();
    });
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.runGeneration += 1;
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    for (const w of this.watchers.values()) {
      try {
        w.close();
      } catch {
        // ignore
      }
    }
    this.watchers.clear();
    this.current.clear();
    this.queueMeta = {};
    this.queueMetaFp = "";
  }

  getSnapshot(): {
    readonly jobs: ReadonlyMap<string, JobSummary>;
    readonly queueMeta: JobsQueueMeta;
  } {
    const jobs = new Map<string, JobSummary>();
    for (const [id, entry] of this.current) {
      jobs.set(id, entry.summary);
    }
    return { jobs, queueMeta: this.queueMeta };
  }

  async refresh(allowWhenStopped = false): Promise<void> {
    const res = await CliRunners.getShipQueueStatus();
    if (!allowWhenStopped && !this.running) return;
    if (!res.ok || !res.data || typeof res.data !== "object") {
      const errMsg = res.error || "ship-queue unavailable";
      const nextMeta: JobsQueueMeta = { ...this.queueMeta, error: errMsg };
      const nextFp = JSON.stringify(nextMeta);
      if (nextFp !== this.queueMetaFp) {
        this.queueMeta = nextMeta;
        this.queueMetaFp = nextFp;
        const jobs = new Map<string, JobSummary>();
        for (const [id, entry] of this.current) jobs.set(id, entry.summary);
        this.onUpdate({
          jobs,
          changedIds: [],
          removedIds: [],
          queueMeta: this.queueMeta,
          queueMetaChanged: true,
        });
      }
      return;
    }
    const record = res.data as Record<string, unknown>;
    const qroot =
      typeof record.queue_root === "string" && record.queue_root ? record.queue_root : undefined;
    if (qroot) {
      this.jobsRootDir = NodePath.join(qroot, "jobs");
    } else if (!this.jobsRootDir) {
      this.jobsRootDir = NodePath.join(NodeOS.homedir(), ".local", "share", "ship-queue", "jobs");
    }
    if (this.running) {
      this.syncWatchers(record);
    }

    const nextMeta: JobsQueueMeta = {
      ...(qroot ? { queueRoot: qroot } : {}),
      ...(typeof record.open_count === "number" ? { openCount: record.open_count } : {}),
      ...(typeof record.total_count === "number" ? { totalCount: record.total_count } : {}),
      ...(typeof record.upgrade_pending === "string"
        ? { upgradePending: record.upgrade_pending }
        : {}),
    };
    const nextMetaFp = JSON.stringify(nextMeta);
    const queueMetaChanged = nextMetaFp !== this.queueMetaFp;
    if (queueMetaChanged) {
      this.queueMeta = nextMeta;
      this.queueMetaFp = nextMetaFp;
    }

    const rawJobs = Array.isArray(record.jobs) ? record.jobs : [];
    const seen = new Set<string>();
    const changedIds: string[] = [];
    for (const item of rawJobs) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const rec = item as Record<string, unknown>;
      const probe = adaptShipQueueJob(rec, this.hostname, 1, this.jobsRootDir);
      if (!probe) continue;
      const fp = `${JSON.stringify(rec)}\0${probe.phaseLabel}\0${String((probe.shipJob as { stage?: unknown } | undefined)?.stage ?? "")}`;
      seen.add(probe.id);
      const existing = this.current.get(probe.id);
      if (existing && existing.fp === fp) continue;
      const nextRev = existing ? existing.summary.revision + 1 : 1;
      const summary = { ...probe, revision: nextRev };
      this.current.set(probe.id, { fp, summary });
      changedIds.push(probe.id);
    }

    const removedIds: string[] = [];
    for (const existingId of this.current.keys()) {
      if (!seen.has(existingId)) {
        this.current.delete(existingId);
        removedIds.push(existingId);
      }
    }

    if (changedIds.length > 0 || removedIds.length > 0 || queueMetaChanged) {
      const jobs = new Map<string, JobSummary>();
      for (const [id, entry] of this.current) {
        jobs.set(id, entry.summary);
      }
      this.onUpdate({ jobs, changedIds, removedIds, queueMeta: this.queueMeta, queueMetaChanged });
    }
  }

  private scheduleRefresh = (): void => {
    if (!this.running || this.debounceTimer !== null) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.refresh();
    }, 300);
    this.debounceTimer.unref();
  };

  private watchDir(dir: string): void {
    if (!this.running || this.watchers.has(dir)) return;
    try {
      if (!NodeFS.existsSync(dir)) return;
      const w = NodeFS.watch(dir, { persistent: false }, this.scheduleRefresh);
      w.on("error", () => {
        try {
          w.close();
        } catch {
          // ignore
        }
        this.watchers.delete(dir);
      });
      this.watchers.set(dir, w);
    } catch {
      // ignore unwatched dir
    }
  }

  private syncWatchers(record: Record<string, unknown>): void {
    if (!this.running || !this.jobsRootDir) return;
    const desired = new Set<string>([this.jobsRootDir, NodePath.join(this.jobsRootDir, "open")]);
    const jobs = Array.isArray(record.jobs) ? record.jobs : [];
    let added = 0;
    for (const item of jobs) {
      if (added >= 64) break;
      if (!item || typeof item !== "object") continue;
      const job = item as Record<string, unknown>;
      const id = typeof job.id === "string" ? job.id : "";
      const state = typeof job.state === "string" ? job.state.toLowerCase() : "";
      if (!/^[0-9A-Za-z._-]{1,64}$/.test(id)) continue;
      if (state === "done" || state === "failed" || state === "cancelled") continue;
      desired.add(NodePath.join(this.jobsRootDir, id));
      added += 1;
    }
    for (const [dir, w] of this.watchers.entries()) {
      if (!desired.has(dir)) {
        try {
          w.close();
        } catch {
          // ignore
        }
        this.watchers.delete(dir);
      }
    }
    for (const dir of desired) {
      this.watchDir(dir);
    }
  }
}
