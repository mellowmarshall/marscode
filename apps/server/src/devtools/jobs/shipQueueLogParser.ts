// @effect-diagnostics nodeBuiltinImport:off - Incremental DevDeck-parity stage and POST_MERGE parser for ship-queue job logs.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const SAFE_JOB_ID_RE = /^[0-9A-Za-z._-]{1,64}$/;
const STAGE_LOG_CHUNK_BYTES = 256 * 1024;
const MAX_INCREMENTAL_SCAN_BYTES = 32 * 1024 * 1024;

// Exact column-0 stage markers and stage map from devtools/devdeck/internal/ship/jobs.go.
// Non-stage lines like WATCHER_LOST, WATCHER_BACK, and INTENT_AUDIT are deliberately ignored
// so a watcher blip during a deploy never clobbers POST_MERGE -> "deploy".
export const DEVDECK_STAGE_MARKERS = [
  "QUEUED job=",
  "WAITING_WATCHER",
  "STARTED job=",
  "REBASED",
  "PUSH_EXIT=",
  "PR=",
  "MERGE_EXIT=",
  "LEFT_DIRTY",
  "LEFT_AHEAD",
  "CLEANED",
  "POST_MERGE job=",
  "SYNC_EXIT=",
  "FAILED reason=",
  "DONE job=",
] as const;

export const DEVDECK_STAGE_AFTER: Readonly<Record<string, string>> = {
  "QUEUED job=": "queued",
  WAITING_WATCHER: "watcher",
  "STARTED job=": "rebase",
  REBASED: "ci",
  "PUSH_EXIT=": "pr",
  "PR=": "github",
  "MERGE_EXIT=": "cleanup",
  LEFT_DIRTY: "cleanup",
  LEFT_AHEAD: "cleanup",
  CLEANED: "post-merge",
  "POST_MERGE job=": "deploy",
  "SYNC_EXIT=": "deployed",
};

interface DevdeckLogStageInfo {
  readonly stage: string;
  readonly hasPostMerge: boolean;
}

interface LogStageCacheEntry {
  readonly mtimeMs: number;
  readonly size: number;
  readonly lastMarker: string;
  readonly hasPostMerge: boolean;
  readonly partialLine: string;
  readonly info: DevdeckLogStageInfo;
}

const logStageCache = new Map<string, LogStageCacheEntry>();

function scanMarkerLine(
  rawLine: string,
  state: { lastMarker: string; hasPostMerge: boolean },
): void {
  if (!rawLine || rawLine[0] === " " || rawLine[0] === "\t") return;
  if (rawLine.startsWith("POST_MERGE job=")) state.hasPostMerge = true;
  for (const prefix of DEVDECK_STAGE_MARKERS) {
    if (rawLine.startsWith(prefix)) {
      state.lastMarker = prefix;
      return;
    }
  }
}

export function parseDevdeckLogStageInfo(logText: string): DevdeckLogStageInfo {
  const state = { lastMarker: "", hasPostMerge: false };
  for (const rawLine of logText.split(/\r?\n/)) {
    scanMarkerLine(rawLine, state);
  }
  return {
    stage: state.lastMarker ? (DEVDECK_STAGE_AFTER[state.lastMarker] ?? "") : "",
    hasPostMerge: state.hasPostMerge,
  };
}

export function parseDevdeckStageFromLogText(logText: string): string {
  return parseDevdeckLogStageInfo(logText).stage;
}

export function readShipJobLogInfo(jobsRootDir: string, jobId: string): DevdeckLogStageInfo {
  if (!jobsRootDir || !SAFE_JOB_ID_RE.test(jobId)) return { stage: "", hasPostMerge: false };
  const logPath = NodePath.join(jobsRootDir, jobId, "log");
  try {
    const st = NodeFS.statSync(logPath);
    const cached = logStageCache.get(logPath);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
      return cached.info;
    }
    const incremental = cached !== undefined && st.size > cached.size;
    const state = {
      lastMarker: incremental ? cached.lastMarker : "",
      hasPostMerge: incremental ? cached.hasPostMerge : false,
    };
    let offset = incremental ? cached.size : 0;
    let carry = incremental ? cached.partialLine : "";
    if (!incremental && st.size > MAX_INCREMENTAL_SCAN_BYTES) {
      offset = st.size - MAX_INCREMENTAL_SCAN_BYTES;
    }
    const fd = NodeFS.openSync(logPath, "r");
    try {
      const buf = Buffer.alloc(Math.min(STAGE_LOG_CHUNK_BYTES, Math.max(1, st.size - offset)));
      while (offset < st.size) {
        const n = NodeFS.readSync(fd, buf, 0, buf.length, offset);
        if (n <= 0) break;
        offset += n;
        const lines = (carry + buf.subarray(0, n).toString("utf8")).split(/\r?\n/);
        carry = lines.pop() ?? "";
        for (const line of lines) scanMarkerLine(line, state);
        if (carry.length > 256) {
          scanMarkerLine(carry, state);
          carry = " ";
        }
      }
      if (carry) scanMarkerLine(carry, state);
    } finally {
      NodeFS.closeSync(fd);
    }
    const info: DevdeckLogStageInfo = {
      stage: state.lastMarker ? (DEVDECK_STAGE_AFTER[state.lastMarker] ?? "") : "",
      hasPostMerge: state.hasPostMerge,
    };
    if (logStageCache.size > 256) logStageCache.clear();
    logStageCache.set(logPath, {
      mtimeMs: st.mtimeMs,
      size: st.size,
      lastMarker: state.lastMarker,
      hasPostMerge: state.hasPostMerge,
      partialLine: carry,
      info,
    });
    return info;
  } catch {
    return { stage: "", hasPostMerge: false };
  }
}
