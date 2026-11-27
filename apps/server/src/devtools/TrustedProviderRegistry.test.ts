// @effect-diagnostics nodeBuiltinImport:off - Tests inspect /proc/<pid>/stat and temporary fixture files directly.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";

import { makeTrustedProviderRegistry, readProcStartTime } from "./TrustedProviderRegistry.ts";

describe("TrustedProviderRegistry", () => {
  it("reads /proc/<pid>/stat starttime on Linux and rejects invalid inputs", () => {
    expect(readProcStartTime(0)).toBeUndefined();
    expect(readProcStartTime(-5)).toBeUndefined();
    expect(readProcStartTime(1)).toBeUndefined();
    expect(readProcStartTime(1.5)).toBeUndefined();

    if (NodeFS.existsSync("/proc/self/stat")) {
      const own = readProcStartTime(process.pid);
      expect(own).toBeDefined();
      expect(own).toMatch(/^\d+$/);
    }

    // Handles comm names containing spaces and closing parentheses.
    const fakeProc = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-proc-stat-"));
    try {
      const pidDir = NodePath.join(fakeProc, "4242");
      NodeFS.mkdirSync(pidDir, { recursive: true });
      const fieldsAfterComm = [
        "S",
        "100",
        "100",
        "100",
        "0",
        "-1",
        "4194304",
        "10",
        "0",
        "0",
        "0",
        "1",
        "2",
        "0",
        "0",
        "20",
        "0",
        "1",
        "0",
        "987654321",
      ].join(" ");
      NodeFS.writeFileSync(
        NodePath.join(pidDir, "stat"),
        `4242 (weird ) proc name) ${fieldsAfterComm}\n`,
        "utf8",
      );
      expect(readProcStartTime(4242, fakeProc)).toBe("987654321");
      expect(readProcStartTime(9999, fakeProc)).toBeUndefined();
    } finally {
      NodeFS.rmSync(fakeProc, { recursive: true, force: true });
    }
  });

  it("tracks active Codex app-server (pid, startTime) pairs and guards against stale releases", () => {
    const startTimes = new Map<number, string>([[5001, "11111"]]);
    const registry = makeTrustedProviderRegistry((pid) => startTimes.get(pid));

    // Unreadable PID becomes a no-op registration.
    const noopRelease = registry.registerCodexAppServer(9999);
    expect(registry.snapshotCodexAppServers()).toEqual([]);
    noopRelease();

    const releaseFirst = registry.registerCodexAppServer(5001);
    expect(registry.snapshotCodexAppServers()).toEqual([{ pid: 5001, startTime: "11111" }]);

    // Simulate OS PID reuse with a new starttime before old release runs.
    startTimes.set(5001, "22222");
    const releaseSecond = registry.registerCodexAppServer(5001);
    expect(registry.snapshotCodexAppServers()).toEqual([{ pid: 5001, startTime: "22222" }]);

    // Stale release must NOT evict the newer registration.
    releaseFirst();
    expect(registry.snapshotCodexAppServers()).toEqual([{ pid: 5001, startTime: "22222" }]);

    // Current release evicts it cleanly and is idempotent.
    releaseSecond();
    releaseSecond();
    expect(registry.snapshotCodexAppServers()).toEqual([]);
  });
});
