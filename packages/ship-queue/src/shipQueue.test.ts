// @effect-diagnostics nodeBuiltinImport:off - Ship-queue engine tests over real temporary git repositories and a bare fixture remote.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { runShipQueueCli } from "./cli.ts";
import { guardProtocolGuard } from "./houseGate.ts";
import {
  jobBodyPath,
  jobLogPath,
  jobReviewPath,
  readJob,
  readLog,
  registerWatcher,
} from "./jobStore.ts";
import { nodeProcessRunner } from "./nodeProcess.ts";
import { formatReviewComment, postReviewComment } from "./prFlow.ts";
import { currentProcessIdentity, isProcessAlive, processStartTicks } from "./processIdentity.ts";
import { claimLock, lockHolder, tryAcquireRepoLock } from "./processLocks.ts";
import { submitJob } from "./submit.ts";
import type { GuardCheck, ProcessRunner, ShipForge, ShipQueueDeps } from "./types.ts";
import { MarkerTail, WATCH_EXIT, watchJob } from "./watcher.ts";
import { cancelJob, runDueWork, runJob } from "./worker.ts";

const REPO = "acme-fixture/sample-repo";
const SELF = currentProcessIdentity();
/** A live process that is not this one: another worker's stand-in. */
const PARENT = { pid: process.ppid, startTicks: processStartTicks(process.ppid) };
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

function iso(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `2026-01-01T${pad(h)}:${pad(m)}:${pad(s)}.000Z`;
}

function testClock() {
  let seconds = 0;
  return {
    advance: (by: number) => {
      seconds += by;
    },
    now: () => iso(seconds++),
  };
}

/** A real forge stand-in: squash-merges PR heads into the bare remote's main from its own clone. */
function fixtureForge(remoteDir: string, scratch: string) {
  const prs = new Map<
    number,
    { head: string; base: string; title: string; body: string; open: boolean }
  >();
  const merged: number[] = [];
  let beforeMerge: (() => void) | null = null;
  const clone = NodePath.join(scratch, "forge-clone");
  sh(scratch, ["clone", "-q", remoteDir, clone]);
  sh(clone, ["config", "user.name", "Fixture Forge"]);
  sh(clone, ["config", "user.email", "forge@example.invalid"]);
  const forge: ShipForge = {
    isPullRequestMerged: async ({ number }) => merged.includes(number),
    findOpenPullRequest: async ({ head }) => {
      for (const [number, pr] of prs) if (pr.open && pr.head === head) return { number };
      return null;
    },
    createPullRequest: async ({ head, base, title, body }) => {
      const number = prs.size + 1;
      prs.set(number, { head, base, title, body, open: true });
      return { number };
    },
    mergePullRequest: async ({ number, headSha, title }) => {
      beforeMerge?.();
      const pr = prs.get(number);
      if (!pr?.open) return { exitCode: 1, message: `pull request #${number} is not open` };
      sh(clone, ["fetch", "-q", "origin"]);
      const tip = sh(clone, ["rev-parse", `origin/${pr.head}`]);
      if (tip !== headSha) return { exitCode: 1, message: `head moved: ${tip} is not ${headSha}` };
      sh(clone, ["checkout", "-q", "-B", pr.base, `origin/${pr.base}`]);
      sh(clone, ["merge", "-q", "--squash", `origin/${pr.head}`]);
      sh(clone, ["commit", "-q", "-m", `${title} (#${number})`, "-m", pr.body]);
      sh(clone, ["push", "-q", "origin", `HEAD:refs/heads/${pr.base}`]);
      pr.open = false;
      merged.push(number);
      return { exitCode: 0, message: `merged #${number}` };
    },
  };
  return {
    forge,
    prs,
    merged,
    onBeforeMerge: (fn: () => void) => {
      beforeMerge = fn;
    },
  };
}

