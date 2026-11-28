// @effect-diagnostics nodeBuiltinImport:off - Real behavioral tests for SQLite deps store, pre-approval validation, idempotency, and pins.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { decideShipQueueDeps, listShipQueueDeps } from "./depsEngine.ts";
import { applyPinLimits, buildPinPackageRules, reconcileDeclaredPins } from "./depsRenovate.ts";
import { computeReportDigest, resolveRegisteredRepoPrimary } from "./depsRepoFiles.ts";
import { rollbackShipQueueDepsAttempt, type OwnerApprovalInput } from "./depsRollback.ts";
import { evaluateDepsGate, scanDueDepsRepos, scanShipQueueDepsRepo } from "./depsScan.ts";
import { SqliteDepsStore } from "./depsStore.ts";
import type { DepReportRecord } from "./depsTypes.ts";
import { writeRegistration } from "./jobStore.ts";
import { nodeProcessRunner } from "./nodeProcess.ts";
import {
  buildRenovateCustomManagers,
  computePinDigests,
  extractCurrentPinValue,
  extractPinVersions,
  loadPinsSpec,
} from "./pins.ts";

const tempDirs: string[] = [];

function mkTempDir(prefix: string): string {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
});

describe("SQLite dependency store, legacy import, and HMAC clearances", () => {
  it("imports legacy dependencies/<repo>/state.json into SQLite and verifies HMAC-signed clearances", () => {
    const queueRoot = mkTempDir("sq-deps-store-");
    const fixedNow = 1_700_000_000;
    const legacyDir = NodePath.join(queueRoot, "dependencies", "demo");
    NodeFS.mkdirSync(legacyDir, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(legacyDir, "state.json"),
      JSON.stringify({
        repo: "demo",
        holding: true,
        holdingSince: fixedNow - 100,
        report: {
          id: "demo:legacy1",
          created: fixedNow - 50,
          status: "clean",
          files: { "package.json": "abc" },
          updates: [],
        },
      }),
    );

    const store = new SqliteDepsStore(queueRoot);
    try {
      store.importLegacyJsonIfNeeded(fixedNow);
      const state = store.getRepoState("demo");
      expect(state?.holding).toBe(true);
      expect(state?.report?.id).toBe("demo:legacy1");

      store.saveClearance({
        jobId: "job-1",
        repo: "demo",
        worktree: "/tmp/wt",
        head: "a".repeat(40),
        files: { "package.json": "abc" },
        basis: "clean_report",
        at: fixedNow,
      });
      expect(store.getVerifiedClearance("job-1", "demo", "/tmp/wt")?.basis).toBe("clean_report");
      expect(store.getVerifiedClearance("job-1", "demo", "/tmp/other-wt")).toBeNull();
    } finally {
      store.close();
    }
  });
});

