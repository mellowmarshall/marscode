// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Declared steps and the challenge gate over real temporary git repositories and step scripts.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  CHALLENGE_WAIT_MS,
  overrideRequestPath,
  requestChallengeOverride,
} from "./challengeGate.ts";
import { runShipQueueCli } from "./cli.ts";
import { jobReviewPath, mark, readJob, readLog } from "./jobStore.ts";
import { nodeProcessRunner } from "./nodeProcess.ts";
import { ciOutputPath } from "./ciSteps.ts";
import type { RemoteCommandRunner } from "./sshExec.ts";
import { fixtureCleanups, makeFixture, SELF, sh } from "./testing/shipStepsFixture.ts";
import type { ProcessRunner, ShipQueueDeps } from "./types.ts";
import { WATCH_EXIT, watchJob } from "./watcher.ts";
import { hasOpenJobsForWorker, runDueWork, runJob } from "./worker.ts";

afterEach(() => {
  for (const cleanup of fixtureCleanups.splice(0)) cleanup();
});

describe("declared steps before merge", () => {
  it("fails a job whose declared CI step fails, with its exit and a log excerpt, and never merges it", async () => {
    const fx = makeFixture();
    const wt = fx.worktree("feat/98-red", { "ci-fail": "1\n" });
    const id = await fx.submit(wt, "feat/98-red");

    expect(await runJob(fx.deps, id)).toBe("ended");

    const job = readJob(fx.root, id)!;
    expect(job).toMatchObject({ state: "failed", reason: "ci step=ship_ci exit=3" });
    expect(fx.markers(id).at(-1)).toBe("FAILED reason=ci step=ship_ci exit=3");
    expect(fx.prs.size).toBe(0);
    expect(fx.merged).toEqual([]);
    expect(fx.markers(id).some((l) => l.startsWith("PUSH_EXIT="))).toBe(false);
    const log = readLog(fx.root, id);
    expect(log).toContain("  ci: 1 test failed in ci-fail");
    expect(log).toContain("lines left out; the step's output file has them");
    expect(log).not.toContain("noise line 5\n");
    expect(job.steps?.map((s) => [s.name, s.exit])).toEqual([
      ["ship_body_check", 0],
      ["ship_install", 0],
      ["ship_ci", 3],
    ]);
    expect(fx.reviews).toHaveLength(0);
  });

  it("keeps the failure from the middle of a long CI output in the log, with the tail", async () => {
    const fx = makeFixture();
    const wt = fx.worktree("feat/119-long", { "ci-long": "1\n" });
    const id = await fx.submit(wt, "feat/119-long");

    expect(await runJob(fx.deps, id)).toBe("ended");
    expect(readJob(fx.root, id)?.reason).toBe("ci step=ship_ci exit=1");
    const log = readLog(fx.root, id);
    for (const line of [
      " FAIL  src/sum.test.ts > adds two numbers",
      "AssertionError: expected 2 to be 3",
      "  at src/sum.test.ts:4:17",
      "check:changed summary",
      "  FAIL  test (4 files)",
      "hygiene: tail line 60",
    ]) {
      expect(log).toContain(`  ${line}\n`);
    }
    expect(log).not.toContain("tsc suggestion 100\n");
    expect(log).not.toContain("tsc suggestion after 100\n");
    expect(log).toContain("lines left out; the step's output file has them");
    // The output file keeps every line.
    const output = NodeFS.readFileSync(ciOutputPath(fx.root, id), "utf8");
    expect(output).toContain("tsc suggestion 100\n");
    expect(output).toContain("tsc suggestion after 100\n");
  });

  it("merges a job whose steps pass, timing each step and handing the CI output to the review", async () => {
    const fx = makeFixture();
    const wt = fx.worktree("feat/98-green", { "green.txt": "ok\n" });
    const id = await fx.submit(wt, "feat/98-green");

    expect(await runJob(fx.deps, id)).toBe("ended");

    const job = readJob(fx.root, id)!;
    expect(job.state).toBe("done");
    expect(fx.merged).toEqual([1]);
    expect(job.steps?.map((s) => [s.name, s.host, s.exit])).toEqual([
      ["ship_body_check", "local", 0],
      ["ship_install", "local", 0],
      ["ship_ci", "local", 0],
    ]);
    for (const step of job.steps ?? []) expect(step.ms).toBeGreaterThanOrEqual(0);
    const order = fx.markers(id).map((l) => l.split(/[= ]/)[0]);
    expect(order.slice(0, 7)).toEqual([
      "QUEUED",
      "STARTED",
      "REBASED",
      "STEP",
      "STEP",
      "STEP",
      "PUSH_EXIT",
    ]);
    expect(fx.markers(id)).toContain(`STEP name=ship_ci host=local exit=0 ms=${job.steps![2]!.ms}`);
    expect(fx.reviews).toHaveLength(1);
    expect(fx.reviews[0]!.ciOutput).toMatch(
      /=== ship_ci \(host local, exit 0, [\d.]+s\) ===\nci: 42 tests passed at \w+ base origin\/main/,
    );
    expect(NodeFS.readFileSync(ciOutputPath(fx.root, id), "utf8")).toContain("install ok");
  });
});

