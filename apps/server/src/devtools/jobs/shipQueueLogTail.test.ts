// @effect-diagnostics nodeBuiltinImport:off - Tests write temporary ship-queue job logs on disk.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

const statusRecord: { current: Record<string, unknown> } = { current: {} };

vi.mock("../ShipQueueEventStream.ts", () => ({
  getShipQueueStatus: () => Promise.resolve({ ok: true, data: statusRecord.current }),
}));

import { adaptShipQueueJob, ShipQueueBridge } from "./ShipQueueBridge.ts";
import { readShipJobLogInfo } from "./shipQueueLogParser.ts";
import { postMergeSyncReason, readShipJobLogTail } from "./shipQueueLogTail.ts";

const tempDirs: string[] = [];

function makeJobsRoot(): string {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sq-log-tail-"));
  tempDirs.push(dir);
  return dir;
}

function writeLog(jobsRoot: string, id: string, lines: ReadonlyArray<string>): void {
  NodeFS.mkdirSync(NodePath.join(jobsRoot, id), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(jobsRoot, id, "log"), `${lines.join("\n")}\n`);
}

const HOOK_EXIT_LOG = [
  "QUEUED job=5001 branch=fix/sample at=2026-01-01T00:00:00.000Z",
  "STARTED job=5001 branch=fix/sample at=2026-01-01T00:00:05.000Z",
  "PUSH_EXIT=0",
  "PR=12",
  "MERGE_EXIT=0",
  "POST_MERGE job=5001",
  "  Done in 2.5s",
  "  install.sh: unknown argument: --bin-dir",
  "  ",
  "  post-merge sync exited 64 (PR #12 remains merged)",
  "SYNC_EXIT=64",
  "DONE job=5001 pr=12 at=2026-01-01T00:01:00.000Z",
];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});

describe("ship-queue log tail", () => {
  it("names the hook's last output line as the reason a post-merge sync exited non-zero", () => {
    expect(postMergeSyncReason(HOOK_EXIT_LOG)).toBe("install.sh: unknown argument: --bin-dir");
  });

  it("uses the queue's own refusal line, without the merged-PR suffix", () => {
    expect(
      postMergeSyncReason([
        "POST_MERGE job=5002",
        "  post-merge sync aborted: remote fetch failed; refusing to sync stale origin/main (PR #13 remains merged)",
        "SYNC_EXIT=1",
      ]),
    ).toBe("post-merge sync aborted: remote fetch failed; refusing to sync stale origin/main");
    expect(postMergeSyncReason(["POST_MERGE job=5003", "SYNC_EXIT=0"])).toBeUndefined();
  });

  it("reads a bounded, redacted tail that keeps output indented under its markers", () => {
    const jobsRoot = makeJobsRoot();
    writeLog(jobsRoot, "5004", [
      "STARTED job=5004 branch=fix/sample",
      "  curl -H Authorization: Bearer abcdefghijklmnop https://example.test",
      ...Array.from({ length: 300 }, (_, i) => `  line ${i}`),
    ]);
    const tail = readShipJobLogTail(jobsRoot, "5004");
    expect(tail).toHaveLength(200);
    expect(tail?.at(-1)).toBe("  line 299");
    expect(readShipJobLogTail(jobsRoot, "../5004")).toBeNull();
    expect(readShipJobLogTail(jobsRoot, "missing")).toBeNull();
    // Queue job ids only: four to sixteen digits.
    writeLog(jobsRoot, "504", ["STARTED job=504"]);
    expect(readShipJobLogTail(jobsRoot, "504")).toBeNull();

    writeLog(jobsRoot, "5005", ["  token=supersecretvalue123", "DONE job=5005"]);
    const redacted = readShipJobLogTail(jobsRoot, "5005")!;
    expect(redacted.join("\n")).not.toContain("supersecretvalue123");
    expect(redacted[0]?.startsWith("  ")).toBe(true);
    expect(redacted[1]).toBe("DONE job=5005");
  });

  it("adds the sync reason to a done job whose post-merge sync failed", () => {
    const jobsRoot = makeJobsRoot();
    writeLog(jobsRoot, "5001", HOOK_EXIT_LOG);
    const summary = adaptShipQueueJob(
      {
        id: "5001",
        repo: "acme-fixture/sample-repo",
        branch: "fix/sample",
        state: "done",
        pr: 12,
        merge_exit: 0,
        sync_exit: 64,
      },
      "fixture-host",
      1,
      jobsRoot,
    )!;
    expect(summary.state).toBe("done");
    expect(summary.shipJob).toMatchObject({
      sync_exit: 64,
      sync_reason: "install.sh: unknown argument: --bin-dir",
    });

    const passed = adaptShipQueueJob(
      { id: "5001", state: "done", sync_exit: 0 },
      "fixture-host",
      1,
      jobsRoot,
    )!;
    expect(passed.shipJob).not.toHaveProperty("sync_reason");
  });

  it("refuses a job log or a job directory that is a link", () => {
    const jobsRoot = makeJobsRoot();
    const outside = makeJobsRoot();
    writeLog(outside, "5006", ["STARTED job=5006", "  outside the queue"]);
    NodeFS.mkdirSync(NodePath.join(jobsRoot, "5006"));
    NodeFS.symlinkSync(
      NodePath.join(outside, "5006", "log"),
      NodePath.join(jobsRoot, "5006", "log"),
    );
    NodeFS.symlinkSync(NodePath.join(outside, "5006"), NodePath.join(jobsRoot, "5007"));
    for (const id of ["5006", "5007"]) {
      expect(readShipJobLogTail(jobsRoot, id)).toBeNull();
      expect(readShipJobLogInfo(jobsRoot, id)).toEqual({ stage: "", hasPostMerge: false });
    }
  });

  it("bumps a running job's revision when its log grows between markers", async () => {
    const queueRoot = makeJobsRoot();
    const queueJobs = NodePath.join(queueRoot, "jobs");
    writeLog(queueJobs, "5008", ["STARTED job=5008", "  step output 1"]);
    statusRecord.current = {
      queue_root: queueRoot,
      jobs: [{ id: "5008", state: "running", branch: "fix/sample" }],
    };
    const bridge = new ShipQueueBridge(() => {});
    await bridge.refresh(true);
    const first = bridge.getSnapshot().jobs.get("ship:5008")!.revision;
    await bridge.refresh(true);
    expect(bridge.getSnapshot().jobs.get("ship:5008")!.revision).toBe(first);

    NodeFS.appendFileSync(NodePath.join(queueJobs, "5008", "log"), "  step output 2\n");
    await bridge.refresh(true);
    const after = bridge.getSnapshot().jobs.get("ship:5008")!;
    expect(after.revision).toBe(first + 1);
    expect(bridge.getDetail(after).logTail.at(-1)).toBe("  step output 2");
  });
});
