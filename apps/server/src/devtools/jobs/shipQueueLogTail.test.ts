// @effect-diagnostics nodeBuiltinImport:off - Tests build symlinked, hardlinked and swapped job directories between a stat and an open, which needs synchronous node:fs.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

const statusRecord: { current: Record<string, unknown> } = { current: {} };

vi.mock("../ShipQueueEventStream.ts", () => ({
  getShipQueueStatus: () => Promise.resolve({ ok: true, data: statusRecord.current }),
}));

import { adaptShipQueueJob, readShipJobLogFacts, ShipQueueBridge } from "./ShipQueueBridge.ts";
import { openShipJobLog, statShipJobLog } from "./shipQueueJobLogFile.ts";
import { readShipJobLogInfo } from "./shipQueueLogParser.ts";
import { postMergeSyncReason, readShipJobLogTail } from "./shipQueueLogTail.ts";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sq-log-tail-"));
  tempDirs.push(dir);
  return dir;
}

function writeLog(jobsRoot: string, id: string, lines: ReadonlyArray<string>): string {
  NodeFS.mkdirSync(NodePath.join(jobsRoot, id), { recursive: true });
  const path = NodePath.join(jobsRoot, id, "log");
  NodeFS.writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
}

function tailOf(jobsRoot: string, id: string) {
  return readShipJobLogTail(statShipJobLog(jobsRoot, id));
}