describe("challenge gate", () => {
  it("holds a CHALLENGED job until resumed with a reason, watches through merge, and supports safe retries", async () => {
    const fx = makeFixture();
    fx.setVerdict("CHALLENGED");
    const wt = fx.worktree("feat/98-challenged", { "x.txt": "x\n" });
    const id = await fx.submit(wt, "feat/98-challenged");

    expect(await runJob(fx.deps, id)).toBe("blocked");
    const parked = readJob(fx.root, id)!;
    expect(parked).toMatchObject({ state: "waiting", waiting_for: "challenge" });
    expect(hasOpenJobsForWorker(fx.root)).toBe(true);
    expect(fx.markers(id).at(-1)).toBe(`CHALLENGED job=${id} report=${jobReviewPath(fx.root, id)}`);
    expect(fx.prs.size).toBe(0);
    // The worker's next ticks keep it parked without running CI or the review again.
    expect(await runJob(fx.deps, id)).toBe("blocked");
    expect(fx.ciRuns()).toBe(1);

    const watched: string[] = [];
    const watch = () =>
      watchJob({
        root: fx.root,
        id,
        self: SELF,
        clock: fx.deps.clock,
        quietMs: 60_000,
        write: (line) => watched.push(line),
        waitForChange: async () => {
          throw new Error("the watch should have exited");
        },
      });
    expect(await watch()).toBe(WATCH_EXIT.challenged);
    // A watch armed again before any decision hands it back again instead of hanging.
    expect(await watch()).toBe(WATCH_EXIT.challenged);
    const watchText = watched.join("\n");
    expect(watchText).toContain("PLAYBOOK REVIEW: CHALLENGED");
    expect(watchText).not.toContain("AGENT: quote this review");
    expect(watchText).toContain(
      "This job has been placed on hold pending your review (30 min TTL).",
    );
    expect(watchText).toContain("what would a high level SWE do here?");
    expect(watchText).toContain(`ship-queue cancel ${id}`);
    expect(watchText).toContain(`ship-queue resume ${id} --reason "<brief rationale>"`);

    const out: string[] = [];
    const err: string[] = [];
    const startedWorkers: string[] = [];
    const cli = (argv: ReadonlyArray<string>, waitForChange?: () => Promise<void>) =>
      runShipQueueCli(argv, {
        deps: fx.deps,
        io: { stdout: (t) => out.push(t), stderr: (t) => err.push(t), env: {}, cwd: fx.tmp },
        startWorker: (_root, jobId) => {
          startedWorkers.push(jobId ?? "");
          return "worker=test";
        },
        ...(waitForChange ? { waitForChange: () => waitForChange } : {}),
      });

    // Missing JOB exits 64 without mutating state and hints currently held job IDs.
    expect(await cli(["resume"])).toBe(64);
    expect(err.join("")).toContain(`jobs currently on hold: ${id}`);
    expect(readJob(fx.root, id)).toMatchObject({ state: "waiting", waiting_for: "challenge" });

    // Missing --reason exits 64 without mutating state.
    expect(await cli(["resume", id])).toBe(64);
    expect(NodeFS.existsSync(overrideRequestPath(fx.root, id))).toBe(false);

    // Calling resume records rationale, starts worker, and watches through merge to exit 0.
    let workerTicks = 0;
    const resumeExit = await cli(
      ["resume", id, "--reason", "the flagged helper is test-only\nnot shipped"],
      async () => {
        workerTicks += 1;
        if (workerTicks > 2) throw new Error("expected job to finish");
        await runJob(fx.deps, id);
      },
    );
    expect(resumeExit).toBe(WATCH_EXIT.done);
    expect(startedWorkers).toContain(id);
    const job = readJob(fx.root, id)!;
    expect(job.state).toBe("done");
    expect(job.challenge_override?.reason).toBe("the flagged helper is test-only not shipped");
    expect(fx.markers(id)).toContain(
      `OVERRIDDEN job=${id} reason=the flagged helper is test-only not shipped`,
    );
    expect(fx.prs.get(1)?.body).toContain(
      "## Playbook challenge overridden\n\nthe flagged helper is test-only not shipped",
    );
    expect(fx.merged).toEqual([1]);
    expect(fx.ciRuns()).toBe(1);
    expect(fx.reviews).toHaveLength(1);
    // Resume applies only to an open job on hold (or already resumed and running).
    expect(await cli(["resume", id, "--reason", "again"])).toBe(1);
  });

  it("treats repeat resume calls as idempotent when pending or already running and attaches the watcher", async () => {
    const fx = makeFixture();
    fx.setVerdict("CHALLENGED");
    const wt = fx.worktree("feat/179-idempotent", { "i.txt": "i\n" });
    const id = await fx.submit(wt, "feat/179-idempotent");
    expect(await runJob(fx.deps, id)).toBe("blocked");

    // Pre-write a pending resume request (first attempt recorded it, then caller retried).
    expect(requestChallengeOverride(fx.root, id, "first rationale", fx.deps.clock).ok).toBe(true);
    let ran = false;
    const retryOut: string[] = [];
    const retryCode = await runShipQueueCli(["resume", id, "--reason", "retry rationale"], {
      deps: fx.deps,
      io: { stdout: (t) => retryOut.push(t), stderr: () => {}, env: {}, cwd: fx.tmp },
      startWorker: () => "worker=test",
      waitForChange: () => async () => {
        if (ran) throw new Error("expected job to finish");
        ran = true;
        await runJob(fx.deps, id);
      },
    });
    expect(retryCode).toBe(WATCH_EXIT.done);
    expect(retryOut.join("")).toContain("resume already pending; watching");
    expect(readJob(fx.root, id)?.challenge_override?.reason).toBe("first rationale");

    // Also idempotent when the job already resumed and is running (e.g. mid-merge retry).
    const fx2 = makeFixture({ declaration: "ship_merge=scripts/ship/steps.sh merge\n" });
    fx2.setVerdict("CHALLENGED");
    const wt2 = fx2.worktree("feat/179-running", { "r2.txt": "r2\n" });
    const id2 = await fx2.submit(wt2, "feat/179-running");
    expect(await runJob(fx2.deps, id2)).toBe("blocked");
    expect(requestChallengeOverride(fx2.root, id2, "ship it", fx2.deps.clock).ok).toBe(true);
    // First runJob takes the override, pushes, opens PR, hits merge exit 75 -> still running!
    expect(await runJob(fx2.deps, id2)).toBe("blocked");
    expect(readJob(fx2.root, id2)).toMatchObject({ state: "running" });
    let ran2 = false;
    const out2: string[] = [];
    const code2 = await runShipQueueCli(["override", id2, "--reason", "ship it"], {
      deps: fx2.deps,
      io: { stdout: (t) => out2.push(t), stderr: () => {}, env: {}, cwd: fx2.tmp },
      startWorker: () => "worker=test",
      waitForChange: () => async () => {
        if (ran2) throw new Error("expected job2 to finish");
        ran2 = true;
        await runJob(fx2.deps, id2);
      },
    });
    expect(code2).toBe(WATCH_EXIT.done);
    expect(out2.join("")).toContain("already resumed; watching");
  });

  it("keeps a watch following a challenged job once its log shows the override", async () => {
    const fx = makeFixture();
    fx.setVerdict("CHALLENGED");
    const wt = fx.worktree("feat/98-rewatch", { "r.txt": "r\n" });
    const id = await fx.submit(wt, "feat/98-rewatch");
    expect(await runJob(fx.deps, id)).toBe("blocked");
    // The moment the worker takes the override: OVERRIDDEN is logged while the job record still
    // reads "waiting on a challenge" and no request file is left.
    mark(fx.root, id, `OVERRIDDEN job=${id} reason=raced the watch`);
    const watched: string[] = [];
    let ticks = 0;
    const exit = await watchJob({
      root: fx.root,
      id,
      self: SELF,
      clock: fx.deps.clock,
      quietMs: 60_000,
      write: (line) => watched.push(line),
      waitForChange: async () => {
        ticks += 1;
        if (ticks > 1) throw new Error("the watch should have reached DONE");
        requestChallengeOverride(fx.root, id, "the flagged helper is test-only", fx.deps.clock);
        await runJob(fx.deps, id);
      },
    });
    expect(exit).toBe(WATCH_EXIT.done);
    expect(watched.join("\n")).not.toContain("This job has been placed on hold");
  });

  it("lets a resubmit of the branch replace the challenged job", async () => {
    const fx = makeFixture();
    fx.setVerdict("CHALLENGED");
    const wt = fx.worktree("feat/98-fix", { "y.txt": "y\n" });
    const first = await fx.submit(wt, "feat/98-fix");
    expect(await runJob(fx.deps, first)).toBe("blocked");

    NodeFS.writeFileSync(NodePath.join(wt, "y.txt"), "fixed\n");
    sh(wt, ["commit", "-q", "-am", "fix the findings"]);
    fx.setVerdict("PASS");
    const second = await fx.submit(wt, "feat/98-fix");

    expect(readJob(fx.root, first)).toMatchObject({ state: "failed", reason: "superseded" });
    expect(await runJob(fx.deps, second)).toBe("ended");
    expect(readJob(fx.root, second)?.state).toBe("done");
  });

  it("skips reviewHead after rebasing a resumed job onto a newer main when patch-id matches", async () => {
    const fx = makeFixture();
    fx.setVerdict("CHALLENGED");
    const wt = fx.worktree("feat/179-rebase-resume", { "feature.txt": "v1\n" });
    const id = await fx.submit(wt, "feat/179-rebase-resume");

    expect(await runJob(fx.deps, id)).toBe("blocked");
    expect(fx.ciRuns()).toBe(1);
    expect(fx.reviews).toHaveLength(1);

    // Another PR lands on main while this job is on hold.
    NodeFS.writeFileSync(NodePath.join(fx.primary, "unrelated.txt"), "main moved\n");
    sh(fx.primary, ["add", "unrelated.txt"]);
    sh(fx.primary, ["commit", "-q", "-m", "unrelated landing on main"]);
    sh(fx.primary, ["push", "-q", "origin", "HEAD:refs/heads/main"]);

    expect(requestChallengeOverride(fx.root, id, "low-value finding", fx.deps.clock).ok).toBe(true);
    expect(await runJob(fx.deps, id)).toBe("ended");
    expect(readJob(fx.root, id)).toMatchObject({ state: "done" });
    // CI re-ran on the rebased head, but reviewHead was skipped because patch-id matched.
    expect(fx.ciRuns()).toBe(2);
    expect(fx.reviews).toHaveLength(1);
    expect(readLog(fx.root, id)).toContain("playbook review skipped on");
    expect(fx.merged).toEqual([1]);
  });

  it("does not trip quietMs while a resumed job waits for the repo lock behind another running job", async () => {
    const fx = makeFixture();
    fx.setVerdict("CHALLENGED");
    let nowMs = Date.UTC(2026, 0, 1);
    const deps: ShipQueueDeps = { ...fx.deps, clock: { now: () => new Date(nowMs).toISOString() } };
    const wt1 = fx.worktree("feat/179-quiet-1", { "q1.txt": "1\n" });
    const id1 = await fx.submit(wt1, "feat/179-quiet-1", deps);
    expect(await runJob(deps, id1)).toBe("blocked");

    // Job 2 is actively running in the same repo.
    const wt2 = fx.worktree("feat/179-quiet-2", { "q2.txt": "2\n" });
    const id2 = await fx.submit(wt2, "feat/179-quiet-2", deps);
    fx.setVerdict("PASS");

    expect(requestChallengeOverride(fx.root, id1, "waiting behind job 2", deps.clock).ok).toBe(
      true,
    );
    let tick = 0;
    const watched: string[] = [];
    const exit = await watchJob({
      root: fx.root,
      id: id1,
      self: SELF,
      clock: deps.clock,
      quietMs: 30_000,
      write: (line) => watched.push(line),
      waitForChange: async () => {
        tick += 1;
        // Advance far past quietMs while job 1 waits for its turn behind job 2.
        nowMs += 45_000;
        if (tick === 2) {
          await runJob(deps, id2);
          await runJob(deps, id1);
        } else if (tick > 3) {
          throw new Error("expected resumed job to finish");
        }
      },
    });
    expect(exit).toBe(WATCH_EXIT.done);
    expect(watched.join("\n")).not.toContain("QUIET job=");
  });

  it("lets an already-running job finish before a newly-resumed earlier job jumps ahead", async () => {
    const fx = makeFixture({ declaration: "ship_merge=scripts/ship/steps.sh merge\n" });
    fx.setVerdict("CHALLENGED");
    const wt1 = fx.worktree("feat/179-order-1", { "o1.txt": "1\n" });
    const id1 = await fx.submit(wt1, "feat/179-order-1");
    const wt2 = fx.worktree("feat/179-order-2", { "o2.txt": "2\n" });
    const id2 = await fx.submit(wt2, "feat/179-order-2");

    // Job 1 parks on hold; job 2 starts, pushes, opens PR, and hits merge exit 75 (still running).
    expect(await runJob(fx.deps, id1)).toBe("blocked");
    fx.setVerdict("PASS");
    const pass1 = await runDueWork(fx.deps);
    expect(pass1.blocked).toEqual([id2]);
    expect(readJob(fx.root, id2)).toMatchObject({ state: "running", merge_retries: 1 });

    // Resume job 1 while job 2 is already in progress; job 2 must finish before job 1 lands.
    expect(
      requestChallengeOverride(fx.root, id1, "resumed behind running job", fx.deps.clock).ok,
    ).toBe(true);
    const pass2 = await runDueWork(fx.deps);
    expect(pass2.ended[0]).toBe(id2);
    expect(readJob(fx.root, id2)).toMatchObject({ state: "done" });
    // Job 1 runs right after job 2 finishes (hitting merge exit 75 on its first try, then finishing).
    expect(readJob(fx.root, id1)).toMatchObject({ state: "done" });
  });
});