function makeFixture(options?: { readonly grant?: () => GuardCheck }) {
  const tmp = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ship-queue-test-")),
  );
  cleanups.push(() => NodeFS.rmSync(tmp, { recursive: true, force: true }));
  const remoteDir = NodePath.join(tmp, "remotes", "acme-fixture", "sample-repo.git");
  NodeFS.mkdirSync(remoteDir, { recursive: true });
  sh(remoteDir, ["init", "-q", "--bare", "-b", "main"]);
  const primary = NodePath.join(tmp, "sample-repo");
  sh(tmp, ["clone", "-q", remoteDir, primary]);
  sh(primary, ["config", "user.name", "Fixture Lane"]);
  sh(primary, ["config", "user.email", "lane@example.invalid"]);
  NodeFS.writeFileSync(NodePath.join(primary, "README.md"), "# sample\n");
  sh(primary, ["add", "README.md"]);
  sh(primary, ["commit", "-q", "-m", "init"]);
  sh(primary, ["push", "-q", "origin", "HEAD:refs/heads/main"]);
  sh(primary, ["remote", "set-head", "origin", "main"]);

  const forge = fixtureForge(remoteDir, tmp);
  const clock = testClock();
  const guardCalls: string[] = [];
  const root = NodePath.join(tmp, "queue");
  const deps: ShipQueueDeps = {
    root,
    run: nodeProcessRunner,
    forge: forge.forge,
    guard: {
      inspect: guardProtocolGuard.inspect,
      check: async ({ bundle }) => {
        guardCalls.push(bundle.protected_paths.join(","));
        return options?.grant?.() ?? { ok: false, reason: "no grant" };
      },
    },
    secretScan: async () => [],
    hygieneScan: async () => ({ kind: "skip", log: "house hygiene: skipped (fixture)" }),
    clock,
    isProcessAlive,
    self: SELF,
    watcherWaitMs: 60_000,
  };

  const worktree = (branch: string, files: Record<string, string>, base = "origin/main") => {
    const wt = NodePath.join(tmp, "worktrees", branch.replace(/\//g, "-"));
    sh(primary, ["worktree", "add", "-q", "-b", branch, wt, base]);
    for (const [file, text] of Object.entries(files)) {
      NodeFS.mkdirSync(NodePath.dirname(NodePath.join(wt, file)), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(wt, file), text);
    }
    sh(wt, ["add", "-A"]);
    sh(wt, ["commit", "-q", "-m", `work on ${branch}`]);
    return wt;
  };
  const submit = (wt: string, branch: string, body = "Closes #8\n") =>
    submitJob(deps, { worktree: wt, branch, title: `ship ${branch}`, body, identity: {} });
  const submitOk = async (wt: string, branch: string, body?: string) => {
    const res = await submit(wt, branch, body);
    if (!res.ok) throw new Error(`submit refused: ${res.reason}`);
    return res.id;
  };
  const markers = (id: string) =>
    readLog(root, id)
      .split("\n")
      .filter((l) => l && !l.startsWith(" "));
  return {
    tmp,
    root,
    remoteDir,
    primary,
    deps,
    clock,
    forge,
    guardCalls,
    worktree,
    submit,
    submitOk,
    markers,
  };
}

describe("ship-queue engine", () => {
  it("lands one repo's jobs in submit order, rebasing each onto the last merge, then cleans up", async () => {
    const fx = makeFixture();
    const wtA = fx.worktree("feat/1-alpha", { "a.txt": "alpha\n" });
    const wtB = fx.worktree("feat/2-beta", { "b.txt": "beta\n" });
    const a = await fx.submitOk(wtA, "feat/1-alpha");
    const b = await fx.submitOk(wtB, "feat/2-beta");
    registerWatcher(fx.root, a, SELF);
    registerWatcher(fx.root, b, SELF);

    const res = await runDueWork(fx.deps);

    expect(res.ended).toEqual([a, b]);
    expect(fx.forge.merged).toEqual([1, 2]);
    const prefixes = (id: string) => fx.markers(id).map((l) => l.split(/[= ]/)[0]);
    expect(prefixes(a)).toEqual([
      "QUEUED",
      "STARTED",
      "REBASED",
      "PUSH_EXIT",
      "PR",
      "MERGE_EXIT",
      "REMOTE_DELETED",
      "CLEANED",
      "DONE",
    ]);
    expect(fx.markers(b).at(-1)).toMatch(new RegExp(`^DONE job=${b} pr=2 at=2026-`));
    const lineIndex = (id: string, prefix: string) =>
      fx.markers(id).findIndex((l) => l.startsWith(prefix));
    expect(lineIndex(b, "STARTED")).toBeGreaterThan(-1);
    expect(Date.parse(readJob(fx.root, a)?.ended_at ?? "")).toBeLessThan(
      Date.parse(fx.markers(b)[lineIndex(b, "STARTED")]?.split("at=")[1] ?? ""),
    );
    const mainLog = sh(fx.remoteDir, ["log", "--format=%s", "main"]).split("\n");
    expect(mainLog).toEqual(["ship feat/2-beta (#2)", "ship feat/1-alpha (#1)", "init"]);
    const afterA = sh(fx.remoteDir, ["rev-parse", "main~1"]);
    expect(readJob(fx.root, b)?.rebased_onto).toBe(afterA);
    expect(fx.markers(b)).toContain(
      `CLEANED worktree=${wtB} branch=feat/2-beta worktree_state=removed branch_state=deleted remote_state=deleted`,
    );
    expect(NodeFS.existsSync(wtA) || NodeFS.existsSync(wtB)).toBe(false);
    expect(sh(fx.primary, ["branch", "--list", "feat/*"])).toBe("");
    expect(sh(fx.remoteDir, ["branch", "--list", "feat/*"])).toBe("");
    expect(readJob(fx.root, a)).toMatchObject({
      state: "done",
      pr: 1,
      merge_exit: 0,
      push_exit: 0,
    });
  });

  it("holds a repo whose landing lock another live worker has", async () => {
    const fx = makeFixture();
    const wt = fx.worktree("feat/3-held", { "c.txt": "c\n" });
    const id = await fx.submitOk(wt, "feat/3-held");
    registerWatcher(fx.root, id, SELF);
    expect(tryAcquireRepoLock(fx.root, REPO, PARENT, isProcessAlive)).toBe(true);

    const res = await runDueWork(fx.deps);

    expect(res).toEqual({ ended: [], blocked: [], busyRepos: [REPO] });
    expect(readJob(fx.root, id)?.state).toBe("queued");
  });

  it("fails a conflicting rebase with its files and leaves the worktree clean", async () => {
    const fx = makeFixture();
    const wtA = fx.worktree("feat/4-first", { "README.md": "# first\n" });
    const wtB = fx.worktree("feat/5-second", { "README.md": "# second\n" });
    const a = await fx.submitOk(wtA, "feat/4-first");
    const b = await fx.submitOk(wtB, "feat/5-second");
    registerWatcher(fx.root, a, SELF);
    registerWatcher(fx.root, b, SELF);

    await runDueWork(fx.deps);

    expect(readJob(fx.root, a)?.state).toBe("done");
    expect(readJob(fx.root, b)).toMatchObject({
      state: "failed",
      reason: "rebase_conflict files=README.md",
    });
    expect(fx.markers(b).at(-1)).toBe("FAILED reason=rebase_conflict files=README.md");
    expect(sh(wtB, ["status", "--porcelain"])).toBe("");
    expect(NodeFS.readFileSync(NodePath.join(wtB, "README.md"), "utf8")).toBe("# second\n");
    expect(sh(fx.remoteDir, ["branch", "--list", "feat/5-second"])).toBe("");
  });

  it("waits for a live watcher, prunes dead ones, and fails once the wait runs out", async () => {
    const fx = makeFixture();
    const wt = fx.worktree("feat/6-unwatched", { "d.txt": "d\n" });
    const id = await fx.submitOk(wt, "feat/6-unwatched");
    const deadPid = NodeChildProcess.spawnSync("true").pid;
    registerWatcher(fx.root, id, { pid: deadPid, startTicks: null });

    expect((await runDueWork(fx.deps)).blocked).toEqual([id]);
    expect(fx.markers(id).at(-1)).toBe(`WAITING_WATCHER job=${id} (up to 60s)`);
    expect(NodeFS.readdirSync(NodePath.join(fx.root, "jobs", id, "watchers"))).toEqual([]);
    expect((await runDueWork(fx.deps)).blocked).toEqual([id]);

    fx.clock.advance(61);
    expect((await runDueWork(fx.deps)).ended).toEqual([id]);
    expect(readJob(fx.root, id)).toMatchObject({ state: "failed", reason: "no_watcher" });
    expect(fx.markers(id).filter((l) => l.startsWith("WAITING_WATCHER"))).toHaveLength(1);
  });

  it("cancels a queued job now and a held running job at its next phase", async () => {
    const fx = makeFixture();
    const wtA = fx.worktree("feat/7-queued", { "e.txt": "e\n" });
    const a = await fx.submitOk(wtA, "feat/7-queued");
    expect(cancelJob(fx.deps, a)).toEqual({ ok: true, message: `job ${a}: cancelled` });
    expect(fx.markers(a).at(-1)).toBe("FAILED reason=cancelled");
    expect(cancelJob(fx.deps, a).ok).toBe(false);

    const wtB = fx.worktree("feat/8-running", { "f.txt": "f\n" });
    const b = await fx.submitOk(wtB, "feat/8-running");
    registerWatcher(fx.root, b, SELF);
    tryAcquireRepoLock(fx.root, REPO, PARENT, isProcessAlive);
    // A live worker holds the repo: even a queued job is the worker's to end.
    expect(cancelJob(fx.deps, b).message).toBe(
      `job ${b}: cancel requested; it stops at its next phase`,
    );
    expect(readJob(fx.root, b)?.state).toBe("queued");
    NodeFS.writeFileSync(
      NodePath.join(fx.root, "jobs", b, "job.json"),
      JSON.stringify({ ...readJob(fx.root, b), state: "running" }),
    );
    expect(cancelJob(fx.deps, b).message).toBe(
      `job ${b}: cancel requested; it stops at its next phase`,
    );
    expect(readJob(fx.root, b)?.state).toBe("running");
    NodeFS.rmSync(NodePath.join(fx.root, "repos", "acme-fixture_sample-repo", "landing.lock"));

    await runDueWork(fx.deps);

    expect(readJob(fx.root, b)).toMatchObject({ state: "failed", reason: "cancelled" });
    expect(fx.forge.prs.size).toBe(0);
  });

  it("recovers a job whose worker died after the merge to DONE, without a second rebase or merge", async () => {
    const fx = makeFixture();
    const wt = fx.worktree("feat/18-crash", { "o.txt": "o\n" });
    const id = await fx.submitOk(wt, "feat/18-crash");
    const unwatch = registerWatcher(fx.root, id, SELF);
    const dying: ProcessRunner = (input) =>
      input.args.includes("--delete")
        ? Promise.reject(new Error("worker killed"))
        : nodeProcessRunner(input);

    await expect(runJob({ ...fx.deps, run: dying }, id)).rejects.toThrow("worker killed");
    expect(readJob(fx.root, id)).toMatchObject({ state: "running", pr: 1, merge_exit: 0 });
    expect(fx.forge.merged).toEqual([1]);
    expect(cancelJob(fx.deps, id)).toEqual({
      ok: false,
      message: `job ${id} is merged; it finishes its cleanup and cannot cancel`,
    });

    // The earlier crash point: `gh pr merge` returned but merge_exit never reached the record.
    const { merge_exit: _dropped, ...unrecorded } = readJob(fx.root, id) ?? {};
    NodeFS.writeFileSync(
      NodePath.join(fx.root, "jobs", id, "job.json"),
      JSON.stringify(unrecorded),
    );
    unwatch();
    fx.clock.advance(120);

    expect((await runDueWork(fx.deps)).ended).toEqual([id]);

    expect(readJob(fx.root, id)).toMatchObject({ state: "done", merge_exit: 0, pr: 1 });
    expect(fx.forge.merged).toEqual([1]);
    expect(fx.markers(id).filter((l) => l.startsWith("REBASED"))).toHaveLength(1);
    expect(fx.markers(id).slice(-3)).toEqual([
      "REMOTE_DELETED feat/18-crash",
      `CLEANED worktree=${wt} branch=feat/18-crash worktree_state=removed branch_state=deleted remote_state=deleted`,
      expect.stringMatching(new RegExp(`^DONE job=${id} pr=1 at=`)),
    ]);
    expect(readLog(fx.root, id)).toContain("PR #1 merged before this worker recorded it");
    expect(NodeFS.existsSync(wt)).toBe(false);
    expect(sh(fx.remoteDir, ["branch", "--list", "feat/18-crash"])).toBe("");
  });

  it("pushes with the lease it read once, so a push that races in after it is never overwritten", async () => {
    const fx = makeFixture();
    const wt = fx.worktree("feat/19-raced", { "p.txt": "p\n" });
    const id = await fx.submitOk(wt, "feat/19-raced");
    registerWatcher(fx.root, id, SELF);
    const other = NodePath.join(fx.tmp, "other-lane");
    sh(fx.tmp, ["clone", "-q", fx.remoteDir, other]);
    sh(other, ["config", "user.name", "Other Lane"]);
    sh(other, ["config", "user.email", "other@example.invalid"]);
    const racing: ProcessRunner = (input) => {
      if (input.args.includes("--porcelain") && input.args.includes("push")) {
        NodeFS.writeFileSync(NodePath.join(other, "q.txt"), "theirs\n");
        sh(other, ["add", "q.txt"]);
        sh(other, ["commit", "-q", "-m", "their work"]);
        sh(other, ["push", "-q", "origin", "HEAD:refs/heads/feat/19-raced"]);
      }
      return nodeProcessRunner(input);
    };

    await runDueWork({ ...fx.deps, run: racing });

    expect(readJob(fx.root, id)).toMatchObject({ state: "failed", reason: "push" });
    expect(fx.markers(id)).toContain("PUSH_EXIT=1");
    expect(sh(fx.remoteDir, ["log", "--format=%s", "-1", "feat/19-raced"])).toBe("their work");
    expect(fx.forge.prs.size).toBe(0);
  });

  it("takes over stale and unreadable locks only with its own verified claim", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ship-queue-lock-"));
    cleanups.push(() => NodeFS.rmSync(dir, { recursive: true, force: true }));
    const lock = NodePath.join(dir, "landing.lock");
    const deadPid = NodeChildProcess.spawnSync("true").pid;

    NodeFS.writeFileSync(lock, JSON.stringify({ pid: deadPid, startTicks: "1", token: "old" }));
    expect(claimLock(lock, SELF, isProcessAlive)).toBe(true);
    const claimed = JSON.parse(NodeFS.readFileSync(lock, "utf8")) as { token: string };
    expect(lockHolder(lock)).toEqual(SELF);
    expect(claimed.token).toMatch(/^[0-9a-f-]{36}$/);
    expect(claimLock(lock, PARENT, isProcessAlive)).toBe(false);
    expect(lockHolder(lock)).toEqual(SELF);

    NodeFS.writeFileSync(lock, "not json");
    expect(claimLock(lock, PARENT, isProcessAlive)).toBe(true);
    expect(lockHolder(lock)).toEqual(PARENT);
    expect(NodeFS.readdirSync(dir)).toEqual(["landing.lock"]);
  });

  it("parks a protected diff on ACTION_REQUIRED until the owner's bundle grant lands", async () => {
    let granted = false;
    const fx = makeFixture({ grant: () => ({ ok: granted }) });
    const wt = fx.worktree("feat/9-workflow", { ".github/workflows/ci.yml": "on: push\n" });
    const id = await fx.submitOk(wt, "feat/9-workflow");
    registerWatcher(fx.root, id, SELF);

    expect((await runDueWork(fx.deps)).blocked).toEqual([id]);
    const action = fx.markers(id).at(-1) ?? "";
    expect(action).toMatch(
      new RegExp(
        `^ACTION_REQUIRED job=${id} gates=ci-workflow paths=\\.github/workflows/ci\\.yml digest=[0-9a-f]{64}: `,
      ),
    );
    expect(readJob(fx.root, id)).toMatchObject({ state: "waiting", waiting_for: "action" });
    expect(fx.guardCalls).toEqual([".github/workflows/ci.yml"]);

    const printed: string[] = [];
    const watch = () =>
      watchJob({
        root: fx.root,
        id,
        self: SELF,
        clock: fx.clock,
        quietMs: 300_000,
        write: (l) => printed.push(l),
        waitForChange: async () => {
          await runDueWork(fx.deps);
        },
      });
    expect(await watch()).toBe(WATCH_EXIT.actionRequired);
    expect(printed).toContain(action);

    await runDueWork(fx.deps);
    expect(fx.markers(id).filter((l) => l.startsWith("ACTION_REQUIRED"))).toHaveLength(1);

    granted = true;
    expect(await watch()).toBe(WATCH_EXIT.done);
    expect(readJob(fx.root, id)?.state).toBe("done");
    expect(sh(fx.remoteDir, ["show", "main:.github/workflows/ci.yml"])).toBe("on: push");
  });

  it("fails the house stage on a secret-scan finding before anything is pushed", async () => {
    const fx = makeFixture();
    const deps: ShipQueueDeps = {
      ...fx.deps,
      secretScan: async () => [{ summary: "leaks found: 1" }],
    };
    const wt = fx.worktree("feat/10-leaky", { "g.txt": "g\n" });
    const id = await fx.submitOk(wt, "feat/10-leaky");
    registerWatcher(fx.root, id, SELF);

    await runDueWork(deps);

    expect(readJob(fx.root, id)).toMatchObject({ state: "failed", reason: "house_secret_scan" });
    expect(readLog(fx.root, id)).toContain("  leaks found: 1\n");
    expect(sh(fx.remoteDir, ["branch", "--list", "feat/10-leaky"])).toBe("");
  });

  it("fails the house stage on a hygiene finding before anything is pushed", async () => {
    const fx = makeFixture();
    const seen: string[] = [];
    const deps: ShipQueueDeps = {
      ...fx.deps,
      hygieneScan: async (input) => {
        seen.push(`${input.repo} ${input.title}`);
        return {
          kind: "fail",
          reason: "house_hygiene classes=data-layout",
          log: "data-layout abc123def456:g.txt:1 (public:data-dev-root)",
        };
      },
    };
    const wt = fx.worktree("feat/15-hygiene", { "g.txt": "g\n" });
    const id = await fx.submitOk(wt, "feat/15-hygiene");
    registerWatcher(fx.root, id, SELF);

    await runDueWork(deps);

    expect(seen).toHaveLength(1);
    expect(readJob(fx.root, id)).toMatchObject({
      state: "failed",
      reason: "house_hygiene classes=data-layout",
    });
    expect(readLog(fx.root, id)).toContain(
      "data-layout abc123def456:g.txt:1 (public:data-dev-root)",
    );
    expect(sh(fx.remoteDir, ["branch", "--list", "feat/15-hygiene"])).toBe("");
  });

  it("keeps a worktree that gained uncommitted work during the merge", async () => {
    const fx = makeFixture();
    const wt = fx.worktree("feat/11-dirty", { "h.txt": "h\n" });
    const id = await fx.submitOk(wt, "feat/11-dirty");
    registerWatcher(fx.root, id, SELF);
    fx.forge.onBeforeMerge(() => NodeFS.writeFileSync(NodePath.join(wt, "notes.txt"), "wip\n"));

    await runDueWork(fx.deps);

    expect(fx.markers(id)).toContain(
      `LEFT_DIRTY worktree=${wt} files=1 (work not in the commit; never removed, the lane decides)`,
    );
    expect(fx.markers(id)).toContain(
      `CLEANED worktree=${wt} branch=feat/11-dirty worktree_state=kept-dirty branch_state=kept remote_state=deleted`,
    );
    expect(NodeFS.existsSync(NodePath.join(wt, "notes.txt"))).toBe(true);
    expect(readJob(fx.root, id)?.state).toBe("done");
  });
});

