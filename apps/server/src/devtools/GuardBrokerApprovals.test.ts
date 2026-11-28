// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Real broker on a temp socket: read-only checks, plan grants, thread notices, and job-bound queue-worker checks.
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { requestGuardGrant, useGuardGrant } from "@t3tools/guard-protocol/client";
import { argvSha256, canonicalProtectedDiffSha256 } from "@t3tools/guard-protocol/digests";
import { parsePlanEntries } from "@t3tools/guard-protocol/plan";
import type { GuardBrokerEvent } from "@t3tools/guard-protocol/protocol";
import { makeGuardProtocolOwnerApproval } from "@t3tools/ship-queue/depsRollback";
import { protectedDiffDigest } from "@t3tools/ship-queue/houseGate";
import { createJob } from "@t3tools/ship-queue/jobStore";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { GuardGrantBroker, type GuardThreadNotice } from "./GuardGrantBroker.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const fn of cleanups.splice(0).toReversed()) await fn();
});

function tempDir(prefix: string): string {
  const dir = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix)));
  NodeFS.chmodSync(dir, 0o700);
  cleanups.push(() => NodeFS.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function rpc(
  socketPath: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const conn = NodeNet.createConnection({ path: socketPath });
    let buf = "";
    conn.on("error", reject);
    conn.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl !== -1) {
        conn.end();
        resolve(JSON.parse(buf.slice(0, nl)) as Record<string, unknown>);
      }
    });
    conn.once("connect", () => conn.write(`${JSON.stringify(payload)}\n`));
  });
}

/** The `ship-queue submit` process the tests treat as verified. */
const SUBMIT_PID = 5000;
/** Job freshness is checked against Date, so job tests pin it to one epoch. */
const FIXED_NOW = Date.parse("2026-11-27T12:00:00.000Z");
const nowClock = { now: () => new Date(FIXED_NOW).toISOString() };
function freezeDate(): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FIXED_NOW);
}

interface Peer {
  threadId: string;
  pid: number;
}

async function startBroker(options?: {
  readonly queueRoot?: string;
  readonly trustedPids?: ReadonlySet<number>;
  readonly maxPreapproved?: number;
}) {
  const dir = tempDir("guard-approvals-");
  const socketPath = NodePath.join(dir, "guard.sock");
  const peer: Peer = { threadId: "thread-a", pid: 5000 };
  const notices: GuardThreadNotice[] = [];
  const pendingWaiters: Array<(id: string) => void> = [];
  const broker = new GuardGrantBroker({
    socketPath,
    signingStateDir: dir,
    resolvePeerThreadId: async () => ({
      verified: true,
      threadId: peer.threadId,
      peerPid: peer.pid,
    }),
    queueWorkerTrust: {
      queueRoot: options?.queueRoot ?? NodePath.join(dir, "queue"),
      isTrustedWorker: (pid) => options?.trustedPids?.has(pid) === true,
      isTrustedSubmitter: (pid) => pid === SUBMIT_PID,
    },
    notifyThread: (notice) => notices.push(notice),
    ...(options?.maxPreapproved ? { maxPreapproved: options.maxPreapproved } : {}),
  });
  broker.subscribe((ev: GuardBrokerEvent) => {
    if (ev.type === "pending_added")
      for (const w of pendingWaiters.splice(0)) w(ev.request.requestId);
  });
  await broker.start("linux");
  cleanups.push(() => broker.close());
  const nextPending = () => new Promise<string>((resolve) => pendingWaiters.push(resolve));
  return { broker, socketPath, dir, peer, notices, nextPending };
}