describe("remote CI", () => {
  it("runs install and CI in a worktree of the CI host's checkout at the pushed tip, then drops it", async () => {
    const fx = makeFixture();
    const home = NodePath.join(fx.tmp, "ci-home");
    const hostClone = NodePath.join(home, "Dev", "sample-repo");
    NodeFS.mkdirSync(NodePath.dirname(hostClone), { recursive: true });
    sh(fx.tmp, [
      "clone",
      "-q",
      NodePath.join(fx.tmp, "remotes", "acme-fixture", "sample-repo.git"),
      hostClone,
    ]);
    // The CI host is this machine under its own HOME; ssh:// pushes go to its checkout directly.
    const runRemote: RemoteCommandRunner = (_alias, script, options = {}) =>
      nodeProcessRunner({
        command: "bash",
        args: ["-c", script],
        cwd: home,
        env: { HOME: home, PATH: process.env.PATH ?? "" },
        replaceEnv: true,
        stdin: options.stdin,
      });
    const run: ProcessRunner = (input) =>
      nodeProcessRunner({
        ...input,
        args: input.args.map((a) => a.replace(/^ssh:\/\/ci-1(?=\/)/, "")),
      });
    const deps: ShipQueueDeps = {
      ...fx.deps,
      run,
      runRemote,
      ciPlacer: async () => ({
        kind: "remote",
        host: { name: "ci-1", ssh: "ci-1", role: "ci", data_root: NodePath.join(home, "data") },
        note: "ci host ci-1: room",
      }),
    };
    const wt = fx.worktree("feat/98-remote", { "r.txt": "r\n" });
    const id = await fx.submit(wt, "feat/98-remote", deps);

    expect(await runJob(deps, id)).toBe("ended");

    const job = readJob(fx.root, id)!;
    expect(job.state).toBe("done");
    expect(job.steps?.map((s) => [s.name, s.host, s.exit])).toEqual([
      ["ship_body_check", "local", 0],
      ["ship_install", "ci-1", 0],
      ["ship_ci", "ci-1", 0],
    ]);
    expect(fx.reviews[0]!.ciOutput).toContain("=== ship_ci (host ci-1, exit 0");
    expect(fx.reviews[0]!.ciOutput).toContain("ci: 42 tests passed");
    expect(sh(hostClone, ["worktree", "list"]).split("\n")).toHaveLength(1);
    expect(sh(hostClone, ["for-each-ref", "refs/ci"])).toBe("");
    expect(sh(hostClone, ["branch", "--list", "ship-queue-ci-*"])).toBe("");
  });
});

