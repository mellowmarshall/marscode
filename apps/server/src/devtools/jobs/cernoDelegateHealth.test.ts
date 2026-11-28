// @effect-diagnostics nodeBuiltinImport:off abortControllerInEffect:off - Tests use temp cerno sidecar files and an SSE AbortController.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import {
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShellSnapshot,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import {
  agentWatchCommand,
  DELEGATE_FIXTURE as F,
  delegateProcessTable,
  procReaders,
  toPsRows,
} from "./cernoDelegateProcessTable.testFixtures.ts";
import { makeJobRegistry } from "./JobRegistry.ts";
import type { JobSummary } from "./types.ts";

const NOW_MS = 1_795_848_990_704;
const THREAD_ID = "thread-delegate-health";
const tempDirs: string[] = [];

function mkTempDir(prefix: string): string {
  const dir = NodeFS.mkdtempSync(NodePath.join("/tmp", prefix));
  NodeFS.chmodSync(dir, 0o700);
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});

/** The sidecar `cerno watch` writes to `$XDG_RUNTIME_DIR/cerno/<pid>.json`, as cerno 2.2 does. */
function writeWatchSnapshot(
  dir: string,
  input: { readonly cwd: string; readonly logPath: string },
  verdict: { readonly state: string; readonly confidence: number; readonly hang_loop: boolean },
): void {
  const payload = {
    schema_version: 1,
    pid: F.watchPid,
    child_pid: F.childPid,
    proc_start_ticks: F.watchStartTicks,
    started_at_ms: NOW_MS - 7_027,
    updated_at_ms: NOW_MS,
    elapsed_sec: 7.027,
    mode: "watch",
    engine: "cernibundus_c11_avx2_int8",
    cwd: input.cwd,
    command: "./run-suite.sh",
    log_path: input.logPath,
    outcome: "IN_PROGRESS",
    prompt: false,
    server_ready: false,
    auth_required: false,
    resource_kill: "NORMAL",
    git_conflict: "NORMAL",
    wchan: "hrtimer_nanosleep",
    cpu_active: false,
    silence_sec: 0,
    stall_timeout_sec: 8,
    alert: null,
    tail: "tick 1\ntick 2\n",
    ...verdict,
  };
  NodeFS.writeFileSync(NodePath.join(dir, `${F.watchPid}.json`), JSON.stringify(payload), "utf8");
}

const emptyShell: OrchestrationV2ThreadShellSnapshot = {
  schemaVersion: 1,
  snapshotSequence: 0,
  threads: [],
  archivedThreads: [],
};

function commandItemEvent(command: string): OrchestrationV2DomainEvent {
  const nowUtc = DateTime.makeUnsafe(NOW_MS);
  return {
    type: "turn-item.updated",
    threadId: ThreadId.make(THREAD_ID),
    occurredAt: nowUtc,
    payload: {
      id: TurnItemId.make("item-delegate-watch"),
      threadId: ThreadId.make(THREAD_ID),
      runId: "run:1",
      nodeId: "node:1",
      providerThreadId: "pt:1",
      providerTurnId: "turn:1",
      nativeItemRef: { driver: "antigravity", nativeId: "call_1", strength: "strong" },
      parentItemId: null,
      ordinal: 1,
      type: "command_execution",
      driver: "antigravity",
      status: "running",
      title: "Ran command",
      input: command,
      output: null,
      exitCode: null,
      startedAt: nowUtc,
      completedAt: null,
      updatedAt: nowUtc,
    },
  } as unknown as OrchestrationV2DomainEvent;
}

function lastUpsert(chunks: ReadonlyArray<string>, id: string): JobSummary | undefined {
  const frames = chunks
    .join("")
    .split("\n\n")
    .filter((f) => f.startsWith("event: upsert\ndata: "))
    .map((f) => JSON.parse(f.slice("event: upsert\ndata: ".length)) as JobSummary)
    .filter((s) => s.id === id);
  return frames.at(-1);
}