describe("submit gates", () => {
  it("refuses bodies, checkouts, and branches the queue cannot ship", async () => {
    const fx = makeFixture();
    const wt = fx.worktree("feat/12-gates", { "i.txt": "i\n" });
    const refusal = async (body: string, worktree = wt, branch = "feat/12-gates") => {
      const res = await fx.submit(worktree, branch, body);
      return res.ok ? "accepted" : res.reason;
    };
    expect(await refusal("no issue here")).toMatch(/names no issue/);
    expect(await refusal("Closes #8 [no-issue]")).toMatch(/\[no-issue\] is not allowed/);
    expect(await refusal(`Closes #8\n${"x".repeat(65_000)}`)).toMatch(/GitHub allows 65536/);
    expect(await refusal("Closes #8", fx.primary, "main")).toMatch(/is a primary checkout/);
    expect(await refusal("Closes #8", wt, "feat/other")).toMatch(/is not on feat\/other/);
    NodeFS.writeFileSync(NodePath.join(wt, "stray.txt"), "x\n");
    expect(await refusal("Closes #8")).toMatch(/has uncommitted changes/);
    NodeFS.rmSync(NodePath.join(wt, "stray.txt"));

    const id = await fx.submitOk(wt, "feat/12-gates");
    expect(await refusal("Closes #8")).toBe(`${REPO} feat/12-gates is already queued or running`);

    const stacked = fx.worktree("feat/13-stacked", { "j.txt": "j\n" }, "feat/12-gates");
    expect(await refusal("Closes #8", stacked, "feat/13-stacked")).toMatch(
      /carries the unmerged commits of feat\/12-gates/,
    );
    expect(readJob(fx.root, id)).toMatchObject({
      repo: REPO,
      base_branch: "main",
      state: "queued",
    });
  });

  it("asks for a premise after two failures at one gate, and stamps the agent's provenance", async () => {
    const fx = makeFixture();
    const wt = fx.worktree("feat/14-retry", { "k.txt": "k\n" });
    for (const _ of [1, 2]) {
      const id = await fx.submitOk(wt, "feat/14-retry");
      registerWatcher(fx.root, id, SELF);
      await runDueWork({ ...fx.deps, secretScan: async () => [{ summary: "leak" }] });
    }
    expect(await fx.submit(wt, "feat/14-retry")).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/failed with "house_secret_scan"; state the premise/),
    });

    const res = await submitJob(fx.deps, {
      worktree: wt,
      branch: "feat/14-retry",
      title: "retry",
      body: "Closes #8\n\n## Premise\nPremise: p\nTest: t\nResult: r\n",
      identity: {
        session: "00000000-0000-4000-8000-00000000a001",
        thread: "00000000-0000-4000-8000-00000000b002",
      },
    });
    if (!res.ok) throw new Error(res.reason);
    expect(res.warnings).toEqual([]);
    expect(NodeFS.readFileSync(jobBodyPath(fx.root, res.id), "utf8")).toMatch(
      /Result: r\n\nAgent Session: 00000000-0000-4000-8000-00000000a001\nAgent Thread: 00000000-0000-4000-8000-00000000b002\n$/,
    );
    expect(res.record.thread_id).toBe("00000000-0000-4000-8000-00000000b002");
  });

  it("stamps only UUID ids on a public or unknown repo and raw ids on a private one", async () => {
    const identity = { session: "sess-raw-1", thread: "00000000-0000-4000-8000-00000000b002" };
    const submitWith = async (visibility: "private" | "public" | undefined, branch: string) => {
      const fx = makeFixture();
      const wt = fx.worktree(branch, { "v.txt": `${branch}\n` });
      const forge: ShipForge =
        visibility === undefined
          ? fx.deps.forge
          : { ...fx.deps.forge, repoVisibility: async () => visibility };
      const res = await submitJob(
        { ...fx.deps, forge },
        { worktree: wt, branch, title: "t", body: "Closes #8\n", identity },
      );
      if (!res.ok) throw new Error(res.reason);
      return NodeFS.readFileSync(jobBodyPath(fx.root, res.id), "utf8");
    };
    expect(await submitWith("private", "feat/16-private")).toBe(
      `Closes #8\n\nAgent Session: sess-raw-1\nAgent Thread: ${identity.thread}\n`,
    );
    const neutral = `Closes #8\n\nAgent Thread: ${identity.thread}\n`;
    expect(await submitWith("public", "feat/17-public")).toBe(neutral);
    expect(await submitWith(undefined, "feat/18-unknown")).toBe(neutral);
  });
});