describe("declared merge and routing waits", () => {
  it("merges through ship_merge, landing again after exit 75 without asking the owner twice", async () => {
    const fx = makeFixture({ declaration: "ship_merge=scripts/ship/steps.sh merge\n" });
    const consumed: boolean[] = [];
    const bundle = {
      repo: "acme-fixture/sample-repo",
      branch: "feat/98-merge",
      pr_or_issue: "98",
      gates: [{ gate_id: "infra", reason: "fixture protected path" }],
      protected_paths: ["infra/x.txt"],
      protected_diff_sha256: "f".repeat(64),
      body_sha256: "",
      commit_sha: "",
    };
    const deps: ShipQueueDeps = {
      ...fx.deps,
      guard: {
        inspect: () => bundle,
        check: async ({ consume }) => {
          consumed.push(consume);
          return { ok: true };
        },
      },
    };
    const wt = fx.worktree("feat/98-merge", { "m.txt": "m\n" });
    const id = await fx.submit(wt, "feat/98-merge", deps);

    expect(await runJob(deps, id)).toBe("blocked");
    expect(readJob(fx.root, id)).toMatchObject({ state: "running", merge_retries: 1, pr: 1 });
    expect(readLog(fx.root, id)).toContain(
      "ship_merge exit 75 (the base moved); the job lands again",
    );
    expect(fx.markers(id).some((l) => l.startsWith("MERGE_EXIT="))).toBe(false);

    // The base moves: the job rebases, runs its CI again, and keeps the owner's earlier grant.
    NodeFS.writeFileSync(NodePath.join(fx.primary, "other.txt"), "other\n");
    sh(fx.primary, ["add", "other.txt"]);
    sh(fx.primary, ["commit", "-q", "-m", "someone else landed"]);
    sh(fx.primary, ["push", "-q", "origin", "HEAD:refs/heads/main"]);
    expect(await runJob(deps, id)).toBe("ended");

    const job = readJob(fx.root, id)!;
    expect(job).toMatchObject({ state: "done", merge_exit: 0 });
    expect(consumed).toEqual([true]);
    // The job never waited for the owner: it found the pull request's earlier approval.
    expect(fx.markers(id)).toContain("protected diff approval reused: infra/x.txt");
    expect(fx.ciRuns()).toBe(2);
    expect(fx.merged).toEqual([]);
    const calls = NodeFS.readFileSync(fx.stateFile("merge-calls"), "utf8").trim().split("\n");
    expect(calls).toHaveLength(2);
    expect(calls[1]).toBe(`1 ${job.pushed_sha} ${job.rebased_onto}`);
    expect(fx.markers(id)).toContain("MERGE_EXIT=0");
  });

  it("waits while no CI host can take the job, and fails one no host can run", async () => {
    const fx = makeFixture();
    let asked = 0;
    const waiting: ShipQueueDeps = {
      ...fx.deps,
      ciPlacer: async () => {
        asked += 1;
        return { kind: "wait", reason: "ci_hosts_off hosts=ci-1" };
      },
    };
    const wt = fx.worktree("feat/98-wait", { "w.txt": "w\n" });
    const id = await fx.submit(wt, "feat/98-wait", waiting);

    expect(await runJob(waiting, id)).toBe("blocked");
    expect(await runJob(waiting, id)).toBe("blocked");
    expect(asked).toBe(1);
    expect(readJob(fx.root, id)).toMatchObject({ state: "running" });
    expect(readLog(fx.root, id)).toContain("waiting for a CI host: ci_hosts_off hosts=ci-1");
    expect(fx.ciRuns()).toBe(0);

    const failing: ShipQueueDeps = {
      ...fx.deps,
      ciPlacer: async () => ({ kind: "fail", reason: "ci_host_missing_tool host=ci-1 tool=vp" }),
    };
    const wt2 = fx.worktree("feat/98-nohost", { "n.txt": "n\n" });
    const id2 = await fx.submit(wt2, "feat/98-nohost", failing);
    expect(await runJob(failing, id2)).toBe("ended");
    expect(fx.markers(id2).at(-1)).toBe("FAILED reason=ci_host_missing_tool host=ci-1 tool=vp");
  });

  it("fails a job no CI host takes within an hour, so it stops holding its repo's queue", async () => {
    const fx = makeFixture();
    let nowMs = Date.UTC(2026, 0, 1);
    const deps: ShipQueueDeps = {
      ...fx.deps,
      clock: { now: () => new Date(nowMs).toISOString() },
      ciPlacer: async () => ({ kind: "wait", reason: "ci_host_on_battery hosts=ci-1" }),
    };
    const wt = fx.worktree("feat/98-nohostlong", { "l.txt": "l\n" });
    const id = await fx.submit(wt, "feat/98-nohostlong", deps);

    expect(await runJob(deps, id)).toBe("blocked");
    nowMs += 59 * 60_000;
    expect(await runJob(deps, id)).toBe("blocked");
    nowMs += 2 * 60_000;
    expect(await runJob(deps, id)).toBe("ended");
    expect(fx.markers(id).at(-1)).toBe(
      "FAILED reason=ci_host_unavailable ci_host_on_battery hosts=ci-1",
    );
    expect(fx.ciRuns()).toBe(0);
  });
});

