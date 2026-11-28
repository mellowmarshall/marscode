// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Declared steps and the challenge gate over real temporary git repositories and step scripts.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { runShipQueueCli } from "./cli.ts";
import { jobReviewPath, readJob, readLog, registerWatcher } from "./jobStore.ts";
import { nodeProcessRunner } from "./nodeProcess.ts";
import { currentProcessIdentity, isProcessAlive } from "./processIdentity.ts";
import { ciOutputPath } from "./ciSteps.ts";
import type { RemoteCommandRunner } from "./sshExec.ts";
import { submitJob } from "./submit.ts";
import type { ProcessRunner, ShipForge, ShipQueueDeps } from "./types.ts";
import { WATCH_EXIT, watchJob } from "./watcher.ts";
import { runJob } from "./worker.ts";

const SELF = currentProcessIdentity();
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function sh(cwd: string, args: ReadonlyArray<string>): string {
  const res = NodeChildProcess.spawnSync(
    "git",
    ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
  );
  if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
  return res.stdout.trim();
}

const DECLARATION = [
  "base_ref=origin/main",
  "ship_repo=sample-repo",
  "ship_gh_repo=acme-fixture/sample-repo",
  "ship_body_check=scripts/ship/steps.sh body",
  "ship_install=scripts/ship/steps.sh install",
  "ship_ci=scripts/ship/steps.sh ci",
  "",
].join("\n");

/** The base's step script: CI fails when the branch carries `ci-fail`; each CI run is counted. */
const STEPS_SCRIPT = `#!/usr/bin/env bash
case "$1" in
  body) grep -q "Closes #" "$2" || { echo "the PR body names no issue"; exit 1; } ;;
  install) echo "install ok" ;;
  ci)
    echo "ci run" >> "\${SHIP_QUEUE_STATE:-/dev/null}/ci-runs"
    if [ -f ci-fail ]; then for i in $(seq 1 60); do echo "noise line $i"; done; echo "ci: 1 test failed in ci-fail"; exit 3; fi
    echo "ci: 42 tests passed at $(git rev-parse --short HEAD) base \${SHIP_QUEUE_BASE_REF}" ;;
  merge)
    f="$SHIP_QUEUE_STATE/merge-calls"
    echo "$2 $SHIP_QUEUE_TIP $SHIP_QUEUE_ONTO" >> "$f"
    if [ "$(wc -l < "$f")" -lt 2 ]; then echo "main moved during the gate" | tee "$SHIP_QUEUE_REASON_FILE"; exit 75; fi
    echo "merged $2" ;;
esac
`;

function testClock() {
  let seconds = 0;
  return { now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds++)).toISOString() };
}