describe("watcher", () => {
  it("tails only complete column-0 markers across polls", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ship-queue-tail-"));
    cleanups.push(() => NodeFS.rmSync(dir, { recursive: true, force: true }));
    const log = NodePath.join(dir, "log");
    NodeFS.writeFileSync(log, "QUEUED job=1000 branch=b");
    const tail = new MarkerTail(log);
    expect(tail.poll()).toEqual([]);
    NodeFS.appendFileSync(log, " at=x\n  DONE job=1000 nested\nPR=notanumber\nPR=7\nnoise\n");
    expect(tail.poll()).toEqual(["QUEUED job=1000 branch=b at=x", "PR=7"]);
    expect(tail.poll()).toEqual([]);
  });

  it("reports QUIET once a running job's log stops moving", async () => {
    const fx = makeFixture();
    const wt = fx.worktree("feat/15-quiet", { "l.txt": "l\n" });
    const id = await fx.submitOk(wt, "feat/15-quiet");
    NodeFS.writeFileSync(
      NodePath.join(fx.root, "jobs", id, "job.json"),
      JSON.stringify({ ...readJob(fx.root, id), state: "running" }),
    );
    const printed: string[] = [];
    const code = await watchJob({
      root: fx.root,
      id,
      self: SELF,
      clock: fx.clock,
      quietMs: 120_000,
      write: (l) => printed.push(l),
      waitForChange: async () => fx.clock.advance(60),
    });
    expect(code).toBe(WATCH_EXIT.quiet);
    expect(printed.at(-1)).toMatch(
      new RegExp(`^QUIET job=${id} at=.*: no log of the job has moved in 12\\ds`),
    );
    expect(fx.markers(id).at(-1)).toBe(printed.at(-1));
    expect(NodeFS.readdirSync(NodePath.join(fx.root, "jobs", id, "watchers"))).toEqual([]);
  });
});