describe("unanswered challenge", () => {
  it("honors a resume made inside 30 min even when the worker reads it later", async () => {
    const fx = makeFixture();
    fx.setVerdict("CHALLENGED");
    let nowMs = Date.UTC(2026, 0, 1);
    const deps: ShipQueueDeps = { ...fx.deps, clock: { now: () => new Date(nowMs).toISOString() } };
    const wt = fx.worktree("feat/98-timely", { "t.txt": "t\n" });
    const id = await fx.submit(wt, "feat/98-timely", deps);
    expect(await runJob(deps, id)).toBe("blocked");
    nowMs += CHALLENGE_WAIT_MS - 60_000;
    expect(requestChallengeOverride(fx.root, id, "made in time", deps.clock).ok).toBe(true);
    // The worker's next tick lands after the 30 min window: the timely request still counts.
    nowMs += 120_000;
    expect(await runJob(deps, id)).toBe("ended");
    expect(readJob(fx.root, id)).toMatchObject({ state: "done" });
    expect(fx.merged).toEqual([1]);
    expect(
      NodeFS.readFileSync(NodePath.join(fx.root, "challenge-overrides.jsonl"), "utf8"),
    ).toContain(`"job":"${id}"`);
  });

  it("refuses a resume made after 30 min, even before the worker fails the job", async () => {
    const fx = makeFixture();
    fx.setVerdict("CHALLENGED");
    let nowMs = Date.UTC(2026, 0, 1);
    const deps: ShipQueueDeps = { ...fx.deps, clock: { now: () => new Date(nowMs).toISOString() } };
    const wt = fx.worktree("feat/98-late", { "l.txt": "l\n" });
    const id = await fx.submit(wt, "feat/98-late", deps);
    expect(await runJob(deps, id)).toBe("blocked");
    nowMs += CHALLENGE_WAIT_MS + 1_000;
    // The job still waits (no worker tick yet), but the 30 min hold is over.
    expect(readJob(fx.root, id)).toMatchObject({ state: "waiting", waiting_for: "challenge" });
    const out: string[] = [];
    expect(
      await runShipQueueCli(["resume", id, "--reason", "too late"], {
        deps,
        io: { stdout: (t) => out.push(t), stderr: (t) => out.push(t), env: {}, cwd: fx.tmp },
      }),
    ).toBe(1);
    expect(out.join("")).toContain("30 min review hold is over");
    // A request file written behind the CLI's back is not honored either.
    NodeFS.writeFileSync(
      overrideRequestPath(fx.root, id),
      `${JSON.stringify({ reason: "forged late", at: new Date(nowMs).toISOString() })}\n`,
    );
    expect(await runJob(deps, id)).toBe("ended");
    expect(fx.markers(id).at(-1)).toBe("FAILED reason=challenged");
    expect(fx.merged).toEqual([]);
  });

  it("does not block later jobs in the same repo while a challenged job is on hold, then expires it after 30 min", async () => {
    const fx = makeFixture();
    fx.setVerdict("CHALLENGED");
    let nowMs = Date.UTC(2026, 0, 1);
    const deps: ShipQueueDeps = { ...fx.deps, clock: { now: () => new Date(nowMs).toISOString() } };
    const wt = fx.worktree("feat/98-silent", { "s.txt": "s\n" });
    const id = await fx.submit(wt, "feat/98-silent", deps);
    const nextWt = fx.worktree("feat/98-next", { "n.txt": "n\n" });
    const next = await fx.submit(nextWt, "feat/98-next", deps);

    // First job gets challenged and parks on hold; flip verdict to PASS and ensure job 2 runs immediately.
    await runJob(deps, id);
    expect(readJob(fx.root, id)).toMatchObject({ state: "waiting", waiting_for: "challenge" });
    fx.setVerdict("PASS");

    // Job 2 runs and merges while job 1 remains parked on hold well inside the 30 min TTL.
    await runDueWork(deps);
    expect(readJob(fx.root, next)).toMatchObject({ state: "done" });
    expect(readJob(fx.root, id)).toMatchObject({ state: "waiting", waiting_for: "challenge" });
    expect(hasOpenJobsForWorker(fx.root)).toBe(true);

    // At 29 min, job 1 is still on hold.
    nowMs += 29 * 60_000;
    await runDueWork(deps);
    expect(readJob(fx.root, id)).toMatchObject({ state: "waiting", waiting_for: "challenge" });

    // Past 30 min TTL: the worker expires the abandoned hold under the repo lock.
    nowMs += 2 * 60_000;
    await runDueWork(deps);
    expect(readJob(fx.root, id)).toMatchObject({ state: "failed" });
    expect(fx.markers(id).at(-1)).toBe("FAILED reason=challenged");

    // A resume after expiration is refused: the job is over.
    const out: string[] = [];
    expect(
      await runShipQueueCli(["resume", id, "--reason", "too late"], {
        deps,
        io: { stdout: (t) => out.push(t), stderr: (t) => out.push(t), env: {}, cwd: fx.tmp },
      }),
    ).toBe(1);
    expect(NodeFS.existsSync(overrideRequestPath(fx.root, id))).toBe(false);
  });
});

