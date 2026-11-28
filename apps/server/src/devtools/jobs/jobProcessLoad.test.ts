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
  aggregateProcessTree,
  collectJobLoadTargets,
  indexProcessTable,
  JobProcessLoadTracker,
  shouldPublishJobLoad,
  type ProcessTableRow,
} from "./jobProcessLoad.ts";
import { makeJobRegistry } from "./JobRegistry.ts";
import type { JobSummary } from "./types.ts";

const MiB = 1024 * 1024;
const FIXED_NOW_MS = 1_795_636_790_000;
const ROOT_PID = 424242;
const START_TICKS = 777001;
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

function row(pid: number, ppid: number, cpuPct: number, memMiB: number): ProcessTableRow {
  return { pid, ppid, cpuPct, memBytes: memMiB * MiB };
}

/** cerno (root) -> vitest -> two workers, plus an unrelated process and its child. */
function jobTable(workerCpu: number, workerMemMiB: number): ReadonlyArray<ProcessTableRow> {
  return [
    row(ROOT_PID, 1000, 0.4, 8),
    row(ROOT_PID + 1, ROOT_PID, 12.3, 150),
    row(ROOT_PID + 2, ROOT_PID + 1, workerCpu, workerMemMiB),
    row(ROOT_PID + 3, ROOT_PID + 1, workerCpu, workerMemMiB),
    row(5000, 1000, 99, 4000),
    row(5001, 5000, 50, 100),
  ];
}

function summary(overrides: Partial<JobSummary> & Pick<JobSummary, "id">): JobSummary {
  return {
    revision: 1,
    source: "background",
    kind: "command",
    title: "job",
    phaseLabel: "Running",
    state: "running",
    binding: { host: "host-a" },
    timing: { startedAt: "2026-11-25T19:49:50.000Z" },
    cancellable: true,
    ...overrides,
  };
}

describe("job process load", () => {
  it("sums the root and every descendant, and nothing outside the tree", () => {
    const index = indexProcessTable(jobTable(80.2, 300));
    expect(aggregateProcessTree(index, ROOT_PID)).toEqual({
      cpuPct: 173,
      memBytes: (8 + 150 + 300 + 300) * MiB,
      processCount: 4,
    });
    expect(aggregateProcessTree(index, ROOT_PID + 1)).toMatchObject({ processCount: 3 });
    expect(aggregateProcessTree(index, 999_999)).toBeUndefined();
  });

  it("terminates on a ppid cycle", () => {
    const index = indexProcessTable([row(10, 11, 1, 1), row(11, 10, 2, 1)]);
    expect(aggregateProcessTree(index, 10)).toEqual({
      cpuPct: 3,
      memBytes: 2 * MiB,
      processCount: 2,
    });
  });

  it("publishes only CPU moves of 5 points or memory moves of max(64 MiB, 10%)", () => {
    const base = { cpuPct: 100, memBytes: 512 * MiB, processCount: 4 };
    expect(shouldPublishJobLoad(undefined, base)).toBe(true);
    expect(shouldPublishJobLoad(base, { ...base, cpuPct: 104, processCount: 9 })).toBe(false);
    expect(shouldPublishJobLoad(base, { ...base, cpuPct: 95 })).toBe(true);
    expect(shouldPublishJobLoad(base, { ...base, memBytes: 575 * MiB })).toBe(false);
    expect(shouldPublishJobLoad(base, { ...base, memBytes: 576 * MiB })).toBe(true);
    const big = { ...base, memBytes: 8192 * MiB };
    expect(shouldPublishJobLoad(big, { ...big, memBytes: 8900 * MiB })).toBe(false);
    expect(shouldPublishJobLoad(big, { ...big, memBytes: 9100 * MiB })).toBe(true);
  });

  it("targets only live local jobs with a known root PID", () => {
    const targets = collectJobLoadTargets({
      localHostname: "host-a",
      cernoSummaries: [
        summary({ id: "cerno:1", pidStats: { pid: 11, alive: true } }),
        summary({ id: "cerno:2", pidStats: { pid: 12, alive: true }, binding: { host: "b" } }),
        summary({ id: "cerno:3", pidStats: { pid: 13, alive: false }, state: "done" }),
      ],
      backgroundSummaries: [
        summary({ id: "bg:matched" }),
        summary({ id: "bg:unmatched" }),
        summary({ id: "bg:ended", state: "exited" }),
      ],
      rootPidForBackgroundJob: (id) => (id === "bg:unmatched" ? undefined : 21),
    });
    expect(targets).toEqual([
      { id: "cerno:1", rootPid: 11 },
      { id: "bg:matched", rootPid: 21 },
    ]);
  });

  it("keeps the published value through small changes, drops vanished and stale loads", () => {
    let now = FIXED_NOW_MS;
    const tracker = new JobProcessLoadTracker(() => now);
    const job = summary({ id: "cerno:1" });
    const target = [{ id: "cerno:1", rootPid: ROOT_PID }];

    expect(tracker.attach(job).load).toBeUndefined();
    expect(tracker.apply(jobTable(80, 300), target)).toEqual(["cerno:1"]);
    expect(tracker.attach(job).load?.cpuPct).toBe(173);

    expect(tracker.apply(jobTable(81, 310), target)).toEqual([]);
    expect(tracker.attach(job).load?.cpuPct).toBe(173);

    expect(tracker.apply(jobTable(10, 300), target)).toEqual(["cerno:1"]);
    expect(tracker.attach(job).load?.cpuPct).toBe(33);
    expect(tracker.attach({ ...job, state: "failed" }).load).toBeUndefined();

    now += 91_000;
    expect(tracker.attach(job).load).toBeUndefined();

    expect(tracker.apply([row(5000, 1000, 99, 4000)], target)).toEqual(["cerno:1"]);
    expect(tracker.attach(job).load).toBeUndefined();
  });
});

