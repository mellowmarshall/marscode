// @effect-diagnostics nodeBuiltinImport:off - End to end without the live app: real broker on a temp socket, driven by the real host-guards hook/shim entry, the real marscode-guard CLI, and the real ship-queue guard client.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { canonicalProtectedDiffSha256 } from "@t3tools/guard-protocol/digests";
import { runGuardCli } from "@t3tools/guard-protocol/cli";
import { bindGuardJob, identifyGuardThread } from "@t3tools/guard-protocol/client";
import { runHostGuardCli } from "@t3tools/host-guards/cli";
import { makeGuardProtocolGuard, protectedDiffDigest } from "@t3tools/ship-queue/houseGate";
import { runShipQueueCli } from "@t3tools/ship-queue/cli";
import { createJob, readJob } from "@t3tools/ship-queue/jobStore";
import type { ShipForge } from "@t3tools/ship-queue/types";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { GuardGrantBroker, type GuardThreadNotice } from "./GuardGrantBroker.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).toReversed()) await fn();
});

function tempDir(prefix: string): string {
  const dir = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix)));
  NodeFS.chmodSync(dir, 0o700);
  cleanups.push(() => NodeFS.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function setProcessEnv(vars: Record<string, string>): void {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  cleanups.push(() => {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

function git(cwd: string, args: ReadonlyArray<string>): void {
  const res = NodeChildProcess.spawnSync(
    "git",
    ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args],
    {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.invalid",
        GIT_COMMITTER_NAME: "Fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      },
    },
  );
  if (res.status !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr}`);
}

const unusedForge: ShipForge = {
  repoVisibility: async () => "private",
  findOpenPullRequest: async () => null,
  createPullRequest: async () => {
    throw new Error("not used");
  },
  isPullRequestMerged: async () => false,
  mergePullRequest: async () => ({ exitCode: 1, message: "not used" }),
};

describe("owner approval flows against a real broker", () => {
  it("one plan approval covers listed gh commands via the real CLI, hook, and shim; the hook env plan asks once and wakes the thread", async () => {
    const dir = tempDir("guard-flow-");
    const socketPath = NodePath.join(dir, "guard.sock");
    const notices: GuardThreadNotice[] = [];
    const pendingWaiters: Array<(id: string) => void> = [];
    const broker = new GuardGrantBroker({
      socketPath,
      signingStateDir: dir,
      resolvePeerThreadId: async () => ({ verified: true, threadId: "thread-a", peerPid: 4300 }),
      notifyThread: (n) => notices.push(n),
    });
    broker.subscribe((ev) => {
      if (ev.type === "pending_added")
        for (const w of pendingWaiters.splice(0)) w(ev.request.requestId);
    });
    await broker.start("linux");
    cleanups.push(() => broker.close());
    const nextPending = () => new Promise<string>((resolve) => pendingWaiters.push(resolve));

    const configPath = NodePath.join(dir, "host-guards.json");
    NodeFS.writeFileSync(
      configPath,
      JSON.stringify({
        orgs: ["example-org"],
        sourceRoot: NodePath.join(dir, "src"),
        dataRoot: NodePath.join(dir, "data"),
        stateDir: NodePath.join(dir, "state"),
        queueRoot: NodePath.join(dir, "queue"),
        realGh: "/bin/false",
      }),
    );
    const work = NodePath.join(dir, "work");
    NodeFS.mkdirSync(work);
    const agentEnv = { T3CODE_THREAD_ID: "thread-a", PATH: process.env.PATH ?? "" };
    const errors: string[] = [];
    const hostGuard = (argv: ReadonlyArray<string>, env: NodeJS.ProcessEnv, stdin?: string) =>
      runHostGuardCli(argv, {
        cwd: work,
        env,
        ...(stdin === undefined ? {} : { stdin }),
        configPath,
        socketPath,
        allowTestOverride: true,
        allowEnvThreadId: true,
        testMode: true,
        out: () => {},
        err: (t) => errors.push(t),
      });
    const hook = (command: string, env: NodeJS.ProcessEnv = agentEnv) =>
      hostGuard(
        ["hook"],
        env,
        JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: work }),
      );
    const shim = (args: ReadonlyArray<string>, env: NodeJS.ProcessEnv = agentEnv) =>
      hostGuard(["gh-check", "--cwd", work, ...args], env);

    // 1. `marscode-guard override --plan`: one modal for two owner-only commands.
    const edit = ["repo", "edit", "example-org/example-repo", "--description", "new words"];
    const rename = ["repo", "rename", "example-repo-next", "-R", "example-org/example-repo"];
    const planFile = NodePath.join(dir, "plan.json");
    NodeFS.writeFileSync(
      planFile,
      JSON.stringify({
        reason: "owner asked for a new name and description",
        commands: [
          ["gh", ...edit],
          ["gh", ...rename],
        ],
      }),
    );
    setProcessEnv({
      HOST_GUARDS_TEST: "1",
      T3_GUARD_GRANT_SOCKET: socketPath,
      T3CODE_THREAD_ID: "thread-a",
    });
    const pending = nextPending();
    const cli = runGuardCli(["override", "--plan", planFile, "--cwd", work], {
      allowTestOverride: true,
    });
    const requestId = await pending;
    expect(broker.listPending().find((r) => r.requestId === requestId)?.plan).toHaveLength(2);
    broker.resolveRequest(requestId, { decision: "approve" });
    expect(await cli).toBe(0);

    // 2. The hook lets the listed command through and the PATH shim consumes it, exactly once.
    expect(await hook(`gh ${edit.join(" ").replace("new words", "'new words'")}`)).toBe(0);
    expect(await shim(edit)).toBe(0);
    expect(await shim(edit)).toBe(2);
    expect(errors.join("\n")).toContain("repo settings change: owner approval required");
    // An unlisted owner-only command is still refused.
    expect(await shim(["repo", "delete", "example-org/example-repo", "--yes"])).toBe(2);
    expect(await shim(rename)).toBe(0);

    // 3. `HOST_GUARD_OVERRIDE_PLAN` on the first refused command: one queued modal, a thread notice.
    const del = ["repo", "delete", "example-org/example-repo", "--yes"];
    const create = ["repo", "create", "example-org/example-repo", "--private"];
    const plan2 = NodePath.join(dir, "plan2.json");
    NodeFS.writeFileSync(
      plan2,
      JSON.stringify({
        reason: "recreate the repo from scratch",
        commands: [
          ["gh", ...del],
          ["gh", ...create],
        ],
      }),
    );
    const queued = nextPending();
    expect(await hook(`HOST_GUARD_OVERRIDE_PLAN=${plan2} gh ${del.join(" ")}`)).toBe(2);
    expect(errors.join("\n")).toContain("plan approval requested in MarsCode for 2 commands");
    broker.resolveRequest(await queued, { decision: "approve" });
    expect(notices).toHaveLength(1);
    expect(notices[0]!.text).toContain("Run each command once");
    expect(notices[0]!.text).toContain("gh repo create example-org/example-repo --private");
    expect(await hook(`gh ${del.join(" ")}`)).toBe(0);
    expect(await shim(del)).toBe(0);
    expect(await shim(create)).toBe(0);
    expect(await shim(create)).toBe(2);
  });

  it("the real ship-queue guard client checks a job-bound grant as a trusted worker", async () => {
    const dir = tempDir("guard-flow-queue-");
    const queueRoot = NodePath.join(dir, "queue");
    const worktree = NodePath.join(dir, "wt");
    NodeFS.mkdirSync(worktree);
    const socketPath = NodePath.join(dir, "guard.sock");
    const peer = { threadId: "thread-q", pid: 9100 };
    const pendingWaiters: Array<(id: string) => void> = [];
    const broker = new GuardGrantBroker({
      socketPath,
      signingStateDir: dir,
      resolvePeerThreadId: async () => ({
        verified: true,
        threadId: peer.threadId,
        peerPid: peer.pid,
      }),
      queueWorkerTrust: { queueRoot, isTrustedWorker: (pid) => pid === 9200 },
    });
    broker.subscribe((ev) => {
      if (ev.type === "pending_added")
        for (const w of pendingWaiters.splice(0)) w(ev.request.requestId);
    });
    await broker.start("linux");
    cleanups.push(() => broker.close());

    const branch = "feat/74-queue";
    const bundle = {
      repo: "example-org/example-repo",
      branch,
      pr_or_issue: "",
      gates: [{ gate_id: "playbook", reason: "playbook.json modified" }],
      protected_paths: ["playbook.json"],
      protected_diff_sha256: canonicalProtectedDiffSha256("diff --git a/playbook.json\n+x"),
      body_sha256: "",
      commit_sha: "c".repeat(40),
    };
    const { id } = createJob(
      queueRoot,
      {
        repo: "example-org/example-repo",
        primary: worktree,
        worktree,
        branch,
        base_branch: "main",
        remote: "origin",
        title: "queue",
        head_sha: "c".repeat(40),
        thread_id: "thread-q",
        action_digest: protectedDiffDigest(bundle),
      },
      "body\n",
      { now: () => "2026-11-27T00:00:00.000Z" },
    );
    const guard = makeGuardProtocolGuard({ socketPath });

    // Owner approves from the requesting thread (as `marscode-guard override ship-queue` asks).
    const pending = new Promise<string>((resolve) => pendingWaiters.push(resolve));
    setProcessEnv({ HOST_GUARDS_TEST: "1", T3_GUARD_GRANT_SOCKET: socketPath });
    const cli = runGuardCli(
      [
        "override",
        "ship-queue",
        "protected diff",
        "--cwd",
        worktree,
        "--",
        "ship-queue",
        "submit",
        worktree,
        branch,
      ],
      { allowTestOverride: true },
    );
    const requestId = await pending;
    peer.pid = 9100;
    const resolved = broker.resolveRequest(requestId, { decision: "approve" });
    expect(resolved.found).toBe(true);
    expect(await cli).toBe(0);

    // Submit binds the job to its verified thread with the broker; the worker check needs it.
    expect((await bindGuardJob({ jobId: id, worktree, branch, socketPath })).threadId).toBe(
      "thread-q",
    );
    // The CLI's inspector found no git worktree, so this approval is a once grant for the command.
    peer.threadId = "";
    peer.pid = 9200;
    const input = { worktree, branch, bundle, jobId: id };
    expect(await guard.check({ ...input, consume: false })).toMatchObject({ ok: true });
    expect(await guard.check({ ...input, consume: false })).toMatchObject({ ok: true });
    expect(await guard.check({ ...input, consume: true })).toMatchObject({ ok: true });
    expect(await guard.check({ ...input, consume: false })).toMatchObject({ ok: false });

    peer.pid = 9300;
    expect(await guard.check({ ...input, consume: false })).toMatchObject({
      ok: false,
      reason: "caller is not a trusted ship-queue worker",
    });
  });

  it("ship-queue submit binds the job to the broker-verified thread, not the thread its environment claims", async () => {
    const dir = tempDir("guard-flow-submit-");
    const socketPath = NodePath.join(dir, "guard.sock");
    const broker = new GuardGrantBroker({
      socketPath,
      signingStateDir: dir,
      resolvePeerThreadId: async () => ({
        verified: true,
        threadId: "thread-verified",
        peerPid: 4400,
      }),
    });
    await broker.start("linux");
    cleanups.push(() => broker.close());

    const remote = NodePath.join(dir, "remotes", "example-org", "example-repo.git");
    NodeFS.mkdirSync(remote, { recursive: true });
    git(remote, ["init", "-q", "--bare", "-b", "main"]);
    const primary = NodePath.join(dir, "example-repo");
    git(dir, ["clone", "-q", remote, primary]);
    NodeFS.writeFileSync(NodePath.join(primary, "README.md"), "# example\n");
    git(primary, ["add", "README.md"]);
    git(primary, ["commit", "-q", "-m", "init"]);
    git(primary, ["push", "-q", "origin", "HEAD:refs/heads/main"]);
    git(primary, ["remote", "set-head", "origin", "main"]);
    NodeFS.writeFileSync(NodePath.join(dir, "body.md"), "Changes CI.\n\nCloses #74\n");

    const submit = async (branch: string, identifyThread: () => Promise<string>) => {
      const wt = NodePath.join(dir, branch.replace(/\//g, "-"));
      git(primary, ["worktree", "add", "-q", "-b", branch, wt, "origin/main"]);
      NodeFS.mkdirSync(NodePath.join(wt, ".github", "workflows"), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(wt, ".github", "workflows", "ci.yml"), "on: push\n");
      git(wt, ["add", "-A"]);
      git(wt, ["commit", "-q", "-m", `work on ${branch}`]);
      const out: string[] = [];
      const code = await runShipQueueCli(["submit", wt, branch, "ci", "body.md", "--no-start"], {
        deps: { root: NodePath.join(dir, "queue"), forge: unusedForge },
        io: {
          stdout: (t) => out.push(t),
          stderr: (t) => out.push(t),
          env: { T3CODE_THREAD_ID: "thread-spoofed" },
          cwd: dir,
        },
        identifyThread,
        bindJob: async (input) => (await bindGuardJob({ ...input, socketPath })).ok,
      });
      expect(code, out.join("")).toBe(0);
      return readJob(NodePath.join(dir, "queue"), /^job=(\d+)/m.exec(out.join(""))?.[1] ?? "");
    };

    const viaBroker = async () => (await identifyGuardThread({ socketPath })).threadId ?? "";
    const verified = await submit("feat/74-verified", viaBroker);
    expect(verified?.thread_id).toBe("thread-verified");
    // Submit bound the job broker-side, so nothing can rebind it to another worktree or branch.
    expect(
      await bindGuardJob({ jobId: verified!.id, worktree: dir, branch: "other", socketPath }),
    ).toMatchObject({ ok: false, error: "job is already bound" });

    // No verifiable thread: the job records none, so the broker refuses any grant for it.
    const unreachable = async () =>
      (await identifyGuardThread({ socketPath: NodePath.join(dir, "missing.sock") })).threadId ??
      "";
    const orphan = await submit("feat/74-orphan", unreachable);
    expect(orphan?.thread_id).toBeUndefined();
  });
});