describe("owner approval of a protected diff", () => {
  it("opens the owner's window itself, once, and says so in the marker", async () => {
    const fx = makeFixture();
    const asked: string[] = [];
    const bundle = {
      repo: "acme-fixture/sample-repo",
      branch: "feat/147-window",
      pr_or_issue: "",
      gates: [{ gate_id: "infra", reason: "fixture protected path" }],
      protected_paths: ["infra/x.txt"],
      protected_diff_sha256: "a".repeat(64),
      body_sha256: "",
      commit_sha: "",
    };
    const deps: ShipQueueDeps = {
      ...fx.deps,
      guard: {
        inspect: () => bundle,
        check: async () => ({ ok: false }),
        request: async ({ jobId }) => {
          asked.push(jobId);
          return { ok: true };
        },
      },
    };
    const wt = fx.worktree("feat/147-window", { "w.txt": "w\n" });
    const id = await fx.submit(wt, "feat/147-window", deps);

    expect(await runJob(deps, id)).toBe("blocked");
    expect(readJob(fx.root, id)).toMatchObject({ state: "waiting", waiting_for: "action" });
    expect(asked).toEqual([id]);
    expect(fx.markers(id).find((l) => l.startsWith("ACTION_REQUIRED"))).toContain(
      "the queue opened the owner's approval window",
    );
    // A job still waiting on the same diff opens no second window.
    expect(await runJob(deps, id)).toBe("blocked");
    expect(asked).toEqual([id]);
    expect(fx.ciRuns()).toBe(0);
  });
});