describe("ship-queue CLI", () => {
  it("submits, watches to DONE, reports status, and refuses a cancel of an ended job", async () => {
    const fx = makeFixture();
    const wt = fx.worktree("feat/16-cli", { "m.txt": "m\n" });
    const bodyFile = NodePath.join(fx.tmp, "body.md");
    NodeFS.writeFileSync(bodyFile, "Adds m.\n\nCloses #16\n");
    const out: string[] = [];
    const err: string[] = [];
    let started = 0;
    const cli = (argv: ReadonlyArray<string>) =>
      runShipQueueCli(argv, {
        deps: fx.deps,
        io: { stdout: (t) => out.push(t), stderr: (t) => err.push(t), env: {}, cwd: fx.tmp },
        startWorker: () => {
          started += 1;
          return "worker=fixture";
        },
        waitForChange: () => async () => {
          await runDueWork(fx.deps);
        },
      });

    expect(await cli(["submit", wt, "feat/16-cli", "Add m", "body.md"])).toBe(0);
    const id = /^job=(\d+) log=(.*)$/m.exec(out.join(""))?.[1] ?? "";
    expect(out.join("")).toContain(`job=${id} log=${jobLogPath(fx.root, id)}\n`);
    expect(out.join("")).toContain(`ship-queue watch ${id}`);
    expect(started).toBe(1);
    expect(err.join("")).toMatch(/warning: the PR carries no agent stamp/);

    out.length = 0;
    expect(await cli(["watch", id])).toBe(0);
    expect(started).toBeGreaterThan(1);
    expect(err.join("")).toContain(`ship-queue: job ${id} has no live worker; worker=fixture`);
    const watched = out.join("").trim().split("\n");
    expect(watched[0]).toMatch(new RegExp(`^QUEUED job=${id} branch=feat/16-cli`));
    expect(watched).toContain("PR=1");
    expect(watched.at(-1)).toMatch(new RegExp(`^DONE job=${id} pr=1 at=`));

    out.length = 0;
    expect(await cli(["status", "--json"])).toBe(0);
    const status = JSON.parse(out.join("")) as {
      queue_root: string;
      jobs: Array<Record<string, unknown>>;
    };
    expect(status.queue_root).toBe(fx.root);
    expect(status.jobs).toHaveLength(1);
    expect(status.jobs[0]).toMatchObject({
      id,
      repo: REPO,
      branch: "feat/16-cli",
      state: "done",
      pr: 1,
      stage: "post-merge",
      last_marker: watched.at(-1),
    });

    out.length = 0;
    expect(await cli(["status"])).toBe(0);
    expect(out.join("")).toBe(`${id} done feat/16-cli :: ${watched.at(-1)}\n`);
    expect(await cli(["cancel", id])).toBe(1);
    expect(err.join("")).toContain(`job ${id} already ended (done)`);
    expect(await cli(["watch", "99999"])).toBe(64);
  });

  it("cancels a queued job and refuses a submit without an issue", async () => {
    const fx = makeFixture();
    const wt = fx.worktree("feat/17-cancel", { "n.txt": "n\n" });
    NodeFS.writeFileSync(NodePath.join(fx.tmp, "ok.md"), "Closes #17\n");
    NodeFS.writeFileSync(NodePath.join(fx.tmp, "bad.md"), "nothing\n");
    const out: string[] = [];
    const err: string[] = [];
    const cli = (argv: ReadonlyArray<string>) =>
      runShipQueueCli(argv, {
        deps: fx.deps,
        io: { stdout: (t) => out.push(t), stderr: (t) => err.push(t), env: {}, cwd: fx.tmp },
      });
    expect(await cli(["submit", wt, "feat/17-cancel", "t", "bad.md", "--no-start"])).toBe(1);
    expect(err.join("")).toMatch(/^ship-queue: refused: body names no issue/);
    expect(await cli(["submit", wt, "feat/17-cancel", "t", "ok.md", "--no-start"])).toBe(0);
    const id = /^job=(\d+)/m.exec(out.join(""))?.[1] ?? "";
    expect(await cli(["cancel", id])).toBe(0);
    expect(readJob(fx.root, id)).toMatchObject({ state: "failed", reason: "cancelled" });
    expect(NodeFS.existsSync(NodePath.join(fx.root, "jobs", "open", id))).toBe(false);
  });

  it("runs advisory declarationChallenge, posts review comment once per tip, and prints REVIEW in watch", async () => {
    const fx = makeFixture();
    const wt = fx.worktree("feat/18-challenge", { "c.txt": "c\n" });
    const comments: Array<{ number: number; body: string }> = [];
    const deps: ShipQueueDeps = {
      ...fx.deps,
      forge: {
        ...fx.deps.forge,
        commentOnPullRequest: async ({ number, body }) => {
          comments.push({ number, body });
        },
      },
      declarationChallenge: async ({ outFile }) => {
        const report = "PLAYBOOK REVIEW: PASS\nSummary:\n  Looks good with ```code``` fence\n";
        NodeFS.writeFileSync(outFile, report, "utf8");
        return { output: "house declaration-challenge: passed", report };
      },
    };
    const submitted = await submitJob(deps, {
      worktree: wt,
      branch: "feat/18-challenge",
      title: "feat: challenge",
      body: "Closes #18\n",
      identity: {},
    });
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) throw new Error(submitted.reason);
    const unregister = registerWatcher(fx.root, submitted.id, SELF);
    try {
      expect(await runJob(deps, submitted.id)).toBe("ended");
    } finally {
      unregister();
    }
    const job = readJob(fx.root, submitted.id)!;
    expect(job.state).toBe("done");
    expect(NodeFS.readFileSync(jobReviewPath(fx.root, submitted.id), "utf8")).toContain(
      "PLAYBOOK REVIEW: PASS",
    );
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body).toContain("````text");
    expect(comments[0]!.body).toContain("PLAYBOOK REVIEW: PASS");

    // Re-calling postReviewComment for the same tip is a no-op.
    await postReviewComment(deps, job, job.pr!, job.pushed_sha!);
    expect(comments).toHaveLength(1);
    expect(formatReviewComment("abcdef1234567890", "1000", "```x```")).toContain("````text");

    // Secret-flagged review output is withheld from PR comments.
    const secretComments: string[] = [];
    const secretDeps: ShipQueueDeps = {
      ...deps,
      run: async (input) =>
        input.command === "gitleaks"
          ? { exitCode: 1, stdout: "", stderr: "secret found" }
          : deps.run(input),
      forge: {
        ...deps.forge,
        commentOnPullRequest: async ({ body }) => {
          secretComments.push(body);
        },
      },
    };
    await postReviewComment(secretDeps, job, job.pr!, "deadbeefdeadbeef");
    expect(secretComments).toHaveLength(0);
    expect(readLog(fx.root, submitted.id)).toContain("withheld from PR #");

    const watched: string[] = [];
    const exitCode = await watchJob({
      root: fx.root,
      id: submitted.id,
      self: SELF,
      clock: fx.clock,
      quietMs: 60_000,
      write: (line) => watched.push(line),
      waitForChange: async () => {},
    });
    expect(exitCode).toBe(WATCH_EXIT.done);
    expect(watched.join("\n")).toContain(`REVIEW job=${submitted.id}`);
    expect(watched.join("\n")).toContain("PLAYBOOK REVIEW: PASS");
    expect(watched.join("\n")).toContain("AGENT: quote this review");
  });
});
