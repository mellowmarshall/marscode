/** Bounded, redacted tail of a ship-queue job log, and the post-merge sync failure reason it records. */
import { redactLogLine } from "./logFileGuard.ts";
import { readShipJobLogRange, type ShipJobLogStat } from "./shipQueueJobLogFile.ts";
import { sanitizeJobText } from "./types.ts";

const TAIL_BYTES = 64 * 1024;
const TAIL_LINES = 200;
const MAX_LINE_CHARS = 400;
const SYNC_REASON_CHARS = 240;

// The queue's own post-merge summaries (`@t3tools/ship-queue/postMergeSync`), written as indented output.
const SYNC_SUMMARY_RE =
  /^post-merge (?:sync exited -?\d+|sync aborted|sync error|refused|extract failed)\b/;
const SYNC_EXITED_RE = /^post-merge sync exited -?\d+\b/;
const REMAINS_MERGED_RE = /\s*\(PR #\d+ remains merged\)\s*$/;

interface TailCacheEntry {
  readonly mtimeMs: number;
  readonly size: number;
  readonly lines: ReadonlyArray<string>;
}

const tailCache = new Map<string, TailCacheEntry>();

function redactTailLine(raw: string): string {
  const indented = raw.startsWith(" ") || raw.startsWith("\t");
  const body = redactLogLine(raw.trim()).slice(0, MAX_LINE_CHARS);
  return indented ? `  ${body}` : body;
}

/**
 * The last lines of a log `statShipJobLog` found, redacted, with output kept indented under its
 * column-0 markers. `null` when there is no log or it fails the open-time identity checks.
 */
export function readShipJobLogTail(st: ShipJobLogStat | null): ReadonlyArray<string> | null {
  if (!st) return null;
  const cached = tailCache.get(st.path);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.lines;
  const offset = Math.max(0, st.size - TAIL_BYTES);
  const bytes = readShipJobLogRange(st, offset);
  if (bytes === null) return null;
  const rawLines = bytes.toString("utf8").split(/\r?\n/);
  // A tail that starts mid-file starts mid-line too: drop the partial first line.
  if (offset > 0) rawLines.shift();
  while (rawLines.length > 0 && rawLines[rawLines.length - 1]!.trim() === "") rawLines.pop();
  const lines = rawLines.slice(-TAIL_LINES).map(redactTailLine);
  if (tailCache.size > 256) tailCache.clear();
  tailCache.set(st.path, { mtimeMs: st.mtimeMs, size: st.size, lines });
  return lines;
}

/**
 * Why a merged job's post-merge sync did not exit 0, from the log the queue wrote for it: the
 * queue's own refusal or abort line, or for a hook that exited non-zero, the hook's last output line.
 */
export function postMergeSyncReason(lines: ReadonlyArray<string>): string | undefined {
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i]!.startsWith("POST_MERGE job=")) {
      start = i;
      break;
    }
  }
  for (let i = lines.length - 1; i > start; i -= 1) {
    const text = lines[i]!.trim();
    if (!SYNC_SUMMARY_RE.test(text)) continue;
    if (!SYNC_EXITED_RE.test(text)) {
      return sanitizeJobText(text.replace(REMAINS_MERGED_RE, ""), SYNC_REASON_CHARS) || undefined;
    }
    for (let j = i - 1; j > start; j -= 1) {
      const raw = lines[j]!;
      const prev = raw.trim();
      if (!prev) continue;
      // A column-0 line is a queue marker, not the hook's output.
      if (!raw.startsWith(" ") && !raw.startsWith("\t")) return undefined;
      return sanitizeJobText(prev, SYNC_REASON_CHARS) || undefined;
    }
    return undefined;
  }
  return undefined;
}
