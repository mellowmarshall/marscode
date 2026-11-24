// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - Bounded non-shell ship-queue CLI execution and status normalization.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type { ShipQueueActionResult, ShipQueueJob } from "@t3tools/contracts";

import { readShipQueueLogInfo } from "./shipQueueLogParser.ts";

const MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const TOOL_CACHE_TTL_MS = 30_000;
const STATUS_TIMEOUT_MS = 15_000;
const CANCEL_TIMEOUT_MS = 15_000;
const MAX_RECENT_NON_LIVE_JOBS = 60;
const JOB_ID_RE = /^[0-9]{1,16}$/;

const SAFE_ENV_EXACT = new Set([
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  "LANG",
  "PATH",
  "TMPDIR",
  "SSH_AUTH_SOCK",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "DBUS_SESSION_BUS_ADDRESS",
  "GOPATH",
  "GOMODCACHE",
  "CARGO_HOME",
  "RUSTUP_HOME",
  "NVM_DIR",
  "PNPM_HOME",
]);

const SAFE_ENV_PREFIXES = ["LC_", "XDG_", "SHIP_QUEUE_", "CARGO_", "RUSTUP_"];

const toolPathCache = new Map<
  string,
  { readonly path: string | null; readonly expiresAt: number }
>();

export interface RawShipQueueStatusResult {
  readonly ok: boolean;
  readonly daemonRunning: boolean;
  readonly daemonPid: number | null;
  readonly openCount: number;
  readonly totalCount: number;
  readonly jobs: ReadonlyArray<ShipQueueJob>;
}