describe("cerno health through the bash delegate", () => {
  it.effect(
    "an agent's cerno watch job keeps its health bar and load when its command item hides it",
    () =>
      Effect.gen(function* () {
        const snapDir = mkTempDir("t3-delegate-snap-");
        const workDir = mkTempDir("t3-delegate-work-");
        const logPath = NodePath.join(workDir, "run.log");
        NodeFS.writeFileSync(logPath, "tick 1\ntick 2\n", "utf8");
        const table = delegateProcessTable({ threadId: THREAD_ID, logPath });
        const healthy = { state: "RUNNING", confidence: 1, hang_loop: false };
        writeWatchSnapshot(snapDir, { cwd: workDir, logPath }, healthy);

        const domainEvents = yield* PubSub.unbounded<OrchestrationV2DomainEvent>();
        const registry = makeJobRegistry({
          enableShipBridge: false,
          cernoBridge: {
            ...procReaders(table),
            snapshotDirs: [snapDir],
            platform: "linux",
            localHostname: "host-a",
            ciHostsPath: null,
            expectedUid: null,
            pollIntervalMs: 60_000,
            nowMs: () => NOW_MS,
            isWorkspaceAllowed: async (p) => p.startsWith(workDir),
          },
          backgroundBridge: {
            localHostname: "host-a",
            ciHostsPath: null,
            commandDebounceMs: 10,
            getShellSnapshot: async () => emptyShell,
            getRunningCommandsForThread: async () => [],
            streamDomainEvents: Stream.fromPubSub(domainEvents),
            subscribeCommandOutput: () => Stream.empty,
            stopThread: async () => ({ ok: true }),
            isWorkspaceAllowed: async (p) => p.startsWith(workDir),
          },
        });

        const sseAbort = new AbortController();
        const chunks: string[] = [];
        const reader = registry.createEventsStream(sseAbort.signal).getReader();
        const decoder = new TextDecoder();
        const drain = (async () => {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              chunks.push(decoder.decode(value, { stream: true }));
            }
          } catch {
            // aborted on cleanup
          }
        })();
        yield* Effect.addFinalizer(() =>
          Effect.promise(async () => {
            sseAbort.abort();
            await registry.dispose();
            await drain;
          }),
        );

        // Only the `cerno watch` has a sidecar: the delegate shells are not cerno jobs.
        const before = yield* Effect.promise(() => registry.listJobs({ refresh: true }));
        const watchJobId = `cerno:${F.watchPid}:${F.watchStartTicks}`;
        expect(before.map((j) => j.id)).toEqual([watchJobId]);
        expect(before[0]?.binding.threadId).toBe(THREAD_ID);
        expect(before[0]?.cerno?.pips).toBe(4);

        // The provider reports the agent's command; its job hides the cerno job.
        yield* PubSub.publish(domainEvents, commandItemEvent(agentWatchCommand(logPath)));
        const bg = yield* Effect.promise(() =>
          vi.waitFor(async () => {
            const jobs = await registry.listJobs({ threadId: THREAD_ID });
            expect(jobs).toHaveLength(1);
            expect(jobs[0]!.id.startsWith("bg:")).toBe(true);
            return jobs[0]!;
          }),
        );
        expect(bg.cerno).toMatchObject({ state: "RUNNING", pips: 4, label: "Healthy" });
        yield* Effect.promise(() =>
          vi.waitFor(() => expect(lastUpsert(chunks, bg.id)?.cerno?.pips).toBe(4)),
        );

        // Load is the `cerno watch` tree only, never the delegate shells around it.
        yield* Effect.promise(() => registry.applyProcessTable(toPsRows(table)));
        const [loaded] = yield* Effect.promise(() => registry.listJobs({ threadId: THREAD_ID }));
        const watchTree = table.filter((p) =>
          [F.watchPid, F.childPid, F.workerPid, F.watchMonitorPid].includes(p.pid as never),
        );
        expect(loaded?.load).toEqual({
          cpuPct: Math.round(watchTree.reduce((sum, p) => sum + p.cpuPct, 0)),
          memBytes: watchTree.reduce((sum, p) => sum + p.rssKb * 1024, 0),
          processCount: 4,
        });
        expect(loaded?.cerno?.pips).toBe(4);

        // A verdict change reaches the hiding job and its stream.
        writeWatchSnapshot(
          snapDir,
          { cwd: workDir, logPath },
          { state: "STUCK_LOOP", confidence: 0.6, hang_loop: true },
        );
        const [stalled] = yield* Effect.promise(() =>
          registry.listJobs({ threadId: THREAD_ID, refresh: true }),
        );
        expect(stalled?.id).toBe(bg.id);
        expect(stalled?.cerno).toMatchObject({ pips: 2, label: "Stalled", tone: "destructive" });
        yield* Effect.promise(() =>
          vi.waitFor(() => expect(lastUpsert(chunks, bg.id)?.cerno?.label).toBe("Stalled")),
        );
        const detail = yield* Effect.promise(() => registry.getJobDetail(bg.id));
        expect(detail?.cerno?.label).toBe("Stalled");
      }),
  );
});
