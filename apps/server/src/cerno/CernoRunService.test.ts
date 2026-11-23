import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as CernoRunService from "./CernoRunService.ts";

function sampleRawSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    pid: 4242,
    child_pid: 4243,
    started_at_ms: 1_795_457_112_000,
    updated_at_ms: 1_795_458_325_000,
    elapsed_sec: 1213.0,
    mode: "watch-monitor",
    engine: "cernibundus_c11_avx2_int8",
    cwd: "/data/Dev/private-repo/worktrees/pass4-aaa",
    command: "ssh dev-host-x Build.sh",
    log_path: null,
    state: "RUNNING",
    confidence: 0.96,
    margin: 4.8,
    state_probs: {
      RUNNING: 0.96,
      SUCCEEDED: 0.0,
      FAILED: 0.01,
      NEEDS_INPUT: 0.01,
      STUCK_LOOP: 0.02,
    },
    outcome: "IN_PROGRESS",
    p_fail: 0.04,
    fail_margin: -3.1,
    cutoffs: {
      susp_thresh: 0.55,
      susp_margin: 0.5,
      conf_thresh: 0.82,
      conf_margin: 1.8,
    },
    prompt: false,
    hang_loop: false,
    server_ready: false,
    auth_required: false,
    resource_kill: "NORMAL",
    git_conflict: "NORMAL",
    wchan: "poll_schedule_timeout",
    cpu_active: false,
    has_remote_socket: true,
    has_listen_socket: false,
    has_ext_file_lock: false,
    silence_sec: 14.0,
    stall_timeout_sec: 180.0,
    bytes_stdout: 20450,
    bytes_stderr: 0,
    alert: null,
    tail: "[416/2554] Compile Module.Engine.12.cpp",
    ...overrides,
  };
}