function isExecutableFile(candidate: string): boolean {
  try {
    const st = NodeFS.statSync(candidate);
    if (!st.isFile()) return false;
    NodeFS.accessSync(candidate, NodeFS.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveShipQueueBinary(
  homeDir: string,
  env: Readonly<Record<string, string | undefined>>,
  nowMs = Date.now(),
): string | null {
  if (env.T3_GUARD_GRANT_TEST_MODE === "1") {
    const testBin = env.T3_SHIP_QUEUE_BIN?.trim();
    if (testBin) {
      return isExecutableFile(testBin) ? testBin : null;
    }
  }

  const cacheKey = `${homeDir}\0${env.PATH ?? ""}`;
  const cached = toolPathCache.get(cacheKey);
  if (cached && cached.expiresAt > nowMs) {
    return cached.path;
  }

  const localBin = NodePath.join(homeDir, ".local", "bin", "ship-queue");
  let resolved: string | null = null;
  if (isExecutableFile(localBin)) {
    resolved = localBin;
  } else {
    const dirs = (env.PATH ?? "").split(NodePath.delimiter).filter(Boolean);
    for (const dir of dirs) {
      const candidate = NodePath.join(dir, "ship-queue");
      if (isExecutableFile(candidate)) {
        resolved = candidate;
        break;
      }
    }
  }
  if (toolPathCache.size > 16) toolPathCache.clear();
  toolPathCache.set(cacheKey, { path: resolved, expiresAt: nowMs + TOOL_CACHE_TTL_MS });
  return resolved;
}

export function buildSafeToolEnv(
  baseEnv: Readonly<Record<string, string | undefined>>,
  extraEnv?: Readonly<Record<string, string | undefined>>,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    if (SAFE_ENV_EXACT.has(key) || SAFE_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      out[key] = value;
    }
  }
  if (baseEnv.T3_GUARD_GRANT_TEST_MODE === "1") {
    out.T3_GUARD_GRANT_TEST_MODE = "1";
    if (baseEnv.T3_GUARD_GRANT_SOCKET) {
      out.T3_GUARD_GRANT_SOCKET = baseEnv.T3_GUARD_GRANT_SOCKET;
    }
    if (baseEnv.T3_SHIP_QUEUE_BIN) {
      out.T3_SHIP_QUEUE_BIN = baseEnv.T3_SHIP_QUEUE_BIN;
    }
  }
  if (extraEnv) {
    for (const [key, value] of Object.entries(extraEnv)) {
      if (value !== undefined) out[key] = value;
    }
  }
  return out;
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asBool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1" || value === "true") return true;
  if (value === 0 || value === "0" || value === "false") return false;
  return undefined;
}

function isLiveState(state: string): boolean {
  const s = state.toLowerCase();
  if (s === "done" || s === "merged" || s === "cancelled" || s === "failed" || s.includes("fail")) {
    return false;
  }
  return true;
}

export function normalizeShipQueueJob(
  raw: Record<string, unknown>,
  jobsRootDir: string,
): ShipQueueJob | null {
  const rawId = asString(raw.id) ?? "";
  const repo = asString(raw.repo);
  const branch = asString(raw.branch);
  const fallbackId = `${repo ?? "repo"}:${branch ?? "job"}`;
  const id = rawId || fallbackId;
  const state = asString(raw.state) ?? asString(raw.display_state) ?? "unknown";
  const live = isLiveState(state);
  const mergeExit = asNumber(raw.merge_exit);
  const syncExit = asNumber(raw.sync_exit);
  const pushExit = asNumber(raw.push_exit);
  const failedAfterMergeWithoutSync =
    state.toLowerCase().includes("fail") && mergeExit === 0 && syncExit === null;
  const logInfo =
    rawId && (live || failedAfterMergeWithoutSync)
      ? readShipQueueLogInfo(jobsRootDir, rawId)
      : { stage: "", hasPostMerge: false };

  const stage = live ? logInfo.stage || asString(raw.stage) : asString(raw.stage);
  const lastMarker = asString(raw.last_marker);
  const route =
    raw.route && typeof raw.route === "object" && !Array.isArray(raw.route)
      ? (raw.route as Record<string, unknown>)
      : undefined;
  const parked =
    raw.parked && typeof raw.parked === "object" && !Array.isArray(raw.parked)
      ? (raw.parked as Record<string, unknown>)
      : undefined;
  const needsRoot =
    raw.needs_root && typeof raw.needs_root === "object" && !Array.isArray(raw.needs_root)
      ? (raw.needs_root as Record<string, unknown>)
      : undefined;

  let displayState = asString(raw.display_state) ?? state;
  const stageLower = (stage ?? "").toLowerCase();
  if (
    live &&
    syncExit === null &&
    (stageLower === "deploy" ||
      stageLower === "deploying" ||
      /^POST_MERGE\b/iu.test(lastMarker ?? ""))
  ) {
    displayState = "deploying";
  }

  const hosts = Array.isArray(needsRoot?.hosts)
    ? needsRoot.hosts.filter((h): h is string => typeof h === "string" && h.trim().length > 0)
    : undefined;

  const key = asString(raw.key);
  const title = asString(raw.title);
  const submittedAt = asString(raw.submitted_at);
  const waiting = asString(raw.waiting);
  const reason = asString(raw.reason);
  const pr = asString(raw.pr);
  const prRepo = asString(raw.pr_repo);
  const prUrl = asString(raw.pr_url);
  const primary = asString(raw.primary);
  const worktree = asString(raw.worktree);
  const threadId = asString(raw.thread_id);
  const reviewThreadId = asString(raw.review_thread_id);
  const ciDone = asBool(raw.ci_done);
  const watchers = asNumber(raw.watchers);
  const logBytes = asNumber(raw.log_bytes);
  const routeHost = asString(route?.host);
  const routeLoad = asString(route?.load);
  const routeLocal = asBool(route?.local);
  const parkedFor = asString(parked?.for);
  const needsRootRequest = asString(needsRoot?.request);

  return {
    id,
    ...(key !== undefined ? { key } : {}),
    ...(repo !== undefined ? { repo } : {}),
    ...(branch !== undefined ? { branch } : {}),
    ...(title !== undefined ? { title } : {}),
    state,
    displayState,
    ...(stage !== undefined ? { stage } : {}),
    ...(logInfo.hasPostMerge ? { postMerge: true } : {}),
    ...(submittedAt !== undefined ? { submittedAt } : {}),
    ...(lastMarker !== undefined ? { lastMarker } : {}),
    ...(waiting !== undefined ? { waiting } : {}),
    ...(reason !== undefined ? { reason } : {}),
    ...(pr !== undefined ? { pr } : {}),
    ...(prRepo !== undefined ? { prRepo } : {}),
    ...(prUrl !== undefined ? { prUrl } : {}),
    ...(primary !== undefined ? { primary } : {}),
    ...(worktree !== undefined ? { worktree } : {}),
    ...(threadId !== undefined ? { threadId } : {}),
    ...(reviewThreadId !== undefined ? { reviewThreadId } : {}),
    ...(ciDone !== undefined ? { ciDone } : {}),
    ...(pushExit !== null ? { pushExit } : {}),
    ...(mergeExit !== null ? { mergeExit } : {}),
    ...(syncExit !== null ? { syncExit } : {}),
    ...(watchers !== null ? { watchers } : {}),
    ...(logBytes !== null ? { logBytes } : {}),
    ...(routeHost !== undefined ? { routeHost } : {}),
    ...(routeLoad !== undefined ? { routeLoad } : {}),
    ...(routeLocal !== undefined ? { routeLocal } : {}),
    ...(parkedFor !== undefined ? { parkedFor } : {}),
    ...(needsRootRequest !== undefined ? { needsRootRequest } : {}),
    ...(hosts !== undefined && hosts.length > 0 ? { needsRootHosts: hosts } : {}),
  };
}

let inFlightStatus: Promise<RawShipQueueStatusResult> | null = null;

export function execShipQueueStatus(
  bin: string,
  queueRoot: string,
  env: NodeJS.ProcessEnv,
): Promise<RawShipQueueStatusResult> {
  if (inFlightStatus) return inFlightStatus;
  inFlightStatus = new Promise<RawShipQueueStatusResult>((resolve) => {
    NodeChildProcess.execFile(
      bin,
      ["status", "--json"],
      { env, timeout: STATUS_TIMEOUT_MS, maxBuffer: MAX_BUFFER_BYTES },
      (err, stdout) => {
        if (err && !stdout.trim()) {
          resolve({
            ok: false,
            daemonRunning: false,
            daemonPid: null,
            openCount: 0,
            totalCount: 0,
            jobs: [],
          });
          return;
        }
        try {
          const parsed = JSON.parse(stdout) as Record<string, unknown>;
          const resolvedRoot = asString(parsed.queue_root) ?? queueRoot;
          const jobsRootDir = NodePath.join(resolvedRoot, "jobs");
          const daemon =
            parsed.daemon && typeof parsed.daemon === "object"
              ? (parsed.daemon as Record<string, unknown>)
              : {};
          const rawJobs = Array.isArray(parsed.jobs) ? parsed.jobs : [];
          const liveJobs: ShipQueueJob[] = [];
          const pastJobs: ShipQueueJob[] = [];
          for (const item of rawJobs) {
            if (!item || typeof item !== "object" || Array.isArray(item)) continue;
            const job = normalizeShipQueueJob(item as Record<string, unknown>, jobsRootDir);
            if (!job) continue;
            if (isLiveState(job.state)) liveJobs.push(job);
            else if (pastJobs.length < MAX_RECENT_NON_LIVE_JOBS) pastJobs.push(job);
          }
          resolve({
            ok: true,
            daemonRunning: Boolean(daemon.running),
            daemonPid: asNumber(daemon.pid),
            openCount: Math.max(0, Math.floor(asNumber(parsed.open_count) ?? liveJobs.length)),
            totalCount: Math.max(0, Math.floor(asNumber(parsed.total_count) ?? rawJobs.length)),
            jobs: [...liveJobs, ...pastJobs],
          });
        } catch {
          resolve({
            ok: false,
            daemonRunning: false,
            daemonPid: null,
            openCount: 0,
            totalCount: 0,
            jobs: [],
          });
        }
      },
    );
  }).finally(() => {
    inFlightStatus = null;
  });
  return inFlightStatus;
}

export function cancelShipQueueJob(
  bin: string | null,
  jobId: string,
  env: NodeJS.ProcessEnv,
): Promise<ShipQueueActionResult> {
  if (!JOB_ID_RE.test(jobId)) {
    return Promise.resolve({ ok: false, error: "Invalid numeric job ID" });
  }
  if (!bin) {
    return Promise.resolve({ ok: false, error: "ship-queue not found in PATH or ~/.local/bin" });
  }
  return new Promise((resolve) => {
    NodeChildProcess.execFile(
      bin,
      ["cancel", jobId],
      { env, timeout: CANCEL_TIMEOUT_MS, maxBuffer: MAX_BUFFER_BYTES },
      (err, stdout, stderr) => {
        if (!err) {
          const output = stdout.trim() || stderr.trim();
          resolve({ ok: true, ...(output ? { output } : {}) });
          return;
        }
        resolve({
          ok: false,
          error: stderr.trim() || stdout.trim() || err.message || "Failed to cancel ship job",
        });
      },
    );
  });
}
