// @effect-diagnostics nodeBuiltinImport:off - Incremental DevDeck-parity stage and POST_MERGE parser for ship-queue job logs.
import * as NodeFS from "node:fs";

import { SHIP_QUEUE_STAGE_AFTER, SHIP_QUEUE_STAGE_MARKERS } from "@t3tools/ship-queue/markers";

import { openShipJobLog, statShipJobLog } from "./shipQueueJobLogFile.ts";
const STAGE_LOG_CHUNK_BYTES = 256 * 1024;
const MAX_INCREMENTAL_SCAN_BYTES = 32 * 1024 * 1024;

// The stage vocabulary is the queue's own (`@t3tools/ship-queue/markers`). Non-stage lines like
// WATCHER_LOST, WATCHER_BACK, and QUIET are deliberately ignored so a watcher blip during a deploy
// never clobbers POST_MERGE -> "deploy".
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
  for (const prefix of SHIP_QUEUE_STAGE_MARKERS) {
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
    stage: state.lastMarker ? (SHIP_QUEUE_STAGE_AFTER[state.lastMarker] ?? "") : "",
    hasPostMerge: state.hasPostMerge,
  };
}

export function parseDevdeckStageFromLogText(logText: string): string {
  return parseDevdeckLogStageInfo(logText).stage;
}

export function readShipJobLogInfo(jobsRootDir: string, jobId: string): DevdeckLogStageInfo {
  const st = statShipJobLog(jobsRootDir, jobId);
  if (!st) return { stage: "", hasPostMerge: false };
  const logPath = st.path;
  try {
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
    const fd = openShipJobLog(st);
    if (fd === null) return { stage: "", hasPostMerge: false };
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
      stage: state.lastMarker ? (SHIP_QUEUE_STAGE_AFTER[state.lastMarker] ?? "") : "",
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