describe("GuardGrantBroker owner approvals", () => {
  it("never consumes a grant on check or peek; only use does (v1 check stays single-use)", async () => {
    const { broker, socketPath, dir } = await startBroker();
    const command = ["git", "push", "--force-with-lease"];
    const q = (op: string, v = 2) =>
      rpc(socketPath, { v, op, guard: "git", command, cwd: dir, thread_id: "thread-a" });

    expect(broker.preapprove({ guard: "git", command, cwd: dir, threadId: "thread-a" }).ok).toBe(
      true,
    );
    expect((await q("peek")).ok).toBe(true);
    expect((await q("check")).ok).toBe(true);
    expect((await q("check")).ok).toBe(true);
    const used = await q("use");
    expect(used.ok).toBe(true);
    expect(used.grant_id).toMatch(/^t3g_/);
    expect((await q("check")).ok).toBe(false);
    expect((await q("use")).ok).toBe(false);

    expect(broker.preapprove({ guard: "git", command, cwd: dir, threadId: "thread-a" }).ok).toBe(
      true,
    );
    expect((await q("check", 1)).ok).toBe(true);
    expect((await q("check", 2)).ok).toBe(false);
  });

  it("approves a plan once; each listed command is usable once, in the same thread and cwd, until it expires", async () => {
    const { broker, socketPath, dir, peer, notices, nextPending } = await startBroker();
    const otherDir = tempDir("guard-approvals-other-");
    const plan = [
      ["gh", "repo", "rename", "example-repo-next", "-R", "example-org/example-repo"],
      ["gh", "api", "-X", "PATCH", "repos/example-org/example-repo-next", "-f", "has_wiki=false"],
    ];
    const pending = nextPending();
    const reply = rpc(socketPath, {
      v: 2,
      op: "request",
      guard: "plan",
      command: plan[0],
      plan,
      cwd: dir,
      proposed_reason: "rename the repo and turn off its wiki",
      refusal: "repo settings change: owner approval required",
    });
    const requestId = await pending;
    const listed = broker.listPending().find((r) => r.requestId === requestId);
    expect(listed?.plan).toEqual(
      plan.map((command) => ({ guard: "gh", command, argvSha256: argvSha256(command) })),
    );
    expect(listed?.bundleEligible).toBe(false);
    expect(broker.resolveRequest(requestId, { decision: "approve" }).found).toBe(true);
    const approved = await reply;
    expect(approved).toMatchObject({ ok: true, scope: "once", stored: true });
    // The waiting caller saw the decision, so no thread notice is sent.
    expect(notices).toEqual([]);

    const use = (command: ReadonlyArray<string>, cwd = dir, guard = "gh") =>
      rpc(socketPath, { v: 2, op: "use", guard, command, cwd });
    expect((await use(plan[0]!, otherDir)).ok).toBe(false);
    // Probe: an entry lifts only the guard it was approved for.
    expect((await use(plan[0]!, dir, "git")).ok).toBe(false);
    expect((await use(plan[0]!, dir, "ship-queue")).ok).toBe(false);
    peer.threadId = "thread-b";
    expect((await use(plan[0]!)).ok).toBe(false);
    peer.threadId = "thread-a";
    expect((await use(["gh", "repo", "delete", "example-org/example-repo"])).ok).toBe(false);
    const first = await use(plan[0]!);
    expect(first).toMatchObject({ ok: true, reason: "rename the repo and turn off its wiki" });
    expect((await use(plan[0]!)).ok).toBe(false);

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 31 * 60 * 1000);
    expect((await use(plan[1]!)).ok).toBe(false);
  });

  it("refuses plans that would stand in for bundle-gated guards, and counts plan entries against the grant cap", async () => {
    const { broker, socketPath, dir, nextPending } = await startBroker({ maxPreapproved: 2 });
    const submitCmd = ["ship-queue", "submit", dir, "feat/x"];
    const ask = (plan: unknown, command: ReadonlyArray<string>) =>
      rpc(socketPath, {
        v: 2,
        op: "request",
        wait: false,
        guard: "plan",
        command,
        plan,
        cwd: dir,
        proposed_reason: "ship it without the diff approval",
        refusal: "x",
      });
    expect(await ask([submitCmd], submitCmd)).toMatchObject({ ok: false });
    expect(await ask([{ guard: "ship-queue", command: submitCmd }], submitCmd)).toMatchObject({
      ok: false,
      error: "a plan cannot approve ship-queue; it needs its own approval",
    });
    expect(
      await ask([{ guard: "playbook", command: ["playbook", "check"] }], ["playbook", "check"]),
    ).toMatchObject({
      ok: false,
    });

    const three = [
      ["gh", "repo", "edit", "example-org/example-repo", "-d", "a"],
      ["gh", "repo", "edit", "example-org/example-repo", "-d", "b"],
      ["gh", "repo", "edit", "example-org/example-repo", "-d", "c"],
    ];
    const pending = nextPending();
    expect(await ask(three, three[0]!)).toMatchObject({ ok: true, queued: true });
    broker.resolveRequest(await pending, { decision: "approve" });
    expect(
      (await rpc(socketPath, { v: 2, op: "check", guard: "gh", command: three[0], cwd: dir })).ok,
    ).toBe(false);
  });

  it("tells the requesting thread when the owner approves or denies and nobody is waiting", async () => {
    const { broker, socketPath, dir, notices, nextPending } = await startBroker();
    const ask = async (command: ReadonlyArray<string>) => {
      const pending = nextPending();
      const queued = await rpc(socketPath, {
        v: 2,
        op: "request",
        wait: false,
        store_grant: true,
        guard: "gh",
        command,
        cwd: dir,
        proposed_reason: "owner wants the repo renamed",
        refusal: "repo settings change",
      });
      expect(queued).toMatchObject({ ok: true, queued: true });
      return pending;
    };

    const renameCmd = ["gh", "repo", "rename", "next", "-R", "example-org/example-repo"];
    broker.resolveRequest(await ask(renameCmd), { decision: "approve" });
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ threadId: "thread-a", decision: "approved" });
    expect(notices[0]!.text).toContain("Re-run once now");
    expect(notices[0]!.text).toContain("gh repo rename next -R example-org/example-repo");
    expect(
      (await rpc(socketPath, { v: 2, op: "use", guard: "gh", command: renameCmd, cwd: dir })).ok,
    ).toBe(true);

    const deleteCmd = ["gh", "repo", "delete", "example-org/example-repo"];
    broker.resolveRequest(await ask(deleteCmd), { decision: "deny", reason: "not this repo" });
    expect(notices[1]).toMatchObject({ threadId: "thread-a", decision: "denied" });
    expect(notices[1]!.text).toContain("not this repo");
    expect(
      (await rpc(socketPath, { v: 2, op: "use", guard: "gh", command: deleteCmd, cwd: dir })).ok,
    ).toBe(false);
  });

  it("lets a trusted queue worker check grants only for its job's thread, worktree, branch, and digest", async () => {
    freezeDate();
    const queueRoot = tempDir("guard-approvals-queue-");
    const worktree = tempDir("guard-approvals-wt-");
    const workerPid = 7100;
    const { broker, socketPath, peer, nextPending } = await startBroker({
      queueRoot,
      trustedPids: new Set([workerPid]),
    });
    const branch = "feat/74-guards";
    const bundle = {
      repo: "example-org/example-repo",
      branch,
      pr_or_issue: "",
      gates: [{ gate_id: "playbook", reason: "PLAYBOOK.md modified" }],
      protected_paths: ["PLAYBOOK.md"],
      protected_diff_sha256: canonicalProtectedDiffSha256("diff --git a/PLAYBOOK.md\n+rule"),
      body_sha256: "",
      commit_sha: "b".repeat(40),
    };
    const digest = protectedDiffDigest(bundle);
    const job = (threadId: string, actionDigest = digest) =>
      createJob(
        queueRoot,
        {
          repo: "example-org/example-repo",
          primary: worktree,
          worktree,
          branch,
          base_branch: "main",
          remote: "origin",
          title: "guards",
          head_sha: "b".repeat(40),
          thread_id: threadId,
          action_digest: actionDigest,
        },
        "body\n",
        nowClock,
      ).id;
    const command = ["ship-queue", "submit", worktree, branch];
    // What `ship-queue submit` does after creating the job: bind it as the verified submitter.
    const bindAs = async (threadId: string, jobId: string, at = worktree, pid = SUBMIT_PID) => {
      const saved = { ...peer };
      Object.assign(peer, { threadId, pid });
      const reply = await rpc(socketPath, { v: 2, op: "bind_job", job_id: jobId, cwd: at, branch });
      Object.assign(peer, saved);
      return reply;
    };
    const boundJob = async (threadId: string, actionDigest = digest) => {
      const id = job(threadId, actionDigest);
      expect((await bindAs(threadId, id)).ok).toBe(true);
      return id;
    };

    // The owner approves the bundle for the requesting thread.
    peer.threadId = "thread-q";
    const pending = nextPending();
    const approval = rpc(socketPath, {
      v: 2,
      op: "request",
      guard: "ship-queue",
      command,
      cwd: worktree,
      bundle,
      refusal: "protected diff",
    });
    const resolved = broker.resolveRequest(await pending, { decision: "approve", scope: "bundle" });
    expect(await resolved.persisted).toBe(true);
    expect((await approval).scope).toBe("bundle");

    // The detached worker has no thread in its process tree.
    peer.threadId = "";
    peer.pid = workerPid;
    const check = (jobId: string, op = "check", extra: Record<string, unknown> = {}) =>
      rpc(socketPath, {
        v: 2,
        op,
        guard: "ship-queue",
        command,
        cwd: worktree,
        bundle,
        job_id: jobId,
        ...extra,
      });

    const good = await boundJob("thread-q");
    expect(await check(good)).toMatchObject({ ok: true, scope: "bundle", thread_id: "thread-q" });
    expect(await check(good, "use")).toMatchObject({ ok: true, scope: "bundle" });
    expect(
      (
        await rpc(socketPath, {
          v: 2,
          op: "check",
          guard: "ship-queue",
          command,
          cwd: worktree,
          bundle,
        })
      ).ok,
    ).toBe(false);

    expect((await check(await boundJob("thread-other"))).ok).toBe(false);
    expect(await check(job("thread-q"))).toMatchObject({
      ok: false,
      error: "job is not bound to a verified thread",
    });
    // Probe: the job file is agent-writable. Bound to thread-other, edited to claim thread-q.
    const edited = await boundJob("thread-other");
    const jobFile = NodePath.join(queueRoot, "jobs", edited, "job.json");
    const record = JSON.parse(NodeFS.readFileSync(jobFile, "utf8")) as Record<string, unknown>;
    NodeFS.writeFileSync(jobFile, JSON.stringify({ ...record, thread_id: "thread-q" }));
    expect((await check(edited)).ok).toBe(false);
    // A binding is first-write-wins: another thread cannot take it over, and no thread cannot bind.
    expect(await bindAs("thread-q", edited)).toMatchObject({
      ok: false,
      error: "job is already bound",
    });
    expect(await bindAs("", job("thread-q"))).toMatchObject({
      ok: false,
      error: "binding a job requires a verified thread",
    });
    // Probes: another thread's agent process pre-binds a fresh job, or a guessed id.
    expect(await bindAs("thread-evil", job("thread-q"), worktree, 6000)).toMatchObject({
      ok: false,
      error: "caller is not this job's ship-queue submit",
    });
    expect(await bindAs("thread-evil", "99999")).toMatchObject({
      ok: false,
      error: "job is not open",
    });
    const stale = createJob(
      queueRoot,
      {
        repo: "example-org/example-repo",
        primary: worktree,
        worktree,
        branch,
        base_branch: "main",
        remote: "origin",
        title: "old",
        head_sha: "b".repeat(40),
      },
      "body\n",
      { now: () => new Date(FIXED_NOW - 5 * 60_000).toISOString() },
    ).id;
    expect(await bindAs("thread-q", stale)).toMatchObject({
      ok: false,
      error: "job was not just submitted",
    });
    expect(await bindAs("thread-q", job("thread-q"), "/home/dev/other")).toMatchObject({
      ok: false,
      error: "bind does not match the job's worktree and branch",
    });
    const moved = await boundJob("thread-q");
    NodeFS.writeFileSync(
      NodePath.join(queueRoot, "jobs", moved, "job.json"),
      JSON.stringify({ ...record, id: moved, thread_id: "thread-q", branch: "feat/other" }),
    );
    expect(await check(moved)).toMatchObject({
      ok: false,
      error: "job record does not match its verified binding",
    });
    expect(await check(await boundJob("thread-q", "0".repeat(64)))).toMatchObject({
      ok: false,
      error: "protected diff digest does not match the job",
    });
    expect(
      await check(good, "check", { command: ["ship-queue", "submit", "/home/dev/other", branch] }),
    ).toMatchObject({
      ok: false,
      error: "grant check does not match the job's worktree and branch",
    });
    // A verified worker opens the owner's window for its own job, in the job's thread. A thread
    // that already holds the approval gets it back and no window opens.
    expect(await check(good, "request", { refusal: "x", wait: false })).toMatchObject({
      ok: true,
      scope: "bundle",
    });
    expect(broker.listPending()).toEqual([]);
    const unapproved = await boundJob("thread-new");
    peer.threadId = "";
    peer.pid = workerPid;
    expect(await check(unapproved, "request", { refusal: "x", wait: false })).toMatchObject({
      ok: true,
      queued: true,
    });
    expect(broker.listPending().map((r) => [r.guard, r.threadId])).toEqual([
      ["ship-queue", "thread-new"],
    ]);
    expect(await check(good, "check", { thread_id: "thread-other" })).toMatchObject({
      ok: false,
      error: "thread_id does not match caller process",
    });
    peer.pid = 7200;
    expect(await check(good)).toMatchObject({
      ok: false,
      error: "caller is not a trusted ship-queue worker",
    });
  });

  it("never evicts job bindings: a flood is refused at the cap and earlier bindings stay", async () => {
    freezeDate();
    const queueRoot = tempDir("guard-approvals-flood-");
    const worktree = tempDir("guard-approvals-flood-wt-");
    const { socketPath, peer } = await startBroker({ queueRoot });
    peer.pid = SUBMIT_PID;
    const newJob = () =>
      createJob(
        queueRoot,
        {
          repo: "example-org/example-repo",
          primary: worktree,
          worktree,
          branch: "feat/flood",
          base_branch: "main",
          remote: "origin",
          title: "flood",
          head_sha: "c".repeat(40),
        },
        "body\n",
        nowClock,
      ).id;
    const bind = (id: string) =>
      rpc(socketPath, { v: 2, op: "bind_job", job_id: id, cwd: worktree, branch: "feat/flood" });
    const first = newJob();
    expect((await bind(first)).ok).toBe(true);
    for (let i = 1; i < 1024; i += 1) expect((await bind(newJob())).ok).toBe(true);
    expect(await bind(newJob())).toMatchObject({ ok: false, error: "too many job bindings" });
    expect(await bind(first)).toMatchObject({ ok: false, error: "job is already bound" });
  });
  it("binds approvals to the exact argv while only the redacted argv crosses the socket", async () => {
    const { broker, socketPath, dir, nextPending } = await startBroker();
    const withSecret = (secret: string, branch = "feat/x") => [
      "git",
      "push",
      `https://bot:${secret}@github.com/example-org/example-repo.git`,
      branch,
    ];
    const common = { cwd: dir, socketPath, threadId: "thread-a" };

    // A plan approval covers the exact argv: the same command with another secret misses.
    const parsed = parsePlanEntries([withSecret("s3cret-one")]);
    if (!parsed.ok) throw new Error(parsed.error);
    let pending = nextPending();
    const planReply = requestGuardGrant({
      ...common,
      guard: "plan",
      command: withSecret("s3cret-one"),
      plan: parsed.entries,
      refusal: "push with a credential",
      proposedReason: "push the release branch once",
    });
    const planId = await pending;
    const shown = JSON.stringify(broker.listPending().find((r) => r.requestId === planId));
    expect(shown).toContain("<redacted>");
    expect(shown).not.toContain("s3cret-one");
    broker.resolveRequest(planId, { decision: "approve" });
    expect((await planReply).ok).toBe(true);
    expect(
      (await useGuardGrant({ ...common, guard: "git", command: withSecret("s3cret-two") })).ok,
    ).toBe(false);
    expect(
      (await useGuardGrant({ ...common, guard: "git", command: withSecret("s3cret-one") })).ok,
    ).toBe(true);

    // The same holds for a stored once grant.
    pending = nextPending();
    const onceReply = requestGuardGrant({
      ...common,
      guard: "git",
      command: withSecret("s3cret-one"),
      refusal: "push with a credential",
      proposedReason: "push it once",
      storeGrant: true,
    });
    broker.resolveRequest(await pending, { decision: "approve" });
    expect((await onceReply).ok).toBe(true);
    expect(
      (await useGuardGrant({ ...common, guard: "git", command: withSecret("s3cret-two") })).ok,
    ).toBe(false);
    expect(
      (await useGuardGrant({ ...common, guard: "git", command: withSecret("s3cret-one") })).ok,
    ).toBe(true);

    // Probe: a hand-made request cannot show one argv and carry another's digest.
    const raw = (command: ReadonlyArray<string>, digest: string) =>
      rpc(socketPath, {
        v: 2,
        op: "request",
        wait: false,
        store_grant: true,
        guard: "git",
        command,
        argv_sha256: digest,
        cwd: dir,
        refusal: "x",
        proposed_reason: "looks harmless",
      });
    expect(
      await raw(["git", "push", "origin", "feat/x"], argvSha256(["git", "push", "origin", "main"])),
    ).toMatchObject({ ok: false, error: "argv_sha256 mismatch" });
    pending = nextPending();
    const shownFeat = [
      "git",
      "push",
      "https://<redacted>@github.com/example-org/example-repo.git",
      "feat/x",
    ];
    expect(await raw(shownFeat, argvSha256(withSecret("s3cret-one", "main")))).toMatchObject({
      ok: true,
      queued: true,
    });
    broker.resolveRequest(await pending, { decision: "approve" });
    expect(
      (await useGuardGrant({ ...common, guard: "git", command: withSecret("s3cret-one", "main") }))
        .ok,
    ).toBe(false);
  });

  it("never lets a once grant satisfy a job-bound worker check", async () => {
    freezeDate();
    const queueRoot = tempDir("guard-approvals-once-");
    const worktree = tempDir("guard-approvals-once-wt-");
    const workerPid = 7300;
    const { broker, socketPath, peer } = await startBroker({
      queueRoot,
      trustedPids: new Set([workerPid]),
    });
    const branch = "feat/once";
    const bundle = {
      repo: "example-org/example-repo",
      branch,
      pr_or_issue: "",
      gates: [{ gate_id: "playbook", reason: "PLAYBOOK.md modified" }],
      protected_paths: ["PLAYBOOK.md"],
      protected_diff_sha256: canonicalProtectedDiffSha256("diff --git a/PLAYBOOK.md\n+rule"),
      body_sha256: "",
      commit_sha: "d".repeat(40),
    };
    const jobId = createJob(
      queueRoot,
      {
        repo: "example-org/example-repo",
        primary: worktree,
        worktree,
        branch,
        base_branch: "main",
        remote: "origin",
        title: "once",
        head_sha: "d".repeat(40),
        action_digest: protectedDiffDigest(bundle),
      },
      "body\n",
      nowClock,
    ).id;
    Object.assign(peer, { threadId: "thread-q", pid: SUBMIT_PID });
    expect(
      (await rpc(socketPath, { v: 2, op: "bind_job", job_id: jobId, cwd: worktree, branch })).ok,
    ).toBe(true);
    const command = ["ship-queue", "submit", worktree, branch];
    expect(
      broker.preapprove({ guard: "ship-queue", command, cwd: worktree, threadId: "thread-q" }).ok,
    ).toBe(true);
    const ask = (extra: Record<string, unknown>) =>
      rpc(socketPath, {
        v: 2,
        op: "check",
        guard: "ship-queue",
        command,
        cwd: worktree,
        bundle,
        ...extra,
      });
    // The submitting thread itself may see the once grant; the job's worker may not.
    expect((await ask({})).ok).toBe(true);
    Object.assign(peer, { threadId: "", pid: workerPid });
    expect((await ask({ job_id: jobId })).ok).toBe(false);
    expect((await ask({ job_id: jobId, op: "use" })).ok).toBe(false);
  });
  it("spends a dependency decision's owner approval instead of only reading it", async () => {
    const { broker, socketPath, dir, nextPending } = await startBroker();
    const approve = makeGuardProtocolOwnerApproval({ socketPath });
    const command = [
      "ship-queue",
      "deps",
      "decide",
      "example-org/example-repo:1",
      "approve",
      "f".repeat(64),
    ];
    const input = {
      action: "decide" as const,
      reportId: "example-org/example-repo:1",
      repo: "example-org/example-repo",
      decision: "approve" as const,
      reportDigest: "f".repeat(64),
      command,
      cwd: dir,
      reason: "the owner approved this update",
      threadId: "thread-a",
    };
    expect(
      broker.preapprove({ guard: "owner-check", command, cwd: dir, threadId: "thread-a" }).ok,
    ).toBe(true);
    expect(await approve(input)).toMatchObject({ ok: true });
    // The grant is spent: a second decision has to ask the owner again.
    const pending = nextPending();
    const second = approve(input);
    broker.resolveRequest(await pending, { decision: "deny", reason: "already decided" });
    expect((await second).ok).toBe(false);
  });
});