describe("dependency hold decide: pre-approval validation, idempotency, rollback, scan scheduler, and gate", () => {
  const fixedNow = 1_700_000_000;

  function seedPendingReport(
    queueRoot: string,
    report: DepReportRecord,
    extra?: { holding?: boolean },
  ) {
    const store = new SqliteDepsStore(queueRoot);
    try {
      store.saveRepoState(
        {
          repo: "demo",
          holding: extra?.holding ?? true,
          holdingSince: fixedNow - 1000,
          report,
        },
        fixedNow,
      );
    } finally {
      store.close();
    }
  }

  it("validates missing, stale (>24h), and changed-files reports BEFORE requesting owner approval", async () => {
    const queueRoot = mkTempDir("sq-deps-preval-");
    const approvalCalls: OwnerApprovalInput[] = [];
    const requestOwnerApproval = async (input: OwnerApprovalInput) => {
      approvalCalls.push(input);
      return { ok: true, approvedBy: "human" };
    };

    // 1. Missing report -> rejected with 0 approval prompts.
    const missing = await decideShipQueueDeps(
      { queueRoot, nowEpochSec: () => fixedNow, requestOwnerApproval },
      { reportId: "demo:missing", decision: "approve", cwd: queueRoot },
    );
    expect(missing.ok).toBe(false);
    expect(missing.errorCode).toBe("stale_report");
    expect(approvalCalls).toHaveLength(0);

    // 2. Stale report (>24h old) -> rejected with 0 approval prompts.
    seedPendingReport(queueRoot, {
      id: "demo:stale",
      created: fixedNow - 90_000,
      status: "pending",
      files: { "package.json": "h1" },
      updates: [
        {
          packageFile: "package.json",
          depName: "vitest",
          currentValue: "4.0.0",
          newValue: "4.1.0",
        },
      ],
    });
    const stale = await decideShipQueueDeps(
      { queueRoot, nowEpochSec: () => fixedNow, requestOwnerApproval },
      { reportId: "demo:stale", decision: "approve", cwd: queueRoot },
    );
    expect(stale.ok).toBe(false);
    expect(stale.errorCode).toBe("stale_report");
    expect(approvalCalls).toHaveLength(0);

    // 3. Fresh report whose dependency files changed on main -> rejected with 0 approval prompts.
    seedPendingReport(queueRoot, {
      id: "demo:drift",
      created: fixedNow - 60,
      status: "pending",
      files: { "package.json": "h1" },
      updates: [
        {
          packageFile: "package.json",
          depName: "vitest",
          currentValue: "4.0.0",
          newValue: "4.1.0",
        },
      ],
    });
    const drifted = await decideShipQueueDeps(
      {
        queueRoot,
        nowEpochSec: () => fixedNow,
        requestOwnerApproval,
        readCurrentFiles: async () => ({ "package.json": "h2-changed" }),
      },
      { reportId: "demo:drift", decision: "approve", cwd: queueRoot },
    );
    expect(drifted.ok).toBe(false);
    expect(drifted.errorCode).toBe("files_changed");
    expect(approvalCalls).toHaveLength(0);
  });

  it("enforces idempotency per reportId, rejects conflicting decisions without re-prompting, and supports rollback", async () => {
    const queueRoot = mkTempDir("sq-deps-idemp-");
    const now = fixedNow;
    const approvalCalls: OwnerApprovalInput[] = [];
    const requestOwnerApproval = async (input: OwnerApprovalInput) => {
      approvalCalls.push(input);
      return { ok: true, approvedBy: "human" };
    };

    seedPendingReport(queueRoot, {
      id: "demo:rep1",
      created: fixedNow - 30,
      status: "pending",
      files: { "package.json": "digest-1" },
      updates: [
        {
          packageFile: "package.json",
          depName: "vitest",
          currentValue: "4.0.0",
          newValue: "4.1.0",
        },
      ],
    });

    // First approve calls owner approval once and records the attempt.
    const first = await decideShipQueueDeps(
      {
        queueRoot,
        nowEpochSec: () => now,
        requestOwnerApproval,
        makeAttemptToken: () => "tok123",
      },
      { reportId: "demo:rep1", decision: "approve", cwd: queueRoot },
    );
    expect(first.ok).toBe(true);
    expect(first.idempotent).toBe(false);
    expect(first.attemptId).toBe("demo:tok123");
    expect(approvalCalls).toHaveLength(1);

    // Repeat approve for the same reportId is idempotent and invokes 0 additional approvals!
    const repeat = await decideShipQueueDeps(
      { queueRoot, nowEpochSec: () => now + 10, requestOwnerApproval },
      { reportId: "demo:rep1", decision: "approve", cwd: queueRoot },
    );
    expect(repeat.ok).toBe(true);
    expect(repeat.idempotent).toBe(true);
    expect(repeat.attemptId).toBe("demo:tok123");
    expect(approvalCalls).toHaveLength(1);

    // Opposite decision for the same reportId conflicts with 0 additional approvals!
    const conflict = await decideShipQueueDeps(
      { queueRoot, nowEpochSec: () => now + 20, requestOwnerApproval },
      { reportId: "demo:rep1", decision: "reject", cwd: queueRoot },
    );
    expect(conflict.ok).toBe(false);
    expect(conflict.errorCode).toBe("conflict");
    expect(approvalCalls).toHaveLength(1);

    // While attempt is active, unrelated jobs are blocked by evaluateDepsGate.
    const blocked = evaluateDepsGate({
      queueRoot,
      repo: "demo",
      jobId: "other-job",
      worktree: "/tmp/wt",
      files: { "package.json": "digest-1" },
      nowEpochSec: () => now + 25,
    });
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toContain("active_attempt:");

    // Explicit rollback uses explicit rollback command (never decision='reject') and atomic commit.
    const rolled = await rollbackShipQueueDepsAttempt(
      { queueRoot, nowEpochSec: () => now + 30, requestOwnerApproval },
      {
        attemptId: "demo:tok123",
        reason: "reverting failed dependency update",
        cwd: queueRoot,
      },
    );
    expect(rolled.ok).toBe(true);
    const rollbackApproval = approvalCalls[approvalCalls.length - 1]!;
    expect(rollbackApproval.action).toBe("rollback");
    expect(rollbackApproval.decision).toBeUndefined();
    expect(rollbackApproval.command.slice(0, 4)).toEqual([
      "ship-queue",
      "deps",
      "rollback",
      "demo:tok123",
    ]);
    expect(rollbackApproval.command[4]).toMatch(/^[0-9a-f]{64}$/);

    const listed = listShipQueueDeps(queueRoot, () => now + 30);
    expect(listed.repos).toHaveLength(1);
    expect(listed.repos[0]!.attemptStatus).toBe("cancelled");
    expect(listed.repos[0]!.holding).toBe(false);
  });

  it("binds owner approvals to report digest, rejects mid-flight mutations, validates against origin/main, and handles concurrent decides", async () => {
    const queueRoot = mkTempDir("sq-deps-hardened-");
    const now = fixedNow;

    // 1. Real git repo with bare origin remote: default scanner scans real manifests & catches origin/main drift.
    const bare = mkTempDir("sq-deps-bare-");
    const primary = mkTempDir("sq-deps-primary-");
    const git = async (cwd: string, args: string[]) => {
      const r = await nodeProcessRunner({ command: "git", args, cwd });
      if (r.exitCode !== 0) throw new Error(r.stderr);
      return r.stdout.trim();
    };
    await git(bare, ["init", "--bare", "-b", "main"]);
    await git(primary, ["init", "-b", "main"]);
    await git(primary, ["config", "user.email", "test@example.com"]);
    await git(primary, ["config", "user.name", "Test User"]);
    await git(primary, ["remote", "add", "origin", bare]);
    NodeFS.writeFileSync(
      NodePath.join(primary, "package.json"),
      JSON.stringify({ name: "demo", dependencies: { vitest: "4.0.0" } }),
    );
    await git(primary, ["add", "package.json"]);
    await git(primary, ["commit", "-m", "init"]);
    await git(primary, ["push", "-u", "origin", "main"]);

    // The update lookup stands in for the registry: it reports vitest's newest release, so a
    // report turns pending only when upstream publishes one, never because a manifest changed.
    let latestVitest = "4.0.0";
    const lookup = async (input: { tree: string }) => {
      const manifest = JSON.parse(
        NodeFS.readFileSync(NodePath.join(input.tree, "package.json"), "utf8"),
      ) as {
        dependencies: Record<string, string>;
      };
      const current = manifest.dependencies.vitest ?? "";
      return {
        updates:
          current === latestVitest
            ? []
            : [
                {
                  packageFile: "package.json",
                  depName: "vitest",
                  currentValue: current,
                  newValue: latestVitest,
                },
              ],
        incomplete: [],
      };
    };

    // Unregistered repo scan fails cleanly AND clears scanStarted (no 30-min lockout).
    const unregistered = await scanShipQueueDepsRepo(
      { queueRoot, nowEpochSec: () => now, lookup },
      { repo: "realrepo" },
    );
    expect(unregistered.ok).toBe(false);

    // Register primary and immediately re-scan -> succeeds without lockout!
    NodeFS.mkdirSync(NodePath.join(queueRoot, "repos", "realrepo"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(queueRoot, "repos", "realrepo", "primary"), `${primary}\n`);

    const scan1 = await scanShipQueueDepsRepo(
      { queueRoot, nowEpochSec: () => now + 5, lookup },
      { repo: "realrepo" },
    );
    expect(scan1.ok).toBe(true);
    expect(scan1.skipped).toBe(false);
    expect(scan1.report?.status).toBe("clean");
    expect(scan1.report?.files["package.json"]).toMatch(/^[0-9a-f]{64}$/);

    // Upstream publishes vitest 4.1.0 -> the next scan reports it as a pending update.
    latestVitest = "4.1.0";

    const scan2 = await scanShipQueueDepsRepo(
      { queueRoot, nowEpochSec: () => now + 10, lookup },
      { repo: "realrepo" },
    );
    expect(scan2.ok).toBe(true);
    expect(scan2.report?.status).toBe("pending");
    expect(scan2.report?.updates).toHaveLength(1);
    const report2 = scan2.report!;
    const expectedDigest = computeReportDigest(report2);

    // Push another commit to origin/main AFTER scan2 -> decideShipQueueDeps checks live origin/main
    // (NOT report.source.commit!) and rejects with files_changed BEFORE requesting approval.
    NodeFS.writeFileSync(
      NodePath.join(primary, "package.json"),
      JSON.stringify({ name: "demo", dependencies: { vitest: "4.2.0" } }),
    );
    await git(primary, ["add", "package.json"]);
    await git(primary, ["commit", "-m", "bump2"]);
    await git(primary, ["push", "origin", "main"]);

    let approvalCount = 0;
    const driftedRes = await decideShipQueueDeps(
      {
        queueRoot,
        nowEpochSec: () => now + 15,
        requestOwnerApproval: async () => {
          approvalCount += 1;
          return { ok: true, approvedBy: "human" };
        },
      },
      { reportId: report2.id, decision: "approve", cwd: primary },
    );
    expect(driftedRes.ok).toBe(false);
    expect(driftedRes.errorCode).toBe("files_changed");
    expect(approvalCount).toBe(0);

    // 2. Digest mismatch rejection if report mutates mid-flight during owner approval!
    const reportMut: DepReportRecord = {
      id: "demo:mut1",
      created: now,
      status: "pending",
      files: { "package.json": "sha-original" },
      updates: [
        {
          packageFile: "package.json",
          depName: "vitest",
          currentValue: "4.0.0",
          newValue: "4.1.0",
        },
      ],
    };
    seedPendingReport(queueRoot, reportMut);
    let capturedCommand: ReadonlyArray<string> = [];
    const mutRes = await decideShipQueueDeps(
      {
        queueRoot,
        nowEpochSec: () => now + 20,
        requestOwnerApproval: async (approvalInput) => {
          capturedCommand = approvalInput.command;
          // Mutate the stored report while awaiting approval!
          const s = new SqliteDepsStore(queueRoot);
          try {
            const st = s.getRepoState("demo")!;
            s.saveRepoState(
              {
                ...st,
                report: { ...reportMut, files: { "package.json": "sha-mutated-midflight" } },
              },
              now + 20,
            );
          } finally {
            s.close();
          }
          return { ok: true, approvedBy: "human" };
        },
      },
      { reportId: "demo:mut1", decision: "approve", cwd: queueRoot },
    );
    expect(capturedCommand).toEqual([
      "ship-queue",
      "deps",
      "decide",
      "demo:mut1",
      "approve",
      computeReportDigest(reportMut),
    ]);
    expect(mutRes.ok).toBe(false);
    expect(mutRes.errorCode).toBe("files_changed");

    // 3. Concurrent decide calls for the same reportId resolve cleanly (1 commits, 1 idempotent, no crash).
    const reportConc: DepReportRecord = {
      id: "demo:conc1",
      created: now,
      status: "pending",
      files: { "package.json": "sha-conc" },
      updates: [
        {
          packageFile: "package.json",
          depName: "vitest",
          currentValue: "4.0.0",
          newValue: "4.1.0",
        },
      ],
    };
    seedPendingReport(queueRoot, reportConc);
    let releaseBarrier!: () => void;
    let arrived = 0;
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    const syncedApprove = async () => {
      arrived += 1;
      if (arrived === 2) releaseBarrier();
      await barrier;
      return { ok: true, approvedBy: "human" };
    };
    const [c1, c2] = await Promise.all([
      decideShipQueueDeps(
        {
          queueRoot,
          nowEpochSec: () => now + 25,
          requestOwnerApproval: syncedApprove,
          makeAttemptToken: () => "conctok",
        },
        { reportId: "demo:conc1", decision: "approve", cwd: queueRoot },
      ),
      decideShipQueueDeps(
        {
          queueRoot,
          nowEpochSec: () => now + 25,
          requestOwnerApproval: syncedApprove,
          makeAttemptToken: () => "conctok2",
        },
        { reportId: "demo:conc1", decision: "approve", cwd: queueRoot },
      ),
    ]);
    expect(c1.ok).toBe(true);
    expect(c2.ok).toBe(true);
    expect([c1.idempotent, c2.idempotent].toSorted()).toEqual([false, true]);
    expect(c1.attemptId).toBe(c2.attemptId);
    expect(expectedDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("never reads a lookup with failed dependencies as clean, so the gate holds the job", async () => {
    const queueRoot = mkTempDir("sq-deps-incomplete-");
    const primary = mkTempDir("sq-deps-incomplete-repo-");
    const git = async (args: string[]) => {
      const r = await nodeProcessRunner({ command: "git", args, cwd: primary });
      if (r.exitCode !== 0) throw new Error(r.stderr);
      return r.stdout.trim();
    };
    await git(["init", "-b", "main"]);
    await git(["config", "user.email", "test@example.com"]);
    await git(["config", "user.name", "Test User"]);
    NodeFS.writeFileSync(
      NodePath.join(primary, "package.json"),
      '{"name":"demo","dependencies":{"vitest":"4.0.0"}}',
    );
    await git(["add", "package.json"]);
    await git(["commit", "-m", "init"]);
    writeRegistration(queueRoot, "demo", {
      primary,
      remoteUrl: "https://example.invalid/demo.git",
    });

    let incomplete: string[] = [];
    const lookup = async () => ({ updates: [], incomplete });
    const clean = await scanShipQueueDepsRepo(
      { queueRoot, nowEpochSec: () => fixedNow, lookup },
      { repo: "demo" },
    );
    expect(clean.report?.status).toBe("clean");
    const files = clean.report!.files;
    const gate = (at: number) =>
      evaluateDepsGate({
        queueRoot,
        repo: "demo",
        jobId: "job-1",
        worktree: primary,
        files,
        nowEpochSec: () => at,
      });
    expect(gate(fixedNow + 1)).toEqual({ allowed: true, reason: "clean_report" });

    // The next lookup fails for one dependency (rate limit, no token): not clean, and the gate holds.
    incomplete = ["package.json: vitest"];
    const failed = await scanShipQueueDepsRepo(
      { queueRoot, nowEpochSec: () => fixedNow + 21 * 3600, lookup },
      { repo: "demo", due: true },
    );
    expect(failed.report?.status).toBe("incomplete");
    expect(failed.report?.incomplete).toEqual(["package.json: vitest"]);
    expect(gate(fixedNow + 21 * 3600 + 1).allowed).toBe(false);

    // A mixed result (an update found, another lookup failed) is incomplete too, and the owner
    // cannot approve it as if it were a complete list.
    incomplete = ["package.json: vitest"];
    const mixedLookup = async () => ({
      updates: [
        {
          packageFile: "package.json",
          depName: "vitest",
          currentValue: "4.0.0",
          newValue: "4.1.0",
        },
      ],
      incomplete,
    });
    const mixed = await scanShipQueueDepsRepo(
      { queueRoot, nowEpochSec: () => fixedNow + 26 * 3600, lookup: mixedLookup },
      { repo: "demo", due: true },
    );
    expect(mixed.report?.status).toBe("incomplete");
    let asked = 0;
    const approve = await decideShipQueueDeps(
      {
        queueRoot,
        nowEpochSec: () => fixedNow + 26 * 3600 + 5,
        requestOwnerApproval: async () => {
          asked += 1;
          return { ok: true, approvedBy: "human" };
        },
      },
      { reportId: mixed.report!.id, decision: "approve", cwd: primary },
    );
    expect(approve.ok).toBe(false);
    expect(asked).toBe(0);
  });

  it("keeps a registered repo's failed scan for status polling, with the hold still off", async () => {
    const queueRoot = mkTempDir("sq-deps-failscan-");
    const primary = mkTempDir("sq-deps-failscan-repo-");
    const git = async (args: string[]) => {
      const r = await nodeProcessRunner({ command: "git", args, cwd: primary });
      if (r.exitCode !== 0) throw new Error(r.stderr);
    };
    await git(["init", "-b", "main"]);
    await git(["config", "user.email", "test@example.com"]);
    await git(["config", "user.name", "Test User"]);
    NodeFS.writeFileSync(NodePath.join(primary, "package.json"), '{"name":"demo"}');
    await git(["add", "package.json"]);
    await git(["commit", "-m", "init"]);
    writeRegistration(queueRoot, "demo", {
      primary,
      remoteUrl: "https://example.invalid/demo.git",
    });
    const lookup = async (): Promise<never> => {
      throw new Error("Renovate is not installed");
    };
    const scan = await scanShipQueueDepsRepo(
      { queueRoot, nowEpochSec: () => fixedNow, lookup },
      { repo: "demo" },
    );
    expect(scan.ok).toBe(false);
    // What a client polls after POST /deps/scan answered `started`: the failure is there.
    const repo = listShipQueueDeps(queueRoot, () => fixedNow + 5).repos.find(
      (r) => r.repo === "demo",
    );
    expect(repo?.error).toContain("Renovate is not installed");
    expect(repo?.holding).toBe(false);
    // A failed scan is not a report to decide: neither approve nor reject applies to it.
    const failedId = listShipQueueDeps(queueRoot, () => fixedNow + 6).repos.find(
      (r) => r.repo === "demo",
    )?.reportId;
    expect(failedId).toBeTruthy();
    {
      const rejected = await decideShipQueueDeps(
        {
          queueRoot,
          nowEpochSec: () => fixedNow + 7,
          requestOwnerApproval: async () => ({ ok: true, approvedBy: "human" }),
        },
        { reportId: failedId!, decision: "reject", cwd: primary },
      );
      expect(rejected.ok).toBe(false);
    }
    // The claim is cleared: a new scan may run at once.
    const again = await scanShipQueueDepsRepo(
      { queueRoot, nowEpochSec: () => fixedNow + 10, lookup },
      { repo: "demo" },
    );
    expect(again.skipped).not.toBe(true);
  });

  it("reads every file Renovate's npm manager reads, and reports the claim before a lookup", async () => {
    const queueRoot = mkTempDir("sq-deps-catalogs-");
    const primary = mkTempDir("sq-deps-catalogs-repo-");
    const git = async (args: string[]) => {
      const r = await nodeProcessRunner({ command: "git", args, cwd: primary });
      if (r.exitCode !== 0) throw new Error(r.stderr);
    };
    await git(["init", "-b", "main"]);
    await git(["config", "user.email", "test@example.com"]);
    await git(["config", "user.name", "Test User"]);
    for (const [file, text] of [
      ["package.json", '{"name":"root"}'],
      ["apps/a/package.json", '{"name":"a","dependencies":{"x":"catalog:"}}'],
      ["apps/a/pnpm-workspace.yaml", "catalog:\n  x: 1.0.0\n"],
      [".yarnrc.yml", "catalog:\n  y: 2.0.0\n"],
      ["apps/a/.yarnrc", 'registry "https://registry.example.invalid/"\n'],
      ["apps/a/.npmrc", "registry=https://registry.example.invalid/\n"],
    ] as const) {
      NodeFS.mkdirSync(NodePath.dirname(NodePath.join(primary, file)), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(primary, file), text);
    }
    await git(["add", "-A"]);
    await git(["commit", "-m", "init"]);
    writeRegistration(queueRoot, "demo", {
      primary,
      remoteUrl: "https://example.invalid/demo.git",
    });

    let seenPaths: ReadonlyArray<string> = [];
    const lookup = async (input: { tree: string; paths: ReadonlyArray<string> }) => {
      // Every listed path is a file in the tree.
      seenPaths = input.paths.filter((p) => NodeFS.existsSync(NodePath.join(input.tree, p)));
      return { updates: [], incomplete: [] };
    };
    const claims: Array<{ started: boolean; reason?: string }> = [];
    const first = await scanShipQueueDepsRepo(
      { queueRoot, nowEpochSec: () => fixedNow, lookup, onClaim: (c) => claims.push(c) },
      { repo: "demo" },
    );
    expect(seenPaths).toEqual(
      expect.arrayContaining([
        ".yarnrc.yml",
        "apps/a/.yarnrc",
        "apps/a/pnpm-workspace.yaml",
        "apps/a/.npmrc",
      ]),
    );
    expect(Object.keys(first.report!.files)).toEqual(
      expect.arrayContaining([
        ".yarnrc.yml",
        "apps/a/.yarnrc",
        "apps/a/pnpm-workspace.yaml",
        "apps/a/.npmrc",
      ]),
    );
    // A scan that cannot claim the repo says why before any lookup.
    const store = new SqliteDepsStore(queueRoot);
    try {
      store.saveRepoState(
        { ...store.getRepoState("demo")!, scanStarted: fixedNow + 1 },
        fixedNow + 1,
      );
    } finally {
      store.close();
    }
    await scanShipQueueDepsRepo(
      { queueRoot, nowEpochSec: () => fixedNow + 2, lookup, onClaim: (c) => claims.push(c) },
      { repo: "demo" },
    );
    expect(claims).toEqual([
      { started: true },
      { started: false, reason: "a scan is already running" },
    ]);
  });

  it("reads a lockfile larger than one read batch exactly, and the owner can decide its report", async () => {
    const queueRoot = mkTempDir("sq-deps-biglock-");
    const primary = mkTempDir("sq-deps-biglock-repo-");
    const git = async (args: string[]) => {
      const r = await nodeProcessRunner({ command: "git", args, cwd: primary });
      if (r.exitCode !== 0) throw new Error(r.stderr);
    };
    await git(["init", "-b", "main"]);
    await git(["config", "user.email", "test@example.com"]);
    await git(["config", "user.name", "Test User"]);
    NodeFS.writeFileSync(
      NodePath.join(primary, "package.json"),
      '{"name":"demo","dependencies":{"vitest":"4.0.0"}}',
    );
    // A 3.5 MiB lockfile: more than the 3 MiB batch target, less than the runner's 4 MiB cap.
    const entry = (i: number) =>
      `  /pkg-${i}@1.0.0:\n    resolution: {integrity: sha512-${"a".repeat(80)}}\n`;
    let lock = "lockfileVersion: '9.0'\npackages:\n";
    for (let i = 0; lock.length < 3.5 * 1024 * 1024; i += 1) lock += entry(i);
    NodeFS.writeFileSync(NodePath.join(primary, "pnpm-lock.yaml"), lock);
    await git(["add", "package.json", "pnpm-lock.yaml"]);
    await git(["commit", "-m", "init"]);
    // A real origin: the owner's decision re-reads the dependency files at origin/main.
    const origin = mkTempDir("sq-deps-biglock-origin-");
    await git(["init", "--bare", "-b", "main", origin]);
    await git(["remote", "add", "origin", origin]);
    await git(["push", "-q", "origin", "main"]);
    await git(["fetch", "-q", "origin"]);
    writeRegistration(queueRoot, "demo", {
      primary,
      remoteUrl: "https://example.invalid/demo.git",
    });
    let seenLock: Uint8Array | undefined;
    let seenTree = "";
    const lookup = async (input: { tree: string }) => {
      seenTree = input.tree;
      seenLock = NodeFS.readFileSync(NodePath.join(input.tree, "pnpm-lock.yaml"));
      return {
        updates: [
          {
            packageFile: "package.json",
            depName: "vitest",
            currentValue: "4.0.0",
            newValue: "4.1.0",
          },
        ],
        incomplete: [],
      };
    };
    const scan = await scanShipQueueDepsRepo(
      { queueRoot, nowEpochSec: () => fixedNow, lookup },
      { repo: "demo" },
    );
    expect(scan.report?.status).toBe("pending");
    expect(Buffer.from(seenLock!).equals(Buffer.from(lock))).toBe(true);
    // The extracted tree is removed once the lookup is done.
    expect(NodeFS.existsSync(seenTree)).toBe(false);
    expect(Object.keys(scan.report!.files)).toContain("pnpm-lock.yaml");
    const rejected = await decideShipQueueDeps(
      {
        queueRoot,
        nowEpochSec: () => fixedNow + 5,
        requestOwnerApproval: async () => ({ ok: true, approvedBy: "human" }),
      },
      { reportId: scan.report!.id, decision: "reject", cwd: primary },
    );
    expect(rejected.ok).toBe(true);
  });

  it("keeps the hold off until the owner decides, even when the first scan finds updates", async () => {
    const queueRoot = mkTempDir("sq-deps-pilot-");
    const primary = mkTempDir("sq-deps-pilot-repo-");
    const git = async (args: string[]) => {
      const r = await nodeProcessRunner({ command: "git", args, cwd: primary });
      if (r.exitCode !== 0) throw new Error(r.stderr);
    };
    await git(["init", "-b", "main"]);
    await git(["config", "user.email", "test@example.com"]);
    await git(["config", "user.name", "Test User"]);
    NodeFS.writeFileSync(
      NodePath.join(primary, "package.json"),
      '{"name":"demo","dependencies":{"vitest":"4.0.0"}}',
    );
    await git(["add", "package.json"]);
    await git(["commit", "-m", "init"]);
    writeRegistration(queueRoot, "demo", {
      primary,
      remoteUrl: "https://example.invalid/demo.git",
    });
    const lookup = async () => ({
      updates: [
        {
          packageFile: "package.json",
          depName: "vitest",
          currentValue: "4.0.0",
          newValue: "4.1.0",
        },
      ],
      incomplete: [],
    });
    const first = await scanShipQueueDepsRepo(
      { queueRoot, nowEpochSec: () => fixedNow, lookup },
      { repo: "demo" },
    );
    expect(first.report?.status).toBe("pending");
    // The documented pilot: the hold is the owner's to turn on, so the gate admits jobs until then.
    expect(
      evaluateDepsGate({
        queueRoot,
        repo: "demo",
        jobId: "job-1",
        worktree: primary,
        files: first.report!.files,
        nowEpochSec: () => fixedNow + 1,
      }),
    ).toEqual({ allowed: true, reason: "hold_inactive" });
  });

  it("scans due repos on cadence via scanDueDepsRepos and admits clean reports through evaluateDepsGate", async () => {
    const queueRoot = mkTempDir("sq-deps-scan-");
    NodeFS.mkdirSync(NodePath.join(queueRoot, "repos", "alpha"), { recursive: true });
    const alphaCheckout = mkTempDir("sq-deps-alpha-");
    NodeFS.writeFileSync(
      NodePath.join(queueRoot, "repos", "alpha", "primary"),
      `${alphaCheckout}\n`,
    );
    // `ship-queue submit` registers a repo in registration.json; the due scan must find it too.
    const betaCheckout = mkTempDir("sq-deps-beta-");
    writeRegistration(queueRoot, "beta", {
      primary: betaCheckout,
      remoteUrl: "https://example.invalid/beta.git",
    });
    // A registration whose checkout is gone is not scanned.
    writeRegistration(queueRoot, "gone", {
      primary: NodePath.join(betaCheckout, "missing"),
      remoteUrl: "",
    });

    let now = fixedNow;
    let scans = 0;
    const runRepoScan = async (repo: string) => {
      scans += 1;
      return {
        id: `${repo}:scan${scans}`,
        created: now,
        status: "clean",
        files: { "package.json": "clean-digest" },
        updates: [],
      };
    };

    const pass1 = await scanDueDepsRepos({
      queueRoot,
      nowEpochSec: () => now,
      runRepoScan,
    });
    expect(pass1.scanned).toEqual(["alpha", "beta"]);
    expect(pass1.skipped).toEqual([]);
    expect(resolveRegisteredRepoPrimary(queueRoot, "beta")).toBe(betaCheckout);
    expect(resolveRegisteredRepoPrimary(queueRoot, "gone")).toBeNull();

    // Immediate second pass skips because interval hasn't elapsed.
    const pass2 = await scanDueDepsRepos({
      queueRoot,
      nowEpochSec: () => now + 60,
      runRepoScan,
    });
    expect(pass2.scanned).toEqual([]);
    expect(pass2.skipped).toEqual(["alpha", "beta"]);

    // Gate allows a job matching the clean report's file digests.
    expect(
      evaluateDepsGate({
        queueRoot,
        repo: "alpha",
        jobId: "job-1",
        worktree: "/tmp/alpha-wt",
        files: { "package.json": "clean-digest" },
        nowEpochSec: () => now + 120,
      }),
    ).toEqual({ allowed: true, reason: "clean_report" });

    // Advancing past rescan interval (20h) triggers a fresh scan.
    now += 21 * 3600;
    const pass3 = await scanShipQueueDepsRepo(
      { queueRoot, nowEpochSec: () => now, runRepoScan },
      { repo: "alpha", due: true },
    );
    expect(pass3.ok).toBe(true);
    expect(pass3.skipped).toBe(false);
    expect(scans).toBe(3);
  });
});

describe("sq_pins.json specification validation, version extraction, digests, and Renovate managers", () => {
  it("validates the committed infra/ci-host/sq_pins.json and computes pin versions, digests, and managers", () => {
    const repoRoot = NodePath.resolve(import.meta.dirname, "../../..");
    const specPath = NodePath.join(repoRoot, "infra", "ci-host", "sq_pins.json");
    const spec = loadPinsSpec(specPath);
    expect(spec.schema).toBe(1);
    expect(spec.pins.length).toBeGreaterThan(10);

    const vpPin = spec.pins.find((p) => p.name === "vp");
    expect(vpPin).toBeDefined();
    expect(vpPin?.depName).toBe("voidzero-dev/vite-plus");

    const sccachePin = spec.pins.find((p) => p.name === "sccache");
    expect(sccachePin).toBeDefined();
    expect(sccachePin?.depName).toBe("mozilla/sccache");

    const catalogText = NodeFS.readFileSync(
      NodePath.join(repoRoot, "infra", "ci-host", "ci-hosts.json"),
      "utf8",
    );
    // The extracted pin agrees with the catalog's own install line, whatever release it names.
    const sccacheInstall = (
      JSON.parse(catalogText) as { toolchain: Record<string, { install: string }> }
    ).toolchain.sccache!.install;
    const sccachePinned = extractCurrentPinValue(catalogText, sccachePin!);
    expect(sccachePinned).toMatch(/^\d+\.\d+\.\d+$/);
    expect(sccacheInstall).toContain(`ci-sccache.sh" ${sccachePinned} `);
    const digests = computePinDigests({ "infra/ci-host/ci-hosts.json": catalogText }, spec);
    expect(digests["pin:vp"]).toMatch(/^[0-9a-f]{64}$/);

    const managers = buildRenovateCustomManagers(spec);
    expect(managers).toHaveLength(spec.pins.length);
    expect(managers.some((m) => m.depNameTemplate === "voidzero-dev/vite-plus")).toBe(true);
  });

  it("marks a declared pin that Renovate did not assess as incomplete", () => {
    const repoRoot = NodePath.resolve(import.meta.dirname, "../../..");
    const spec = loadPinsSpec(NodePath.join(repoRoot, "infra", "ci-host", "sq_pins.json"));
    const pinFiles = [...new Set(spec.pins.map((pin) => pin.file))];
    const files = new Map(
      pinFiles.map((file) => [file, NodeFS.readFileSync(NodePath.join(repoRoot, file))] as const),
    );
    // Renovate's record for each pin, with the value it read (as a full lookup reports it).
    const assessed = new Map(
      spec.pins.map((pin) => [
        `${pin.file}\0${pin.depName}`,
        extractCurrentPinValue(files.get(pin.file)!.toString("utf8"), pin)!,
      ]),
    );
    expect(reconcileDeclaredPins(spec, files, assessed)).toEqual([]);
    const vp = spec.pins.find((pin) => pin.name === "vp")!;
    const fly = spec.pins.find((pin) => pin.name === "fly")!;
    // The pin's file is missing from the commit: every pin in it is unassessed.
    const noFleetTools = new Map(files);
    noFleetTools.delete(fly.file);
    expect(reconcileDeclaredPins(spec, noFleetTools, assessed)).toContain(
      `${fly.file}: ${fly.depName} (the pin's file is not in the commit)`,
    );
    // Renovate emitted no record for a pin (its manager matched nothing it could look up).
    const noVp = new Map(assessed);
    noVp.delete(`${vp.file}\0${vp.depName}`);
    expect(reconcileDeclaredPins(spec, files, noVp)).toEqual([
      `${vp.file}: ${vp.depName} (Renovate reported no lookup for this pin)`,
    ]);
    // Renovate read another value than the pin's pattern matches.
    const otherVp = new Map(assessed).set(`${vp.file}\0${vp.depName}`, "0.0.1");
    expect(reconcileDeclaredPins(spec, files, otherVp)[0]).toContain("Renovate read 0.0.1");
    // The pin's pattern no longer matches its file.
    const broken = new Map(files).set(vp.file, Buffer.from("{}\n"));
    expect(reconcileDeclaredPins(spec, broken, assessed)).toContain(
      `${vp.file}: ${vp.depName} (the pin's pattern matches no version)`,
    );
  });

  it("passes the pin limits to Renovate, so it picks the newest allowed release", () => {
    const repoRoot = NodePath.resolve(import.meta.dirname, "../../..");
    const spec = loadPinsSpec(NodePath.join(repoRoot, "infra", "ci-host", "sq_pins.json"));
    const rules = buildPinPackageRules(spec);
    const forDep = (depName: string) =>
      rules.filter((r) => (r.matchDepNames as string[] | undefined)?.includes(depName));
    // uv has no `major`: Renovate must not choose a new major or a new 0.x minor for it.
    expect(forDep("astral-sh/uv")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ matchUpdateTypes: ["major"], enabled: false }),
        expect.objectContaining({
          matchCurrentVersion: "/^v?0\\./",
          matchUpdateTypes: ["minor"],
          enabled: false,
        }),
      ]),
    );
    expect(forDep("astral-sh/uv")).toEqual(
      expect.arrayContaining([expect.objectContaining({ separateMinorPatch: true })]),
    );
    // ffmpeg takes majors and only month-end builds; its own exact range is the only one set
    // (a later rule would replace it).
    const ffmpegPin = spec.pins.find((pin) => pin.depName === "BtbN/FFmpeg-Builds")!;
    const ffmpeg = forDep("BtbN/FFmpeg-Builds");
    expect(ffmpeg.some((r) => r.enabled === false)).toBe(false);
    const ranges = ffmpeg.map((r) => r.allowedVersions).filter((v) => typeof v === "string");
    expect(ranges).toEqual(
      ffmpegPin.allowedVersions ? [ffmpegPin.allowedVersions] : [expect.any(String)],
    );
    // Every rule is scoped to the pin's own file.
    for (const rule of rules) {
      expect(spec.pins.some((pin) => (rule.matchFileNames as string[])[0] === pin.file)).toBe(true);
    }
  });

  it("offers only the tool-pin updates sq_pins.json allows", () => {
    const repoRoot = NodePath.resolve(import.meta.dirname, "../../..");
    const spec = loadPinsSpec(NodePath.join(repoRoot, "infra", "ci-host", "sq_pins.json"));
    const file = "infra/ci-host/ci-hosts.json";
    const limited = applyPinLimits(
      {
        updates: [
          {
            packageFile: file,
            depName: "astral-sh/uv",
            currentValue: "0.13.9",
            newValue: "0.13.10",
          },
          {
            packageFile: file,
            depName: "astral-sh/uv",
            currentValue: "0.13.9",
            newValue: "0.14.0",
          },
          { packageFile: file, depName: "typescript", currentValue: "5.9.3", newValue: "7.0.2" },
          {
            packageFile: file,
            depName: "BtbN/FFmpeg-Builds",
            currentValue: "2026-10-31-12-59",
            newValue: "2026-11-27-12-42",
          },
          {
            packageFile: file,
            depName: "BtbN/FFmpeg-Builds",
            currentValue: "2026-10-31-12-59",
            newValue: "2026-11-30-12-50",
          },
          {
            packageFile: "package.json",
            depName: "knip",
            currentValue: "6.34.0",
            newValue: "7.0.0",
          },
        ],
        incomplete: [],
      },
      spec,
    );
    expect(limited.updates.map((u) => `${u.depName} ${u.newValue}`)).toEqual([
      "astral-sh/uv 0.13.10",
      "BtbN/FFmpeg-Builds 2026-11-30-12-50",
      "knip 7.0.0",
    ]);
  });

  it("anchors every pin in a tracked file, exactly once", () => {
    const repoRoot = NodePath.resolve(import.meta.dirname, "../../..");
    const spec = loadPinsSpec(NodePath.join(repoRoot, "infra", "ci-host", "sq_pins.json"));
    for (const pin of spec.pins) {
      const target = NodePath.join(repoRoot, pin.file);
      expect(NodeFS.existsSync(target), `${pin.name}: ${pin.file}`).toBe(true);
      const text = NodeFS.readFileSync(target, "utf8");
      const hits = [...text.matchAll(new RegExp(pin.match, "g"))];
      expect(hits.length, `${pin.name}: anchor matches in ${pin.file}`).toBe(1);
      expect(extractPinVersions({ ...spec, pins: [pin] }, repoRoot)).toHaveLength(1);
    }
  });
});
