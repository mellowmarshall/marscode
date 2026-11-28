// @effect-diagnostics nodeBuiltinImport:off - Tests write temporary ship-queue job logs on disk.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";

import { adaptShipQueueJob } from "./ShipQueueBridge.ts";
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
  "QUEUED job=501 branch=fix/sample at=2026-01-01T00:00:00.000Z",
  "STARTED job=501 branch=fix/sample at=2026-01-01T00:00:05.000Z",
  "PUSH_EXIT=0",
  "PR=12",
  "MERGE_EXIT=0",
  "POST_MERGE job=501",
  "  Done in 2.5s",
  "  install.sh: unknown argument: --bin-dir",
  "  ",
  "  post-merge sync exited 64 (PR #12 remains merged)",
  "SYNC_EXIT=64",
  "DONE job=501 pr=12 at=2026-01-01T00:01:00.000Z",
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
        "POST_MERGE job=502",
        "  post-merge sync aborted: remote fetch failed; refusing to sync stale origin/main (PR #13 remains merged)",
        "SYNC_EXIT=1",
      ]),
    ).toBe("post-merge sync aborted: remote fetch failed; refusing to sync stale origin/main");
    expect(postMergeSyncReason(["POST_MERGE job=503", "SYNC_EXIT=0"])).toBeUndefined();
  });

  it("reads a bounded, redacted tail that keeps output indented under its markers", () => {
    const jobsRoot = makeJobsRoot();
    writeLog(jobsRoot, "504", [
      "STARTED job=504 branch=fix/sample",
      "  curl -H Authorization: Bearer abcdefghijklmnop https://example.test",
      ...Array.from({ length: 300 }, (_, i) => `  line ${i}`),
    ]);
    const tail = readShipJobLogTail(jobsRoot, "504");
    expect(tail).toHaveLength(200);
    expect(tail?.at(-1)).toBe("  line 299");
    expect(readShipJobLogTail(jobsRoot, "../504")).toBeNull();
    expect(readShipJobLogTail(jobsRoot, "missing")).toBeNull();

    writeLog(jobsRoot, "505", ["  token=supersecretvalue123", "DONE job=505"]);
    const redacted = readShipJobLogTail(jobsRoot, "505")!;
    expect(redacted.join("\n")).not.toContain("supersecretvalue123");
    expect(redacted[0]?.startsWith("  ")).toBe(true);
    expect(redacted[1]).toBe("DONE job=505");
  });

  it("adds the sync reason to a done job whose post-merge sync failed", () => {
    const jobsRoot = makeJobsRoot();
    writeLog(jobsRoot, "501", HOOK_EXIT_LOG);
    const summary = adaptShipQueueJob(
      {
        id: "501",
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
      { id: "501", state: "done", sync_exit: 0 },
      "fixture-host",
      1,
      jobsRoot,
    )!;
    expect(passed.shipJob).not.toHaveProperty("sync_reason");
  });
});