function writeSnapshot(dir: string, overrides: Record<string, unknown>): void {
  const payload = {
    schema_version: 1,
    pid: ROOT_PID,
    child_pid: ROOT_PID + 1,
    proc_start_ticks: START_TICKS,
    started_at_ms: FIXED_NOW_MS - 600_000,
    updated_at_ms: FIXED_NOW_MS,
    elapsed_sec: 600,
    mode: "watch-monitor",
    state: "RUNNING",
    confidence: 1.0,
    outcome: "IN_PROGRESS",
    prompt: false,
    hang_loop: false,
    server_ready: false,
    cpu_active: true,
    alert: null,
    tail: "RUN v4\n",
    ...overrides,
  };
  NodeFS.writeFileSync(NodePath.join(dir, `${ROOT_PID}.json`), JSON.stringify(payload), "utf8");
}

const emptyShell: OrchestrationV2ThreadShellSnapshot = {
  schemaVersion: 1,
  snapshotSequence: 0,
  threads: [],
  archivedThreads: [],
};

function makeRegistry(input: {
  readonly snapDir: string;
  readonly workDir: string;
  readonly threadId: string;
  readonly domainStream: Stream.Stream<OrchestrationV2DomainEvent>;
}) {
  return makeJobRegistry({
    enableShipBridge: false,
    cernoBridge: {
      snapshotDirs: [input.snapDir],
      platform: "linux",
      localHostname: "host-a",
      ciHostsPath: null,
      expectedUid: null,
      pollIntervalMs: 60_000,
      nowMs: () => FIXED_NOW_MS,
      isPidAlive: (pid) => pid === ROOT_PID,
      readProcStartTicks: async (pid) => (pid === ROOT_PID ? START_TICKS : null),
      isCernoProcess: async () => true,
      resolveThreadId: async () => input.threadId,
      isWorkspaceAllowed: async (p) => p.startsWith(input.workDir),
    },
    backgroundBridge: {
      localHostname: "host-a",
      ciHostsPath: null,
      commandDebounceMs: 10,
      getShellSnapshot: async () => emptyShell,
      getRunningCommandsForThread: async () => [],
      streamDomainEvents: input.domainStream,
      subscribeCommandOutput: () => Stream.empty,
      stopThread: async () => ({ ok: true }),
      isWorkspaceAllowed: async (p) => p.startsWith(input.workDir),
    },
  });
}