function makeFixture(options: { readonly declaration?: string } = {}) {
  const tmp = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sq-steps-")));
  cleanups.push(() => NodeFS.rmSync(tmp, { recursive: true, force: true }));
  const remoteDir = NodePath.join(tmp, "remotes", "acme-fixture", "sample-repo.git");
  NodeFS.mkdirSync(remoteDir, { recursive: true });
  sh(remoteDir, ["init", "-q", "--bare", "-b", "main"]);
  const primary = NodePath.join(tmp, "sample-repo");
  sh(tmp, ["clone", "-q", remoteDir, primary]);
  sh(primary, ["config", "user.name", "Fixture Lane"]);
  sh(primary, ["config", "user.email", "lane@example.invalid"]);
  NodeFS.mkdirSync(NodePath.join(primary, "scripts", "ship"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(primary, "README.md"), "# sample\n");
  NodeFS.writeFileSync(
    NodePath.join(primary, ".tree-guard.conf"),
    `${DECLARATION}${options.declaration ?? ""}`,
  );
  NodeFS.writeFileSync(NodePath.join(primary, "scripts", "ship", "steps.sh"), STEPS_SCRIPT);
  sh(primary, ["add", "-A"]);
  sh(primary, ["commit", "-q", "-m", "init"]);
  sh(primary, ["push", "-q", "origin", "HEAD:refs/heads/main"]);
  sh(primary, ["remote", "set-head", "origin", "main"]);

  const prs = new Map<number, { head: string; base: string; title: string; body: string }>();
  const merged: number[] = [];
  const comments: string[] = [];
  const forgeClone = NodePath.join(tmp, "forge-clone");
  sh(tmp, ["clone", "-q", remoteDir, forgeClone]);
  sh(forgeClone, ["config", "user.name", "Fixture Forge"]);
  sh(forgeClone, ["config", "user.email", "forge@example.invalid"]);
  const forge: ShipForge = {
    isPullRequestMerged: async ({ number }) => merged.includes(number),
    findOpenPullRequest: async ({ head }) => {
      for (const [number, pr] of prs)
        if (!merged.includes(number) && pr.head === head) return { number };
      return null;
    },
    createPullRequest: async ({ head, base, title, body }) => {
      const number = prs.size + 1;
      prs.set(number, { head, base, title, body });
      return { number };
    },
    mergePullRequest: async ({ number, title }) => {
      const pr = prs.get(number)!;
      sh(forgeClone, ["fetch", "-q", "origin"]);
      sh(forgeClone, ["checkout", "-q", "-B", pr.base, `origin/${pr.base}`]);
      sh(forgeClone, ["merge", "-q", "--squash", `origin/${pr.head}`]);
      sh(forgeClone, ["commit", "-q", "-m", `${title} (#${number})`]);
      sh(forgeClone, ["push", "-q", "origin", `HEAD:refs/heads/${pr.base}`]);
      merged.push(number);
      return { exitCode: 0, message: `merged #${number}` };
    },
    commentOnPullRequest: async ({ body }) => {
      comments.push(body);
    },
  };

  const reviews: Array<{ ciOutput: string | null }> = [];
  let verdict = "PASS";
  const root = NodePath.join(tmp, "queue");
  const deps: ShipQueueDeps = {
    root,
    run: nodeProcessRunner,
    forge,
    guard: { inspect: () => undefined, check: async () => ({ ok: false }) },
    secretScan: async () => [],
    hygieneScan: async () => ({ kind: "skip", log: "house hygiene: skipped (fixture)" }),
    // Reads CI output where `playbook challenge` reads it: beside SHIP_QUEUE_BODYFILE.
    declarationChallenge: async ({ bodyFile, outFile }) => {
      let ciOutput: string | null = null;
      try {
        ciOutput = NodeFS.readFileSync(
          NodePath.join(NodePath.dirname(bodyFile), "ci-output.txt"),
          "utf8",
        );
      } catch {
        ciOutput = null;
      }
      reviews.push({ ciOutput });
      const report = `PLAYBOOK REVIEW: ${verdict}\nSummary:\n  fixture review\n`;
      NodeFS.writeFileSync(outFile, report, "utf8");
      return { output: `house declaration-challenge: ${verdict}`, report };
    },
    clock: testClock(),
    isProcessAlive,
    self: SELF,
    watcherWaitMs: 60_000,
  };

  const worktree = (branch: string, files: Record<string, string>) => {
    const wt = NodePath.join(tmp, "worktrees", branch.replace(/\//g, "-"));
    sh(primary, ["worktree", "add", "-q", "-b", branch, wt, "origin/main"]);
    for (const [file, text] of Object.entries(files))
      NodeFS.writeFileSync(NodePath.join(wt, file), text);
    sh(wt, ["add", "-A"]);
    sh(wt, ["commit", "-q", "-m", `work on ${branch}`]);
    return wt;
  };
  const submit = async (wt: string, branch: string, withDeps: ShipQueueDeps = deps) => {
    const res = await submitJob(withDeps, {
      worktree: wt,
      branch,
      title: `ship ${branch}`,
      body: "Closes #98\n",
      identity: {},
    });
    if (!res.ok) throw new Error(`submit refused: ${res.reason}`);
    registerWatcher(root, res.id, SELF);
    return res.id;
  };
  const markers = (id: string) =>
    readLog(root, id)
      .split("\n")
      .filter((l) => l && !l.startsWith(" "));
  const ciRuns = () => {
    try {
      return NodeFS.readFileSync(
        NodePath.join(root, "repos", "acme-fixture", "sample-repo", "ci-runs"),
        "utf8",
      )
        .trim()
        .split("\n").length;
    } catch {
      return 0;
    }
  };
  const stateFile = (name: string) =>
    NodePath.join(root, "repos", "acme-fixture", "sample-repo", name);
  return {
    tmp,
    root,
    primary,
    stateFile,
    deps,
    prs,
    merged,
    comments,
    reviews,
    setVerdict: (v: string) => {
      verdict = v;
    },
    worktree,
    submit,
    markers,
    ciRuns,
  };
}

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
    expect(log).toContain("earlier lines in the CI output");
    expect(log).not.toContain("noise line 5\n");
    expect(job.steps?.map((s) => [s.name, s.exit])).toEqual([
      ["ship_body_check", 0],
      ["ship_install", 0],
      ["ship_ci", 3],
    ]);
    expect(fx.reviews).toHaveLength(0);
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
  it("stops a CHALLENGED job before merge until the agent overrides it with a reason", async () => {
    const fx = makeFixture();
    fx.setVerdict("CHALLENGED");
    const wt = fx.worktree("feat/98-challenged", { "x.txt": "x\n" });
    const id = await fx.submit(wt, "feat/98-challenged");

    expect(await runJob(fx.deps, id)).toBe("blocked");
    const parked = readJob(fx.root, id)!;
    expect(parked).toMatchObject({ state: "waiting", waiting_for: "challenge" });
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
    expect(watched.join("\n")).toContain("PLAYBOOK REVIEW: CHALLENGED");
    expect(watched.join("\n")).toContain(`ship-queue override ${id} --reason`);

    const out: string[] = [];
    const cli = (argv: ReadonlyArray<string>) =>
      runShipQueueCli(argv, {
        deps: fx.deps,
        io: { stdout: (t) => out.push(t), stderr: (t) => out.push(t), env: {}, cwd: fx.tmp },
      });
    expect(await cli(["override", id])).toBe(64);
    expect(
      await cli(["override", id, "--reason", "the flagged helper is test-only\nnot shipped"]),
    ).toBe(0);

    expect(await runJob(fx.deps, id)).toBe("ended");
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
    // An override applies only to a job that waits on its review.
    expect(await cli(["override", id, "--reason", "again"])).toBe(1);
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
  it("fails a CHALLENGED job with no fix or override within an hour", async () => {
    const fx = makeFixture();
    fx.setVerdict("CHALLENGED");
    let nowMs = Date.UTC(2026, 0, 1);
    const deps: ShipQueueDeps = { ...fx.deps, clock: { now: () => new Date(nowMs).toISOString() } };
    const wt = fx.worktree("feat/98-silent", { "s.txt": "s\n" });
    const id = await fx.submit(wt, "feat/98-silent", deps);

    expect(await runJob(deps, id)).toBe("blocked");
    nowMs += 59 * 60_000;
    expect(await runJob(deps, id)).toBe("blocked");
    nowMs += 2 * 60_000;
    expect(await runJob(deps, id)).toBe("ended");
    expect(readJob(fx.root, id)).toMatchObject({ state: "failed" });
    expect(fx.markers(id).at(-1)).toBe(
      "FAILED reason=challenge_unanswered: no fix or override within an hour",
    );
    expect(fx.prs.size).toBe(0);
  });
});
