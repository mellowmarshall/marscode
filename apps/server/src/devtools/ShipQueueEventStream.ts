// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Live Ship Queue status, cancellation, and fs.watch-backed SSE stream.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { execJsonTool, execTextTool, type ExecJsonResult } from "./CliProcessExec.ts";

const JOB_ID_RE = /^[0-9]{1,16}$/;
let inFlightShipStatus: Promise<ExecJsonResult> | null = null;

export function getShipQueueStatus(): Promise<ExecJsonResult> {
  if (inFlightShipStatus) return inFlightShipStatus;
  inFlightShipStatus = execJsonTool("ship-queue", ["status", "--json"], {
    timeoutMs: 15_000,
  }).finally(() => {
    inFlightShipStatus = null;
  });
  return inFlightShipStatus;
}

export async function cancelShipQueueJob(
  jobId: string,
  signal?: AbortSignal,
): Promise<ExecJsonResult> {
  if (!JOB_ID_RE.test(jobId)) {
    return { ok: false, exitCode: 2, data: null, error: "Invalid numeric job ID" };
  }
  return await execTextTool("ship-queue", ["cancel", jobId], { timeoutMs: 15_000, signal });
}

/**
 * Live SSE stream for Ship Queue panel backed by fs.watch on `<queue_root>/jobs`
 * + single-flight `ship-queue status --json` (zero polling when panel is closed).
 */
export function createShipQueueEventStream(signal: AbortSignal): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let cleanupFn: (() => void) | null = null;
  let pullFn: (() => void) | null = null;

  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        let closed = false;
        const watchers = new Map<string, NodeFS.FSWatcher>();
        let debounceTimer: ReturnType<typeof setTimeout> | null = null;
        let pollTimer: ReturnType<typeof setInterval> | null = null;
        let pingTimer: ReturnType<typeof setInterval> | null = null;
        let lastSerialized = "";
        let pendingFrame: Uint8Array | null = null;
        let jobsRootDir = "";

        const closeAllWatchers = () => {
          for (const w of watchers.values()) {
            try {
              w.close();
            } catch {
              // ignore watcher close error
            }
          }
          watchers.clear();
        };

        const finish = () => {
          if (closed) return;
          closed = true;
          pendingFrame = null;
          signal.removeEventListener("abort", finish);
          if (debounceTimer) clearTimeout(debounceTimer);
          if (pollTimer) clearInterval(pollTimer);
          if (pingTimer) clearInterval(pingTimer);
          closeAllWatchers();
          try {
            controller.close();
          } catch {
            // already closed
          }
        };
        cleanupFn = finish;

        const flushPending = () => {
          if (closed || !pendingFrame) return;
          if ((controller.desiredSize ?? 0) <= 0) return;
          const frame = pendingFrame;
          pendingFrame = null;
          try {
            controller.enqueue(frame);
          } catch {
            finish();
          }
        };

        const enqueue = (text: string) => {
          if (closed) return;
          const bytes = encoder.encode(text);
          if ((controller.desiredSize ?? 0) <= 0) {
            pendingFrame = bytes;
            return;
          }
          pendingFrame = null;
          try {
            controller.enqueue(bytes);
          } catch {
            finish();
          }
        };

        const watchDir = (dir: string, onEvent: () => void) => {
          if (closed || watchers.has(dir)) return;
          try {
            if (!NodeFS.existsSync(dir)) return;
            const w = NodeFS.watch(dir, { persistent: false }, onEvent);
            w.on("error", () => {
              try {
                w.close();
              } catch {
                // ignore
              }
              watchers.delete(dir);
            });
            watchers.set(dir, w);
          } catch {
            // ignore unwatched dir
          }
        };

        const syncJobWatchers = (data: Record<string, unknown>, onEvent: () => void) => {
          if (closed || !jobsRootDir) return;
          const desired = new Set<string>([jobsRootDir, NodePath.join(jobsRootDir, "open")]);
          const jobs = Array.isArray(data.jobs) ? data.jobs : [];
          let added = 0;
          for (const item of jobs) {
            if (added >= 64) break;
            if (!item || typeof item !== "object") continue;
            const job = item as Record<string, unknown>;
            const id = typeof job.id === "string" ? job.id : "";
            const state = typeof job.state === "string" ? job.state.toLowerCase() : "";
            if (!/^[0-9A-Za-z._-]{1,64}$/.test(id)) continue;
            if (state === "done" || state === "failed" || state === "cancelled") continue;
            desired.add(NodePath.join(jobsRootDir, id));
            added += 1;
          }
          for (const [dir, w] of watchers.entries()) {
            if (!desired.has(dir)) {
              try {
                w.close();
              } catch {
                // ignore
              }
              watchers.delete(dir);
            }
          }
          for (const dir of desired) {
            watchDir(dir, onEvent);
          }
        };

        const scheduleRefresh = () => {
          if (closed || debounceTimer) return;
          debounceTimer = setTimeout(() => {
            debounceTimer = null;
            void pushSnapshot(false);
          }, 300);
          debounceTimer.unref();
        };

        const pushSnapshot = async (force: boolean): Promise<string | null> => {
          const res = await getShipQueueStatus();
          if (closed) return null;
          if (!res.ok || res.data === null || typeof res.data !== "object") {
            if (force) {
              enqueue(
                `event: unavailable\ndata: ${JSON.stringify({ error: res.error ?? "ship-queue unavailable" })}\n\n`,
              );
              finish();
            }
            return null;
          }
          const record = res.data as Record<string, unknown>;
          const qroot =
            typeof record.queue_root === "string" && record.queue_root ? record.queue_root : null;
          if (qroot) {
            jobsRootDir = NodePath.join(qroot, "jobs");
          } else if (!jobsRootDir) {
            jobsRootDir = NodePath.join(NodeOS.homedir(), ".local", "share", "ship-queue", "jobs");
          }
          syncJobWatchers(record, scheduleRefresh);
          const serialized = JSON.stringify(res.data);
          if (force || serialized !== lastSerialized) {
            lastSerialized = serialized;
            enqueue(`event: snapshot\ndata: ${serialized}\n\n`);
          }
          return qroot;
        };

        if (signal.aborted) {
          finish();
          return;
        }
        signal.addEventListener("abort", finish, { once: true });

        void pushSnapshot(true).then(() => {
          if (closed) return;
          const pollMs = watchers.size > 0 ? 60_000 : 10_000;
          pollTimer = setInterval(() => {
            void pushSnapshot(false);
          }, pollMs);
          pollTimer.unref();

          pingTimer = setInterval(() => {
            if (!pendingFrame && (controller.desiredSize ?? 0) > 0) {
              enqueue(": ping\n\n");
            }
          }, 20_000);
          pingTimer.unref();
        });
        pullFn = flushPending;
      },
      pull() {
        pullFn?.();
      },
      cancel() {
        cleanupFn?.();
        cleanupFn = null;
        pullFn = null;
      },
    },
    { highWaterMark: 2 },
  );
}
