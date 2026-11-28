// @effect-diagnostics nodeBuiltinImport:off globalDate:off - GuardJobBindings lifecycle against a real temp job store.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { createJob, failJob } from "@t3tools/ship-queue/jobStore";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { GuardJobBindings, JOB_BINDING_MAX_AGE_MS } from "./GuardJobBindings.ts";
import type { QueueWorkerTrust } from "./GuardQueueWorker.ts";

const NOW = Date.parse("2026-11-27T12:00:00.000Z");
const clock = { now: () => new Date(NOW).toISOString() };
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const queueRoot = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "gjb-")));
  dirs.push(queueRoot);
  const worktree = NodePath.join(queueRoot, "wt");
  NodeFS.mkdirSync(worktree);
  const trust: QueueWorkerTrust = {
    queueRoot,
    isTrustedWorker: () => false,
    isTrustedSubmitter: () => true,
  };
  const newJob = () =>
    createJob(
      queueRoot,
      {
        repo: "example-org/example-repo",
        primary: worktree,
        worktree,
        branch: "feat/x",
        base_branch: "main",
        remote: "origin",
        title: "t",
        head_sha: "c".repeat(40),
      },
      "body\n",
      clock,
    ).id;
  const bindings = new GuardJobBindings();
  const bind = (jobId: string, nowMs = NOW) =>
    bindings.bind(
      trust,
      { peerPid: 4242, threadId: "thread-a", jobId, worktree, branch: "feat/x" },
      nowMs,
    );
  return { queueRoot, bindings, bind, newJob };
}

describe("GuardJobBindings lifecycle", () => {
  it("frees the bindings of ended jobs when full, and never evicts an active one", () => {
    const { queueRoot, bindings, bind, newJob } = setup();
    const ids: string[] = [];
    for (let i = 0; i < 1024; i += 1) {
      const id = newJob();
      ids.push(id);
      expect(bind(id).ok).toBe(true);
    }
    // All active: a new job is refused, and nothing already bound moves.
    expect(bind(newJob())).toEqual({ ok: false, error: "too many job bindings" });
    expect(bindings.size).toBe(1024);
    expect(bindings.get(ids[0]!, NOW)?.threadId).toBe("thread-a");

    // Two jobs end: their bindings go and two new jobs can bind; the rest stay.
    failJob(queueRoot, ids[0]!, "cancelled", clock);
    failJob(queueRoot, ids[1]!, "cancelled", clock);
    expect(bind(newJob()).ok).toBe(true);
    expect(bind(newJob()).ok).toBe(true);
    expect(bind(newJob())).toEqual({ ok: false, error: "too many job bindings" });
    expect(bindings.get(ids[0]!, NOW)).toBeUndefined();
    expect(bindings.get(ids[2]!, NOW)?.threadId).toBe("thread-a");
  });

  it("expires stale bindings and releases a binding whose job ended", () => {
    const { bindings, bind, newJob } = setup();
    const stale = newJob();
    const ended = newJob();
    expect(bind(stale).ok).toBe(true);
    expect(bind(ended).ok).toBe(true);
    expect(bindings.get(stale, NOW + JOB_BINDING_MAX_AGE_MS)?.threadId).toBe("thread-a");
    expect(bindings.get(stale, NOW + JOB_BINDING_MAX_AGE_MS + 1)).toBeUndefined();
    expect(bindings.size).toBe(1);
    bindings.release(ended);
    expect(bindings.size).toBe(0);
    // A released job cannot be re-bound by anyone later: its submit window is long gone.
    expect(bind(ended, NOW + 10 * 60_000)).toEqual({
      ok: false,
      error: "job was not just submitted",
    });
  });
});
