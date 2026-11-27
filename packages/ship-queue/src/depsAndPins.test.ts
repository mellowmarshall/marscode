// @effect-diagnostics nodeBuiltinImport:off - Real behavioral tests for SQLite deps store, pre-approval validation, idempotency, and pins.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { decideShipQueueDeps, listShipQueueDeps } from "./depsEngine.ts";
import { computeReportDigest } from "./depsRepoFiles.ts";
import { rollbackShipQueueDepsAttempt, type OwnerApprovalInput } from "./depsRollback.ts";
import { evaluateDepsGate, scanDueDepsRepos, scanShipQueueDepsRepo } from "./depsScan.ts";
import { SqliteDepsStore } from "./depsStore.ts";
import type { DepReportRecord } from "./depsTypes.ts";
import { nodeProcessRunner } from "./nodeProcess.ts";
import {
  buildRenovateCustomManagers,
  computePinDigests,
  extractCurrentPinValue,
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

    // Unregistered repo scan fails cleanly AND clears scanStarted (no 30-min lockout).
    const unregistered = await scanShipQueueDepsRepo(
      { queueRoot, nowEpochSec: () => now },
      { repo: "realrepo" },
    );
    expect(unregistered.ok).toBe(false);

    // Register primary and immediately re-scan -> succeeds without lockout!
    NodeFS.mkdirSync(NodePath.join(queueRoot, "repos", "realrepo"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(queueRoot, "repos", "realrepo", "primary"), `${primary}\n`);

    const scan1 = await scanShipQueueDepsRepo(
      { queueRoot, nowEpochSec: () => now + 5 },
      { repo: "realrepo" },
    );
    expect(scan1.ok).toBe(true);
    expect(scan1.skipped).toBe(false);
    expect(scan1.report?.status).toBe("clean");
    expect(scan1.report?.files["package.json"]).toMatch(/^[0-9a-f]{64}$/);

    // Push a manifest change to origin/main -> next scan detects real drift as 'pending'.
    NodeFS.writeFileSync(
      NodePath.join(primary, "package.json"),
      JSON.stringify({ name: "demo", dependencies: { vitest: "4.1.0" } }),
    );
    await git(primary, ["add", "package.json"]);
    await git(primary, ["commit", "-m", "bump"]);
    await git(primary, ["push", "origin", "main"]);

    const scan2 = await scanShipQueueDepsRepo(
      { queueRoot, nowEpochSec: () => now + 10 },
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

  it("scans due repos on cadence via scanDueDepsRepos and admits clean reports through evaluateDepsGate", async () => {
    const queueRoot = mkTempDir("sq-deps-scan-");
    NodeFS.mkdirSync(NodePath.join(queueRoot, "repos", "alpha"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(queueRoot, "repos", "alpha", "primary"), "/tmp/alpha\n");

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
    expect(pass1.scanned).toEqual(["alpha"]);
    expect(pass1.skipped).toEqual([]);

    // Immediate second pass skips because interval hasn't elapsed.
    const pass2 = await scanDueDepsRepos({
      queueRoot,
      nowEpochSec: () => now + 60,
      runRepoScan,
    });
    expect(pass2.scanned).toEqual([]);
    expect(pass2.skipped).toEqual(["alpha"]);

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
    expect(scans).toBe(2);
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

    const sampleHostsObj = JSON.parse(
      NodeFS.readFileSync(
        NodePath.join(repoRoot, "infra", "ci-host", "ci-hosts.example.json"),
        "utf8",
      ),
    ) as { toolchain: Record<string, unknown> };
    const singleLineVpManifest = `{\n  "vp": ${JSON.stringify(sampleHostsObj.toolchain.vp)}\n}`;
    expect(extractCurrentPinValue(singleLineVpManifest, vpPin!)).toBe("0.1.18");

    const digests = computePinDigests(
      { "infra/ci-host/ci-hosts.json": singleLineVpManifest },
      spec,
    );
    expect(digests["pin:vp"]).toMatch(/^[0-9a-f]{64}$/);

    const managers = buildRenovateCustomManagers(spec);
    expect(managers).toHaveLength(spec.pins.length);
    expect(managers.some((m) => m.depNameTemplate === "voidzero-dev/vite-plus")).toBe(true);
  });
});
