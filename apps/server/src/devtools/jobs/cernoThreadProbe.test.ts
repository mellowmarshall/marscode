// @effect-diagnostics nodeBuiltinImport:off - Tests write temporary cerno snapshot files on disk.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";

import { hasLiveCernoProcessForThread } from "./cernoThreadProbe.ts";

const FIXED_NOW_MS = 1_776_000_000_000;
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix));
  NodeFS.chmodSync(dir, 0o700);
  tempDirs.push(dir);
  return dir;
}

function writeSnap(dir: string, filename: string, overrides: Record<string, unknown> = {}): void {
  const payload = {
    schema_version: 1,
    pid: 424242,
    child_pid: 424243,
    proc_start_ticks: 987654,
    started_at_ms: FIXED_NOW_MS - 120_000,
    updated_at_ms: FIXED_NOW_MS - 1_500,
    mode: "watch-monitor",
    cwd: "/tmp",
    command: "ssh host-c-wsl ./run.sh",
    log_path: "/tmp/run.log",
    state: "RUNNING",
    ...overrides,
  };
  NodeFS.writeFileSync(NodePath.join(dir, filename), JSON.stringify(payload), "utf8");
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
});

describe("hasLiveCernoProcessForThread", () => {
  it("returns true when a fresh verified cerno process matches the target threadId", async () => {
    const dir = makeTempDir("cerno-probe-ok-");
    writeSnap(dir, "424242.json");

    const result = await hasLiveCernoProcessForThread("thread-target", {
      snapshotDirs: [dir],
      expectedUid: null,
      platform: "linux",
      nowMs: () => FIXED_NOW_MS,
      isPidAlive: (pid) => pid === 424242,
      isCernoProcess: async (pid) => pid === 424242,
      readProcStartTicks: async () => 987654,
      resolveThreadId: async () => "thread-target",
    });

    expect(result).toBe(true);
  });

  it("returns false for another thread, stale snapshot, dead pid, non-cerno pid, or reused pid", async () => {
    const dir = makeTempDir("cerno-probe-neg-");
    writeSnap(dir, "424242.json");

    // Different threadId
    expect(
      await hasLiveCernoProcessForThread("thread-target", {
        snapshotDirs: [dir],
        expectedUid: null,
        platform: "linux",
        nowMs: () => FIXED_NOW_MS,
        isPidAlive: () => true,
        isCernoProcess: async () => true,
        readProcStartTicks: async () => 987654,
        resolveThreadId: async () => "thread-other",
      }),
    ).toBe(false);

    // Stale snapshot (>30s)
    expect(
      await hasLiveCernoProcessForThread("thread-target", {
        snapshotDirs: [dir],
        expectedUid: null,
        platform: "linux",
        nowMs: () => FIXED_NOW_MS + 60_000,
        isPidAlive: () => true,
        isCernoProcess: async () => true,
        readProcStartTicks: async () => 987654,
        resolveThreadId: async () => "thread-target",
      }),
    ).toBe(false);

    // Dead PID
    expect(
      await hasLiveCernoProcessForThread("thread-target", {
        snapshotDirs: [dir],
        expectedUid: null,
        platform: "linux",
        nowMs: () => FIXED_NOW_MS,
        isPidAlive: () => false,
        isCernoProcess: async () => true,
        readProcStartTicks: async () => 987654,
        resolveThreadId: async () => "thread-target",
      }),
    ).toBe(false);

    // Non-cerno process (e.g. AppImage mount)
    expect(
      await hasLiveCernoProcessForThread("thread-target", {
        snapshotDirs: [dir],
        expectedUid: null,
        platform: "linux",
        nowMs: () => FIXED_NOW_MS,
        isPidAlive: () => true,
        isCernoProcess: async () => false,
        readProcStartTicks: async () => 987654,
        resolveThreadId: async () => "thread-target",
      }),
    ).toBe(false);

    // PID reuse (start ticks mismatch)
    expect(
      await hasLiveCernoProcessForThread("thread-target", {
        snapshotDirs: [dir],
        expectedUid: null,
        platform: "linux",
        nowMs: () => FIXED_NOW_MS,
        isPidAlive: () => true,
        isCernoProcess: async () => true,
        readProcStartTicks: async () => 111111,
        resolveThreadId: async () => "thread-target",
      }),
    ).toBe(false);
  });

  it("ignores world-writable or symlinked snapshot directories", async () => {
    const dir = makeTempDir("cerno-probe-unsafe-");
    writeSnap(dir, "424242.json");
    NodeFS.chmodSync(dir, 0o777);

    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    const result = await hasLiveCernoProcessForThread("thread-target", {
      snapshotDirs: [dir],
      expectedUid: uid,
      platform: "linux",
      nowMs: () => FIXED_NOW_MS,
      isPidAlive: () => true,
      isCernoProcess: async () => true,
      readProcStartTicks: async () => 987654,
      resolveThreadId: async () => "thread-target",
    });

    expect(result).toBe(false);
  });
});