/** A queue root whose status lists `jobs`, read by a fresh bridge. */
function makeBridge(jobs: ReadonlyArray<Record<string, unknown>>) {
  const queueRoot = makeTempDir();
  statusRecord.current = { queue_root: queueRoot, jobs };
  return { bridge: new ShipQueueBridge(() => {}), queueJobs: NodePath.join(queueRoot, "jobs") };
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

const SYNC_FAILED_JOB = {
  id: "5001",
  repo: "acme-fixture/sample-repo",
  branch: "fix/sample",
  state: "done",
  pr: 12,
  merge_exit: 0,
  sync_exit: 64,
};

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
    const jobsRoot = makeTempDir();
    writeLog(jobsRoot, "5004", [
      "STARTED job=5004 branch=fix/sample",
      ...Array.from({ length: 300 }, (_, i) => `  line ${i}`),
    ]);
    const tail = tailOf(jobsRoot, "5004");
    expect(tail).toHaveLength(200);
    expect(tail?.at(-1)).toBe("  line 299");
    expect(tailOf(jobsRoot, "../5004")).toBeNull();
    expect(tailOf(jobsRoot, "missing")).toBeNull();
    // Queue job ids only: four to sixteen digits.
    writeLog(jobsRoot, "504", ["STARTED job=504"]);
    expect(tailOf(jobsRoot, "504")).toBeNull();

    writeLog(jobsRoot, "5005", ["  token=supersecretvalue123", "DONE job=5005"]);
    const redacted = tailOf(jobsRoot, "5005")!;
    expect(redacted.join("\n")).not.toContain("supersecretvalue123");
    expect(redacted[0]?.startsWith("  ")).toBe(true);
    expect(redacted[1]).toBe("DONE job=5005");
  });

  it("adds the sync reason to a done job whose post-merge sync failed", () => {
    const jobsRoot = makeTempDir();
    writeLog(jobsRoot, "5001", HOOK_EXIT_LOG);
    const summary = adaptShipQueueJob(
      SYNC_FAILED_JOB,
      "fixture-host",
      1,
      readShipJobLogFacts(SYNC_FAILED_JOB, jobsRoot),
    )!;
    expect(summary.state).toBe("done");
    expect(summary.shipJob).toMatchObject({
      sync_exit: 64,
      sync_reason: "install.sh: unknown argument: --bin-dir",
    });

    const passedRaw = { id: "5001", state: "done", sync_exit: 0 };
    const passed = adaptShipQueueJob(
      passedRaw,
      "fixture-host",
      1,
      readShipJobLogFacts(passedRaw, jobsRoot),
    )!;
    expect(passed.shipJob).not.toHaveProperty("sync_reason");
  });

  it("refuses a job log or a job directory that is a symlink", () => {
    const jobsRoot = makeTempDir();
    const outside = makeTempDir();
    writeLog(outside, "5006", ["STARTED job=5006", "  outside the queue"]);
    NodeFS.mkdirSync(NodePath.join(jobsRoot, "5006"));
    NodeFS.symlinkSync(
      NodePath.join(outside, "5006", "log"),
      NodePath.join(jobsRoot, "5006", "log"),
    );
    NodeFS.symlinkSync(NodePath.join(outside, "5006"), NodePath.join(jobsRoot, "5007"));
    for (const id of ["5006", "5007"]) {
      expect(statShipJobLog(jobsRoot, id)).toBeNull();
      expect(tailOf(jobsRoot, id)).toBeNull();
      expect(readShipJobLogInfo(statShipJobLog(jobsRoot, id))).toEqual({
        stage: "",
        hasPostMerge: false,
      });
    }
  });

  it("refuses a hardlinked log, found as one or linked after the stat", () => {
    const jobsRoot = makeTempDir();
    const outside = makeTempDir();
    const outsideLog = writeLog(outside, "5009", ["STARTED job=5009", "  outside the queue"]);
    NodeFS.mkdirSync(NodePath.join(jobsRoot, "5009"));
    NodeFS.linkSync(outsideLog, NodePath.join(jobsRoot, "5009", "log"));
    expect(statShipJobLog(jobsRoot, "5009")).toBeNull();

    const ownLog = writeLog(jobsRoot, "5010", ["STARTED job=5010"]);
    const found = statShipJobLog(jobsRoot, "5010")!;
    expect(found).not.toBeNull();
    NodeFS.linkSync(ownLog, NodePath.join(outside, "copy-of-5010"));
    expect(openShipJobLog(found)).toBeNull();
    expect(readShipJobLogTail(found)).toBeNull();
  });

  it("refuses a job directory swapped for a symlink, or a log replaced, between stat and open", () => {
    const jobsRoot = makeTempDir();
    const outside = makeTempDir();
    writeLog(outside, "5011", ["STARTED job=5011", "  outside the queue"]);
    writeLog(jobsRoot, "5011", ["STARTED job=5011", "  inside the queue"]);
    const found = statShipJobLog(jobsRoot, "5011")!;
    expect(found).not.toBeNull();
    // The swap a racing writer could make after the check: the directory becomes a link.
    NodeFS.renameSync(NodePath.join(jobsRoot, "5011"), NodePath.join(outside, "moved-5011"));
    NodeFS.symlinkSync(NodePath.join(outside, "5011"), NodePath.join(jobsRoot, "5011"));
    expect(openShipJobLog(found)).toBeNull();
    expect(readShipJobLogTail(found)).toBeNull();
    expect(readShipJobLogInfo(found)).toEqual({ stage: "", hasPostMerge: false });

    writeLog(jobsRoot, "5012", ["STARTED job=5012"]);
    const before = statShipJobLog(jobsRoot, "5012")!;
    const replacement = NodePath.join(jobsRoot, "5012", "log.new");
    NodeFS.writeFileSync(replacement, "STARTED job=5012\n");
    NodeFS.renameSync(replacement, NodePath.join(jobsRoot, "5012", "log"));
    expect(openShipJobLog(before)).toBeNull();
  });

  it("serves no log through the job detail when the log is a hardlink", async () => {
    const { bridge, queueJobs } = makeBridge([{ id: "5013", state: "running" }]);
    const outside = makeTempDir();
    const outsideLog = writeLog(outside, "5013", ["  outside the queue"]);
    NodeFS.mkdirSync(NodePath.join(queueJobs, "5013"), { recursive: true });
    NodeFS.linkSync(outsideLog, NodePath.join(queueJobs, "5013", "log"));
    await bridge.refresh(true);
    const detail = bridge.getDetail(bridge.getSnapshot().jobs.get("ship:5013")!);
    expect(detail.logState).toBe("unreadable");
    expect(detail.logTail).toEqual([]);
  });

  it("serves a redacted tail through the job detail, Basic credentials included", async () => {
    const { bridge, queueJobs } = makeBridge([{ id: "5014", state: "running" }]);
    const credential = `${"dXNlcjpwYXNz".repeat(2)}==`;
    writeLog(queueJobs, "5014", [
      "STARTED job=5014",
      `  curl -H 'Authorization: Basic ${credential}' https://example.test`,
    ]);
    await bridge.refresh(true);
    const detail = bridge.getDetail(bridge.getSnapshot().jobs.get("ship:5014")!);
    expect(detail.logState).toBe("attached");
    expect(detail.logTail.join("\n")).not.toContain(credential);
    expect(detail.logTail.at(-1)).toBe(
      "  curl -H 'Authorization: Basic [REDACTED]' https://example.test",
    );
  });

  it("bumps a running job's revision when its log grows between markers", async () => {
    const { bridge, queueJobs } = makeBridge([
      { id: "5008", state: "running", branch: "fix/sample" },
    ]);
    writeLog(queueJobs, "5008", ["STARTED job=5008", "  step output 1"]);
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

  it("reads an ended job's log again only when its record changes", async () => {
    const { bridge, queueJobs } = makeBridge([SYNC_FAILED_JOB]);
    const logPath = writeLog(queueJobs, "5001", HOOK_EXIT_LOG);
    const reasonOf = () =>
      (bridge.getSnapshot().jobs.get("ship:5001")!.shipJob as { sync_reason?: string }).sync_reason;
    await bridge.refresh(true);
    expect(reasonOf()).toBe("install.sh: unknown argument: --bin-dir");

    // Same record: the bridge keeps its summary and does not read the rewritten log.
    NodeFS.writeFileSync(
      logPath,
      ["POST_MERGE job=5001", "  hook: a different failure", "  post-merge sync exited 64"].join(
        "\n",
      ),
    );
    await bridge.refresh(true);
    expect(reasonOf()).toBe("install.sh: unknown argument: --bin-dir");

    statusRecord.current = {
      ...statusRecord.current,
      jobs: [{ ...SYNC_FAILED_JOB, ended_at: "2026-01-01T00:01:00.000Z" }],
    };
    await bridge.refresh(true);
    expect(reasonOf()).toBe("hook: a different failure");
  });
});
