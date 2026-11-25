// @effect-diagnostics nodeBuiltinImport:off abortControllerInEffect:off - Tests exercise real Linux procfs, temp sidecar files, and SSE AbortController.
import * as NodeChildProcess from "node:child_process";
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

import { CernoProcessBridge, cernoMatchesBackgroundJob } from "./CernoProcessBridge.ts";
import { readProcStartTicks } from "./cernoSnapshotReader.ts";
import { makeJobRegistry } from "./JobRegistry.ts";
import type { JobSummary } from "./types.ts";

const FIXED_NOW_MS = 1_795_636_790_000;
const tempDirs: string[] = [];

function mkTempDir(prefix: string, mode = 0o700): string {
  const dir = NodeFS.mkdtempSync(NodePath.join("/tmp", prefix));
  NodeFS.chmodSync(dir, mode);
  tempDirs.push(dir);
  return dir;
}

function writeSnapshot(
  dir: string,
  filename: string,
  overrides: Partial<Record<string, unknown>> = {},
): string {
  const pid = typeof overrides.pid === "number" ? overrides.pid : 1337797;
  const payload = {
    schema_version: 1,
    pid,
    child_pid: pid + 1,
    proc_start_ticks: 6633455,
    started_at_ms: FIXED_NOW_MS - 3_600_000,
    updated_at_ms: FIXED_NOW_MS,
    elapsed_sec: 3600,
    mode: "watch-monitor",
    engine: "cernibundus_c11_avx2_int8",
    cwd: "/home/dev/Dev/private-repo",
    command:
      "ssh -o ServerAliveInterval=30 -o ServerAliveCountMax=20 dev-host-x set -euo pipefail echo build",
    log_path: "/tmp/ue59_setup_build.log",
    state: "RUNNING",
    confidence: 1.0,
    margin: 19.2,
    outcome: "IN_PROGRESS",
    prompt: false,
    hang_loop: false,
    server_ready: false,
    auth_required: false,
    resource_kill: "NORMAL",
    git_conflict: "NORMAL",
    cpu_active: false,
    has_remote_socket: true,
    silence_sec: 7200,
    alert: null,
    tail: "=== STAGE 2: UE 5.9 FULL BUILD ===\n",
    ...overrides,
  };
  const filePath = NodePath.join(dir, filename);
  NodeFS.writeFileSync(filePath, JSON.stringify(payload), "utf8");
  return filePath;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
});

