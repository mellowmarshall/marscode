// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - `ship-queue watch`: tails a job's markers until it ends, goes quiet, or needs the owner.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { overrideRequestPath } from "./challengeGate.ts";
import {
  isEnded,
  jobDir,
  jobLogPath,
  jobReviewPath,
  mark,
  readJob,
  readLog,
  registerWatcher,
} from "./jobStore.ts";
import { findTerminal, isMarkerLine } from "./markers.ts";
import type { ProcessIdentity } from "./processIdentity.ts";
import type { Clock } from "./types.ts";

export const WATCH_EXIT = {
  done: 0,
  failed: 1,
  quiet: 2,
  actionRequired: 3,
  challenged: 4,
} as const;

/** Incremental reader of a job log's complete marker lines; a partial last line waits for its newline. */
export class MarkerTail {
  private offset = 0;
  private carry = "";
  private readonly logPath: string;

  constructor(logPath: string) {
    this.logPath = logPath;
  }

  get bytesRead(): number {
    return this.offset;
  }

  poll(): string[] {
    let size: number;
    try {
      size = NodeFS.statSync(this.logPath).size;
    } catch {
      return [];
    }
    if (size < this.offset) {
      this.offset = 0;
      this.carry = "";
    }
    if (size === this.offset) return [];
    const fd = NodeFS.openSync(this.logPath, "r");
    let text: string;
    try {
      const buf = Buffer.alloc(size - this.offset);
      const n = NodeFS.readSync(fd, buf, 0, buf.length, this.offset);
      this.offset += n;
      text = this.carry + buf.subarray(0, n).toString("utf8");
    } finally {
      NodeFS.closeSync(fd);
    }
    const lines = text.split("\n");
    this.carry = lines.pop() ?? "";
    return lines.filter(isMarkerLine);
  }
}

export interface WatchOptions {
  readonly root: string;
  readonly id: string;
  readonly self: ProcessIdentity;
  readonly clock: Clock;
  readonly quietMs: number;
  readonly write: (line: string) => void;
  /** Resolves when the log may have moved; the CLI waits on a file watch with a poll fallback. */
  readonly waitForChange: () => Promise<void>;
  /** Called while the job is open, so a job whose worker never started or died is picked up again. */
  readonly ensureWorker?: (() => void) | undefined;
}

const actionSeenPath = (root: string, id: string) => NodePath.join(jobDir(root, id), "action_seen");

function readSeen(path: string): string {
  try {
    return NodeFS.readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}

function elapsedMs(from: string, to: string): number {
  const ms = Date.parse(to) - Date.parse(from);
  return Number.isFinite(ms) ? ms : 0;
}

function emitReviewIfPresent(root: string, id: string, write: (line: string) => void): void {
  let review = "";
  try {
    review = NodeFS.readFileSync(jobReviewPath(root, id), "utf8").trimEnd();
  } catch {
    return;
  }
  if (!review) return;
  write(`REVIEW job=${id} (the playbook reviewer's outcome):`);
  for (const line of review.split("\n")) write(`  ${line}`);
  write(
    "AGENT: quote this review to the owner in full in your reply now, pass or not; it is posted on the PR too.",
  );
}

/**
 * Prints each marker as it lands. Exits 0 on `DONE job=`, 1 on `FAILED reason=`, 2 with `QUIET job=`
 * when a running job's log has not moved in `quietMs`, 3 the first time a watch sees the job
 * waiting on an owner action it has not reported yet, and 4 whenever the job waits on a CHALLENGED
 * playbook review (`CHALLENGED job=`) with no override pending.
 */
export async function watchJob(options: WatchOptions): Promise<number> {
  const { root, id, clock, write } = options;
  if (!readJob(root, id)) throw new Error(`no such job: ${id} in ${root}`);
  const unregister = registerWatcher(root, id, options.self);
  const tail = new MarkerTail(jobLogPath(root, id));
  let lastMovedAt = clock.now();
  let lastBytes = -1;
  try {
    for (;;) {
      // Ask whether the job is over before reading, so the read that follows holds its last line.
      const before = readJob(root, id);
      const terminal = findTerminal(readLog(root, id), id);
      const lines = tail.poll();
      for (const line of lines) write(line);
      if (terminal) {
        emitReviewIfPresent(root, id, write);
        return terminal === "done" ? WATCH_EXIT.done : WATCH_EXIT.failed;
      }
      if (before && isEnded(before)) {
        const late = findTerminal(readLog(root, id), id);
        if (late) {
          for (const line of tail.poll()) write(line);
          emitReviewIfPresent(root, id, write);
          return late === "done" ? WATCH_EXIT.done : WATCH_EXIT.failed;
        }
        if (before.state === "done") {
          emitReviewIfPresent(root, id, write);
          return WATCH_EXIT.done;
        }
        write(
          `FAILED reason=${before.reason ?? "unknown"} (from the job record; its log has no terminal line)`,
        );
        emitReviewIfPresent(root, id, write);
        return WATCH_EXIT.failed;
      }

      const job = readJob(root, id);
      if (job && !isEnded(job)) options.ensureWorker?.();
      if (job?.state === "waiting" && job.waiting_for === "action" && job.action_digest) {
        if (readSeen(actionSeenPath(root, id)) !== job.action_digest) {
          NodeFS.writeFileSync(actionSeenPath(root, id), job.action_digest);
          write(
            `watch: job ${id} waits for the owner; once approved it resumes on its own and your thread is told (after a MarsCode restart, cancel and resubmit instead). To follow it: ship-queue watch ${id}`,
          );
          return WATCH_EXIT.actionRequired;
        }
      }

      // Every watch of a challenged job hands the decision back, until an override is pending.
      if (
        job?.state === "waiting" &&
        job.waiting_for === "challenge" &&
        !NodeFS.existsSync(overrideRequestPath(root, id))
      ) {
        emitReviewIfPresent(root, id, write);
        write(
          `watch: job ${id} stopped before merge on its CHALLENGED playbook review. You decide: fix the findings, commit, and submit the branch again (the new job replaces this one; watch the new job), or ship as is with: ship-queue override ${id} --reason "<why the findings do not hold>" (the reason goes in the job log and the PR body), then: ship-queue watch ${id}`,
        );
        return WATCH_EXIT.challenged;
      }

      const now = clock.now();
      if (tail.bytesRead !== lastBytes) {
        lastBytes = tail.bytesRead;
        lastMovedAt = now;
      } else if (job?.state === "running" && !job.waiting_for) {
        const quietFor = elapsedMs(lastMovedAt, now);
        if (quietFor >= options.quietMs) {
          const line = `QUIET job=${id} at=${now}: no log of the job has moved in ${Math.round(quietFor / 1000)}s; the job keeps running. Look, then arm the watch again (ship-queue watch ${id}) or cancel (ship-queue cancel ${id})`;
          write(line);
          mark(root, id, line);
          return WATCH_EXIT.quiet;
        }
      } else {
        lastMovedAt = now;
      }
      await options.waitForChange();
    }
  } finally {
    unregister();
  }
}

/** Resolves on the next change under the job directory, or after `pollMs` at the latest. */
export function fileChangeWaiter(root: string, id: string, pollMs: number): () => Promise<void> {
  return () =>
    new Promise<void>((resolve) => {
      let watcher: NodeFS.FSWatcher | null = null;
      const done = () => {
        clearTimeout(timer);
        watcher?.close();
        resolve();
      };
      const timer = setTimeout(done, pollMs);
      try {
        watcher = NodeFS.watch(jobDir(root, id), done);
      } catch {
        watcher = null;
      }
    });
}
