/**
 * The job log's column-0 markers. Stage output is indented, so only these lines carry meaning;
 * every reader (watch, status, the server's JobRegistry stage parser) keys off this vocabulary.
 */
export const MARKER_PREFIXES = [
  "QUEUED job=",
  "WAITING_WATCHER",
  "STARTED job=",
  "WATCHER_LOST ",
  "WATCHER_BACK ",
  "REBASED ",
  "ACTION_REQUIRED job=",
  "PUSH_EXIT=",
  "PR=",
  "MERGE_EXIT=",
  "REMOTE_DELETED ",
  "LEFT_DIRTY ",
  "LEFT_AHEAD ",
  "CLEANED ",
  "POST_MERGE job=",
  "SYNC_EXIT=",
  "QUIET job=",
  "FAILED reason=",
  "DONE job=",
] as const;

/** Stage-bearing markers in DevDeck order; watcher blips and QUIET never move a job's stage. */
export const SHIP_QUEUE_STAGE_MARKERS = [
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

/** The stage a job is in once a marker is its latest. */
export const SHIP_QUEUE_STAGE_AFTER: Readonly<Record<string, string>> = {
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

export function isMarkerLine(line: string): boolean {
  if (!line || line[0] === " " || line[0] === "\t") return false;
  if (line.startsWith("PR=")) return /^PR=\d/.test(line);
  return MARKER_PREFIXES.some((prefix) => line.startsWith(prefix));
}

/** A DONE anchored to the job's own id, or any FAILED: nested output can never pose as either. */
export function terminalOutcome(line: string, jobId: string): "done" | "failed" | null {
  if (line.startsWith("FAILED reason=")) return "failed";
  if (line === `DONE job=${jobId}` || line.startsWith(`DONE job=${jobId} `)) return "done";
  return null;
}

export function findTerminal(logText: string, jobId: string): "done" | "failed" | null {
  for (const line of logText.split("\n")) {
    const outcome = terminalOutcome(line, jobId);
    if (outcome) return outcome;
  }
  return null;
}

export function lastMarker(logText: string): string {
  let last = "";
  for (const line of logText.split("\n")) {
    if (isMarkerLine(line)) last = line;
  }
  return last;
}

/** Marker values are single tokens; anything a stage reports is flattened so it cannot forge a line. */
export function markerValue(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}