describe("CernoRunService", () => {
  it.live(
    "decodes live snapshots, reads bounded log tails, and drops dead, invalid, oversized, or symlinked entries",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cerno-test-" });

        const logPath = path.join(root, "build.log");
        const longLines = Array.from(
          { length: 400 },
          (_, idx) => `[${idx + 1}/2554] Compile Module.${idx}.cpp`,
        ).join("\n");
        yield* fs.writeFileString(logPath, `${longLines}\n`);
        const symlinkedLog = path.join(root, "linked.log");
        yield* fs.symlink(logPath, symlinkedLog);

        // Live valid snapshot with regular log file
        yield* fs.writeFileString(
          path.join(root, "4242.json"),
          JSON.stringify(sampleRawSnapshot({ pid: 4242, log_path: logPath })),
        );
        // Live snapshot pointing to a symlinked log file -> snapshot loads, logTail omitted
        yield* fs.writeFileString(
          path.join(root, "4243.json"),
          JSON.stringify(sampleRawSnapshot({ pid: 4243, log_path: symlinkedLog })),
        );
        // Dead PID
        yield* fs.writeFileString(
          path.join(root, "9999.json"),
          JSON.stringify(sampleRawSnapshot({ pid: 9999 })),
        );
        // Broken JSON
        yield* fs.writeFileString(path.join(root, "5555.json"), "{broken json");
        // Symlinked snapshot file
        yield* fs.symlink(path.join(root, "4242.json"), path.join(root, "7777.json"));
        // Unsupported schema_version
        yield* fs.writeFileString(
          path.join(root, "6666.json"),
          JSON.stringify(sampleRawSnapshot({ pid: 6666, schema_version: 2 })),
        );
        // Oversized (>16 KiB) snapshot file
        yield* fs.writeFileString(
          path.join(root, "8888.json"),
          JSON.stringify(sampleRawSnapshot({ pid: 8888, tail: "x".repeat(20_000) })),
        );

        const layer = CernoRunService.layerWithOptions({
          snapshotDirs: [root],
          isPidAlive: (pid) => pid !== 9999,
          nowMs: () => 1_795_458_330_000,
          maxLogTailBytes: 1024,
        }).pipe(Layer.provide(NodeServices.layer));

        const result = yield* Effect.flatMap(
          CernoRunService.CernoRunService,
          (svc) => svc.listRuns,
        ).pipe(Effect.provide(layer));

        assert.strictEqual(result.sampledAt, 1_795_458_330_000);
        assert.strictEqual(result.runs.length, 2);
        const byPid = new Map(result.runs.map((run) => [run.pid, run]));

        const run = byPid.get(4242)!;
        assert.isDefined(run);
        assert.strictEqual(run.state, "RUNNING");
        assert.strictEqual(run.confidence, 0.96);
        assert.strictEqual(run.hasRemoteSocket, true);
        assert.strictEqual(run.logPath, logPath);
        assert.isTrue(run.logTail !== undefined && run.logTail.includes("[400/2554]"));
        assert.isTrue((run.logTail?.length ?? 0) <= 1024);

        const symLogRun = byPid.get(4243)!;
        assert.isDefined(symLogRun);
        assert.strictEqual(symLogRun.logTail, undefined);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live(
    "drops stale snapshots even when child_pid is alive, enforces PID start-tick reuse check, and rejects UID mismatches",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cerno-guards-" });

        // Stale snapshot (45s old) whose child_pid is still reported alive
        yield* fs.writeFileString(
          path.join(root, "1001.json"),
          JSON.stringify(
            sampleRawSnapshot({
              pid: 1001,
              child_pid: 1002,
              updated_at_ms: 1_795_458_280_000,
            }),
          ),
        );
        // PID reused (proc_start_ticks mismatch)
        yield* fs.writeFileString(
          path.join(root, "2001.json"),
          JSON.stringify(
            sampleRawSnapshot({
              pid: 2001,
              proc_start_ticks: 111_111,
              updated_at_ms: 1_795_458_325_000,
            }),
          ),
        );
        // Matching start ticks -> accepted
        yield* fs.writeFileString(
          path.join(root, "3001.json"),
          JSON.stringify(
            sampleRawSnapshot({
              pid: 3001,
              proc_start_ticks: 222_222,
              updated_at_ms: 1_795_458_325_000,
            }),
          ),
        );

        const layer = CernoRunService.layerWithOptions({
          snapshotDirs: [root],
          isPidAlive: () => true,
          readProcStartTicks: async (pid) => (pid === 2001 ? 999_999 : 222_222),
          nowMs: () => 1_795_458_330_000,
        }).pipe(Layer.provide(NodeServices.layer));

        const result = yield* Effect.flatMap(
          CernoRunService.CernoRunService,
          (svc) => svc.listRuns,
        ).pipe(Effect.provide(layer));
        assert.deepStrictEqual(
          result.runs.map((run) => run.pid),
          [3001],
        );

        // Owner UID mismatch rejects the directory/files
        const currentUid = typeof process.getuid === "function" ? process.getuid() : 1000;
        const wrongUidLayer = CernoRunService.layerWithOptions({
          snapshotDirs: [root],
          isPidAlive: () => true,
          readProcStartTicks: async () => 222_222,
          expectedUid: currentUid + 1,
          nowMs: () => 1_795_458_330_000,
        }).pipe(Layer.provide(NodeServices.layer));

        const wrongUidResult = yield* Effect.flatMap(
          CernoRunService.CernoRunService,
          (svc) => svc.listRuns,
        ).pipe(Effect.provide(wrongUidLayer));
        assert.strictEqual(wrongUidResult.runs.length, 0);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("keeps the 64 newest snapshots when more than 64 files exist in a snapshot dir", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cerno-limit-" });

      for (let i = 1; i <= 70; i += 1) {
        const pid = 10_000 + i;
        const filePath = path.join(root, `${pid}.json`);
        yield* fs.writeFileString(
          filePath,
          JSON.stringify(
            sampleRawSnapshot({
              pid,
              started_at_ms: 1_795_457_000_000 + i * 1_000,
              updated_at_ms: 1_795_458_325_000,
            }),
          ),
        );
        const mtimeSec = 1_795_457_000 + i;
        yield* fs.utimes(filePath, mtimeSec, mtimeSec);
      }

      const layer = CernoRunService.layerWithOptions({
        snapshotDirs: [root],
        isPidAlive: () => true,
        readProcStartTicks: async () => null,
        nowMs: () => 1_795_458_330_000,
      }).pipe(Layer.provide(NodeServices.layer));

      const result = yield* Effect.flatMap(
        CernoRunService.CernoRunService,
        (svc) => svc.listRuns,
      ).pipe(Effect.provide(layer));

      assert.strictEqual(result.runs.length, 64);
      // The newest PID (10070) must be included; the oldest (10001..10006) must be trimmed.
      assert.strictEqual(result.runs[0]?.pid, 10_070);
      assert.isFalse(result.runs.some((run) => run.pid === 10_001));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