describe("CernoProcessBridge", () => {
  it("surfaces a live cerno watch snapshot bound to its T3 thread, host, log tail, and verdict", async () => {
    const snapDir = mkTempDir("t3-cerno-snap-");
    const logPath = NodePath.join(snapDir, "ue59_setup_build.log");
    NodeFS.writeFileSync(
      logPath,
      "Following active UE 5.9 setup\n[3427/3798] Compile EclipseRaidEditor\n",
      "utf8",
    );
    writeSnapshot(snapDir, "1337797.json", { log_path: logPath });

    const bridge = new CernoProcessBridge({
      snapshotDirs: [snapDir],
      platform: "linux",
      localHostname: "dev-host-x",
      ciHostsPath: null,
      expectedUid: null,
      nowMs: () => FIXED_NOW_MS,
      isPidAlive: (pid) => pid === 1337797,
      readProcStartTicks: async (pid) => (pid === 1337797 ? 6633455 : null),
      readProcRssBytes: async () => 18 * 1024 * 1024,
      resolveThreadId: async () => "thread-ue59",
      isWorkspaceAllowed: async (p) => p.startsWith(snapDir),
    });

    try {
      await bridge.refresh();
      const jobs = bridge.listSummaries();
      expect(jobs).toHaveLength(1);
      const job = jobs[0]!;
      expect(job.id).toBe("cerno:1337797:6633455");
      expect(job.source).toBe("background");
      expect(job.state).toBe("running");
      expect(job.binding.threadId).toBe("thread-ue59");
      expect(job.binding.host).toBe("dev-host-x");
      expect(job.title).toBe("dev-host-x: ue59_setup_build");
      expect(job.cancellable).toBe(true);
      expect(job.recentTail).toContain("[3427/3798] Compile EclipseRaidEditor");

      const detail = bridge.getDetail(job.id);
      expect(detail?.cerno?.summary).toContain("RUNNING (100%)");
      expect(detail?.cerno?.summary).toContain("remote socket");
      expect(detail?.pidStats).toMatchObject({
        pid: 1337797,
        alive: true,
        rssBytes: 18 * 1024 * 1024,
      });
      expect(detail?.logPath).toBe(NodeFS.realpathSync(logPath));
    } finally {
      bridge.dispose();
    }
  });

  it("blocks reading sensitive or disallowed log_path files into logTail", async () => {
    const snapDir = mkTempDir("t3-cerno-allowlist-");
    const fakeAwsDir = NodePath.join(snapDir, ".aws");
    NodeFS.mkdirSync(fakeAwsDir, { recursive: true });
    const credsPath = NodePath.join(fakeAwsDir, "credentials");
    NodeFS.writeFileSync(
      credsPath,
      "[default]\naws_secret_access_key=SUPER_SECRET_DO_NOT_LEAK_1234567890\n",
      "utf8",
    );
    writeSnapshot(snapDir, "4040.json", {
      pid: 4040,
      proc_start_ticks: 40401,
      log_path: credsPath,
      tail: "safe snapshot tail only\n",
    });

    const bridge = new CernoProcessBridge({
      snapshotDirs: [snapDir],
      platform: "linux",
      ciHostsPath: null,
      expectedUid: null,
      nowMs: () => FIXED_NOW_MS,
      isPidAlive: () => true,
      readProcStartTicks: async () => 40401,
      resolveThreadId: async () => "thread-sec",
      isWorkspaceAllowed: async () => true,
    });

    try {
      await bridge.refresh();
      const detail = bridge.getDetail("cerno:4040:40401");
      expect(detail?.logTail).toEqual(["safe snapshot tail only"]);
      expect(detail?.logTail.join("\n")).not.toContain("SUPER_SECRET");
    } finally {
      bridge.dispose();
    }
  });

  it("rejects world-writable and symlinked snapshot directories", async () => {
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    if (uid === null) return;
    const worldDir = mkTempDir("t3-cerno-world-", 0o777);
    writeSnapshot(worldDir, "501.json", { pid: 501, proc_start_ticks: 5011 });

    const realDir = mkTempDir("t3-cerno-real-", 0o700);
    writeSnapshot(realDir, "502.json", { pid: 502, proc_start_ticks: 5022 });
    const linkParent = mkTempDir("t3-cerno-linkparent-", 0o700);
    const symlinkDir = NodePath.join(linkParent, "cerno-link");
    NodeFS.symlinkSync(realDir, symlinkDir);

    const bridge = new CernoProcessBridge({
      snapshotDirs: [worldDir, symlinkDir],
      platform: "linux",
      ciHostsPath: null,
      expectedUid: uid,
      nowMs: () => FIXED_NOW_MS,
      isPidAlive: () => true,
      readProcStartTicks: async (pid) => (pid === 501 ? 5011 : 5022),
      resolveThreadId: async () => "thread-bad-dir",
    });

    try {
      await bridge.refresh();
      expect(bridge.listSummaries()).toHaveLength(0);
    } finally {
      bridge.dispose();
    }
  });

  it("skips ship-queue wrapped commands, symlinks, and PID-reused snapshots", async () => {
    const snapDir = mkTempDir("t3-cerno-filter-");
    writeSnapshot(snapDir, "101.json", {
      pid: 101,
      proc_start_ticks: 1001,
      command: "ship-queue watch 9102",
      log_path: "/tmp/sq.log",
    });
    writeSnapshot(snapDir, "102.json", {
      pid: 102,
      proc_start_ticks: 1002,
      mode: "tail-monitor",
      command: "/data/Dev/.ship-queue/jobs/9102/job.log",
      log_path: "/data/Dev/.ship-queue/jobs/9102/job.log",
    });
    writeSnapshot(snapDir, "103.json", {
      pid: 103,
      proc_start_ticks: 9999,
      command: "cargo test --workspace",
      log_path: "/tmp/cargo.log",
    });
    const outside = writeSnapshot(mkTempDir("t3-cerno-ext-"), "104.json", {
      pid: 104,
      proc_start_ticks: 1004,
      command: "pytest tests/",
      log_path: "/tmp/pytest.log",
    });
    NodeFS.symlinkSync(outside, NodePath.join(snapDir, "104.json"));

    const bridge = new CernoProcessBridge({
      snapshotDirs: [snapDir],
      platform: "linux",
      ciHostsPath: null,
      expectedUid: null,
      nowMs: () => FIXED_NOW_MS,
      isPidAlive: () => true,
      readProcStartTicks: async (pid) => (pid === 103 ? 5555 : pid + 900),
      resolveThreadId: async () => "thread-a",
    });

    try {
      await bridge.refresh();
      expect(bridge.listSummaries()).toHaveLength(0);
    } finally {
      bridge.dispose();
    }
  });

  it("verifies proc_start_ticks and cerno cmdline before SIGTERM, and reverts cancelling after timeout", async () => {
    const snapDir = mkTempDir("t3-cerno-cancel-");
    writeSnapshot(snapDir, "2020.json", {
      pid: 2020,
      proc_start_ticks: 77777,
      command: "python3 train.py",
      log_path: null,
    });
    let currentTicks = 77777;
    let isCerno = false;
    let clockMs = FIXED_NOW_MS;
    const killed: Array<{ pid: number; signal: string }> = [];

    const bridge = new CernoProcessBridge({
      snapshotDirs: [snapDir],
      platform: "linux",
      ciHostsPath: null,
      expectedUid: null,
      cancelTimeoutMs: 10_000,
      nowMs: () => clockMs,
      isPidAlive: () => true,
      readProcStartTicks: async () => currentTicks,
      isCernoProcess: async () => isCerno,
      resolveThreadId: async () => "thread-train",
      killPid: (pid, signal) => {
        killed.push({ pid, signal });
      },
    });

    try {
      await bridge.refresh();
      const id = "cerno:2020:77777";

      // Non-cerno process cmdline must be refused.
      const nonCerno = await bridge.cancelJob(id);
      expect(nonCerno.ok).toBe(false);
      expect(nonCerno.error).toContain("non-cerno");
      expect(killed).toHaveLength(0);

      // Valid cerno process receives SIGTERM and enters cancelling state.
      isCerno = true;
      const okRes = await bridge.cancelJob(id);
      expect(okRes.ok).toBe(true);
      expect(killed).toEqual([{ pid: 2020, signal: "SIGTERM" }]);
      expect(bridge.getSummary(id)?.state).toBe("cancelling");

      // If process ignores SIGTERM past cancelTimeoutMs, revert to running + cancellable.
      clockMs += 15_000;
      await bridge.refresh();
      const reverted = bridge.getSummary(id);
      expect(reverted?.state).toBe("running");
      expect(reverted?.cancellable).toBe(true);
      expect(reverted?.anomaly).toContain("did not exit after SIGTERM");

      // PID reuse (start_ticks mismatch) must be rejected without signalling.
      currentTicks = 88888;
      const reused = await bridge.cancelJob(id);
      expect(reused.ok).toBe(false);
      expect(reused.error).toContain("reused");
      expect(killed).toHaveLength(1);
    } finally {
      bridge.dispose();
    }
  });

  it.effect(
    "deduplicates live bg jobs, hides bogus terminal bg cards, and emits SSE takeover even when listJobs races",
    () =>
      Effect.gen(function* () {
        const snapDir = mkTempDir("t3-cerno-takeover-");
        const workDir = mkTempDir("t3-cerno-work-");
        const logPath = NodePath.join(workDir, "ue59_setup_build.log");
        NodeFS.writeFileSync(logPath, "=== STAGE 2: UE 5.9 FULL BUILD ===\n", "utf8");
        const threadId = "mcp:launch:ue59-thread";
        let pidAlive = true;

        // Use a RELATIVE log_path inside workDir to verify Finding #3 (relative path matching).
        writeSnapshot(snapDir, "1337797.json", {
          pid: 1337797,
          proc_start_ticks: 6633455,
          cwd: workDir,
          log_path: "ue59_setup_build.log",
          command: "ssh -o ServerAliveInterval=30 dev-host-x engine_launch_7a34.sh build",
        });

        const domainEvents = yield* PubSub.unbounded<OrchestrationV2DomainEvent>();
        const domainStream = Stream.fromPubSub(domainEvents);
        const nowUtc = DateTime.makeUnsafe(FIXED_NOW_MS);
        const emptySnapshot: OrchestrationV2ThreadShellSnapshot = {
          schemaVersion: 1,
          snapshotSequence: 0,
          threads: [],
          archivedThreads: [],
        };
        const itemId = TurnItemId.make("item-cerno-ue59");

        const registry = makeJobRegistry({
          enableShipBridge: false,
          cernoBridge: {
            snapshotDirs: [snapDir],
            platform: "linux",
            localHostname: "dev-host-x",
            ciHostsPath: null,
            expectedUid: null,
            pollIntervalMs: 60_000,
            nowMs: () => FIXED_NOW_MS,
            isPidAlive: (pid) => pid === 1337797 && pidAlive,
            readProcStartTicks: async (pid) => (pid === 1337797 && pidAlive ? 6633455 : null),
            isCernoProcess: async () => true,
            resolveThreadId: async () => threadId,
            isWorkspaceAllowed: async (p) => p.startsWith(workDir),
          },
          backgroundBridge: {
            localHostname: "dev-host-x",
            ciHostsPath: null,
            commandDebounceMs: 10,
            getShellSnapshot: async () => emptySnapshot,
            getRunningCommandsForThread: async () => [],
            streamDomainEvents: domainStream,
            subscribeCommandOutput: () => Stream.empty,
            stopThread: async () => ({ ok: true }),
            isWorkspaceAllowed: async (p) => p.startsWith(workDir),
          },
        });

        const sseAbort = new AbortController();
        const sseChunks: string[] = [];
        const sseStream = registry.createEventsStream(sseAbort.signal);
        const sseReader = sseStream.getReader();
        const decoder = new TextDecoder();
        const drainSse = (async () => {
          try {
            while (true) {
              const { done, value } = await sseReader.read();
              if (done) break;
              sseChunks.push(decoder.decode(value, { stream: true }));
            }
          } catch {
            // stream aborted on cleanup
          }
        })();
        yield* Effect.addFinalizer(() =>
          Effect.promise(async () => {
            sseAbort.abort();
            await registry.dispose();
            await drainSse;
          }),
        );

        yield* Effect.promise(() => registry.listJobs({ threadId, refresh: true }));

        // 1. BackgroundTaskBridge emits live command_execution for the same cerno watch command.
        yield* PubSub.publish(domainEvents, {
          type: "turn-item.updated",
          threadId: ThreadId.make(threadId),
          occurredAt: nowUtc,
          payload: {
            id: itemId,
            threadId: ThreadId.make(threadId),
            runId: "run:192",
            nodeId: "node:1",
            providerThreadId: "pt:1",
            providerTurnId: "turn:1",
            nativeItemRef: { driver: "antigravity", nativeId: "call_8099", strength: "strong" },
            parentItemId: null,
            ordinal: 1,
            type: "command_execution",
            driver: "antigravity",
            status: "running",
            title: "Ran command",
            input: `cerno watch --monitor --wake-on-alert --log ${logPath} -- ssh -o ServerAliveInterval=30 dev-host-x engine_launch_7a34.sh build`,
            output: null,
            exitCode: null,
            startedAt: nowUtc,
            completedAt: null,
            updatedAt: nowUtc,
          },
        } as unknown as OrchestrationV2DomainEvent);

        const jobsWhileBgLive: ReadonlyArray<JobSummary> = yield* Effect.promise(() =>
          vi.waitFor<ReadonlyArray<JobSummary>>(async () => {
            const jobs = await registry.listJobs({ threadId });
            expect(jobs).toHaveLength(1);
            expect(jobs[0]!.id.startsWith("bg:")).toBe(true);
            return jobs;
          }),
        );
        const bgId = jobsWhileBgLive[0]!.id;
        const enrichedDetail = yield* Effect.promise(() => registry.getJobDetail(bgId));
        expect(enrichedDetail?.cerno?.summary).toContain("RUNNING (100%)");
        expect(enrichedDetail?.pidStats?.pid).toBe(1337797);

        // Hidden cerno ID must not be exposed through getJobDetail or cancelJob while suppressed.
        expect(
          yield* Effect.promise(() => registry.getJobDetail("cerno:1337797:6633455")),
        ).toBeNull();
        expect((yield* Effect.promise(() => registry.cancelJob("cerno:1337797:6633455"))).ok).toBe(
          false,
        );

        // 2. Simulate Antigravity postSettleCommandHold 30m expiry while PID 1337797 is still alive.
        // Also immediately call listJobs (Finding #1 race test) and confirm SSE still gets cerno upsert + bg removal.
        const sseCountBeforeTimeout = sseChunks.length;
        yield* PubSub.publish(domainEvents, {
          type: "turn-item.updated",
          threadId: ThreadId.make(threadId),
          occurredAt: nowUtc,
          payload: {
            id: itemId,
            threadId: ThreadId.make(threadId),
            runId: "run:192",
            nodeId: "node:1",
            providerThreadId: "pt:1",
            providerTurnId: "turn:1",
            nativeItemRef: { driver: "antigravity", nativeId: "call_8099", strength: "strong" },
            parentItemId: null,
            ordinal: 1,
            type: "command_execution",
            driver: "antigravity",
            status: "completed",
            title: "Ran command",
            input: `cerno watch --monitor --wake-on-alert --log ${logPath} -- ssh -o ServerAliveInterval=30 dev-host-x engine_launch_7a34.sh build`,
            output: null,
            exitCode: null,
            startedAt: nowUtc,
            completedAt: nowUtc,
            updatedAt: nowUtc,
          },
        } as unknown as OrchestrationV2DomainEvent);

        yield* Effect.promise(() =>
          vi.waitFor(async () => {
            const jobsAfterTimeout = await registry.listJobs({ threadId });
            // Finding #5: ONLY the live cerno card is returned; bogus terminal bg card is suppressed!
            expect(jobsAfterTimeout).toHaveLength(1);
            expect(jobsAfterTimeout[0]!.id).toBe("cerno:1337797:6633455");
            expect(jobsAfterTimeout[0]!.state).toBe("running");
            expect(jobsAfterTimeout[0]!.binding.host).toBe("dev-host-x");

            // Finding #1: SSE stream received the cerno upsert and bg removal!
            const sseAfterTimeout = sseChunks.slice(sseCountBeforeTimeout).join("");
            expect(sseAfterTimeout).toContain("cerno:1337797:6633455");
            expect(sseAfterTimeout).toContain(bgId);
          }),
        );

        // 3. Once the real PID exits, the cerno job terminates cleanly and stays suppressed behind the terminal bg job.
        pidAlive = false;
        const jobsAfterExit = yield* Effect.promise(() =>
          registry.listJobs({ threadId, refresh: true }),
        );
        expect(jobsAfterExit.filter((j) => j.state === "running")).toHaveLength(0);
      }),
  );

  it("resolves real Linux /proc/<pid>/environ T3CODE_THREAD_ID and start ticks from a live child process", async () => {
    if (!NodeFS.existsSync("/proc/self/stat")) return;
    const snapDir = mkTempDir("t3-cerno-realproc-");
    const child = NodeChildProcess.spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], {
      env: { ...process.env, T3CODE_THREAD_ID: "thread-real-linux-proc" },
      stdio: "ignore",
    });
    try {
      const pid = child.pid!;
      expect(pid).toBeGreaterThan(1);
      const startTicks = await readProcStartTicks(pid, "linux");
      expect(startTicks).not.toBeNull();

      writeSnapshot(snapDir, `${pid}.json`, {
        pid,
        proc_start_ticks: startTicks!,
        command: "python3 eval_model.py --split test",
        log_path: null,
      });

      const bridge = new CernoProcessBridge({
        snapshotDirs: [snapDir],
        ciHostsPath: null,
        nowMs: () => FIXED_NOW_MS,
      });
      try {
        await bridge.refresh();
        const jobs = bridge.listSummaries();
        expect(jobs).toHaveLength(1);
        expect(jobs[0]!.id).toBe(`cerno:${pid}:${startTicks}`);
        expect(jobs[0]!.binding.threadId).toBe("thread-real-linux-proc");
        expect(jobs[0]!.kind).toBe("eval");
        expect(jobs[0]!.pidStats?.alive).toBe(true);
        expect(jobs[0]!.pidStats?.rssBytes).toBeGreaterThan(0);
      } finally {
        bridge.dispose();
      }
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("matches cerno commands against background jobs via relative or symlinked log paths", () => {
    const realDir = mkTempDir("t3-cerno-match-real-");
    const linkParent = mkTempDir("t3-cerno-match-link-");
    const symDir = NodePath.join(linkParent, "sym-work");
    NodeFS.symlinkSync(realDir, symDir);
    const logFile = NodePath.join(realDir, "build.log");
    NodeFS.writeFileSync(logFile, "compiling\n", "utf8");

    expect(
      cernoMatchesBackgroundJob(
        {
          threadId: "t1",
          cwd: symDir,
          command: "make -j16",
          logPath: "build.log",
        },
        {
          threadId: "t1",
          command: `cerno watch --monitor --log ${logFile} -- make -j16`,
          logPath: logFile,
        },
      ),
    ).toBe(true);

    expect(
      cernoMatchesBackgroundJob(
        {
          threadId: "t1",
          command: "cargo test -p core",
        },
        {
          threadId: "t2",
          command: "cerno watch -- cargo test -p core",
        },
      ),
    ).toBe(false);
  });
});