describe("JobRegistry process load", () => {
  it.effect("attaches tree load to a live cerno job and streams it as an upsert", () =>
    Effect.gen(function* () {
      const snapDir = mkTempDir("t3-load-snap-");
      const workDir = mkTempDir("t3-load-work-");
      writeSnapshot(snapDir, { cwd: workDir, command: "vp test run", log_path: "run.log" });
      const threadId = "thread-load-cerno";
      const domainEvents = yield* PubSub.unbounded<OrchestrationV2DomainEvent>();
      const registry = makeRegistry({
        snapDir,
        workDir,
        threadId,
        domainStream: Stream.fromPubSub(domainEvents),
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

      const [before] = yield* Effect.promise(() => registry.listJobs({ refresh: true }));
      expect(before?.id).toBe(`cerno:${ROOT_PID}:${START_TICKS}`);
      expect(before?.binding.host).toBe("host-a");
      expect(before?.load).toBeUndefined();
      yield* Effect.promise(() => vi.waitFor(() => expect(chunks.join("")).toContain("snapshot")));

      registry.applyProcessTable(jobTable(80, 300));
      const expectedLoad = { cpuPct: 173, memBytes: 758 * MiB, processCount: 4 };
      const [after] = yield* Effect.promise(() => registry.listJobs({ includeCmdline: false }));
      expect(after?.load).toEqual(expectedLoad);
      expect(after?.pidStats?.cmdline).toBeUndefined();
      yield* Effect.promise(() =>
        // The broadcaster coalesces non-urgent deltas for 1 s before the upsert frame.
        vi.waitFor(
          () => expect(chunks.join("")).toContain(`"load":${JSON.stringify(expectedLoad)}`),
          { timeout: 3_000 },
        ),
      );

      registry.applyProcessTable(jobTable(81, 310));
      const [steady] = yield* Effect.promise(() => registry.listJobs());
      expect(steady?.load).toEqual(expectedLoad);
      expect(steady?.revision).toBe(after?.revision);
    }),
  );

  it.effect("attaches load to a live background command matched to its cerno process", () =>
    Effect.gen(function* () {
      const snapDir = mkTempDir("t3-load-snap-");
      const workDir = mkTempDir("t3-load-work-");
      const logPath = NodePath.join(workDir, "run.log");
      NodeFS.writeFileSync(logPath, "RUN v4\n", "utf8");
      writeSnapshot(snapDir, { cwd: workDir, command: "vp test run", log_path: "run.log" });
      const threadId = "thread-load-bg";
      const domainEvents = yield* PubSub.unbounded<OrchestrationV2DomainEvent>();
      const registry = makeRegistry({
        snapDir,
        workDir,
        threadId,
        domainStream: Stream.fromPubSub(domainEvents),
      });
      yield* Effect.addFinalizer(() => Effect.promise(() => registry.dispose()));
      yield* Effect.promise(() => registry.listJobs({ threadId, refresh: true }));

      const nowUtc = DateTime.makeUnsafe(FIXED_NOW_MS);
      yield* PubSub.publish(domainEvents, {
        type: "turn-item.updated",
        threadId: ThreadId.make(threadId),
        occurredAt: nowUtc,
        payload: {
          id: TurnItemId.make("item-load-bg"),
          threadId: ThreadId.make(threadId),
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
          input: `cerno watch --monitor --log ${logPath} -- vp test run`,
          output: null,
          exitCode: null,
          startedAt: nowUtc,
          completedAt: null,
          updatedAt: nowUtc,
        },
      } as unknown as OrchestrationV2DomainEvent);

      const bgId = yield* Effect.promise(() =>
        vi.waitFor(async () => {
          const jobs = await registry.listJobs({ threadId });
          expect(jobs).toHaveLength(1);
          expect(jobs[0]!.id.startsWith("bg:")).toBe(true);
          return jobs[0]!.id;
        }),
      );

      registry.applyProcessTable(jobTable(40, 200));
      const [job] = yield* Effect.promise(() => registry.listJobs({ threadId }));
      expect(job?.id).toBe(bgId);
      expect(job?.load).toEqual({ cpuPct: 93, memBytes: 558 * MiB, processCount: 4 });
    }),
  );
});
