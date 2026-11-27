// @effect-diagnostics nodeBuiltinImport:off - Tests for playbook-evidence/v1 validation, trust boundary, CI granular timing, and §3.1 split seams.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { runCheck } from "./checks.ts";
import { validateDeclaration } from "./declaration.ts";
import { DEFAULT_EVIDENCE_DIR, EVIDENCE_SCHEMA, validateSectionEvidence } from "./evidence.ts";
import {
  cleanupTempDirs,
  evidenceDeclaration,
  FIXED_TODAY,
  makeFixtureRepo,
  makeTempDir,
  NO_BROKER_ENV,
  writeEvidence,
} from "./testing/fixtureRepo.ts";

afterEach(cleanupTempDirs);

describe("playbook-evidence/v1 validation", () => {
  it("accepts stack-agnostic migrations (e.g. SurrealQL) via evidence without hardcoded enums", async () => {
    const repo = makeFixtureRepo();
    const decl = evidenceDeclaration({
      migrations: {
        engine: "surrealql",
        migrator: "surrealdb-migrate",
        dir: "db/migrations",
        evidence: ".playbook/evidence/migrations.json",
      },
    });
    expect(validateDeclaration(decl)).toEqual([]);
    repo.writeJson("playbook.json", decl);
    const base = repo.commit("base");
    repo.branch("feat/surreal");
    repo.write("db/migrations/001_init.surql", "DEFINE TABLE user SCHEMAFULL;\n");
    repo.commit("add surrealql migration");
    writeEvidence(repo, "migrations", {
      summary: "SurrealQL migrations linted and replayed",
      checks: [
        { name: "surrealql-destructive-lint", status: "pass", durationMs: 35 },
        { name: "surrealql-snapshot-replay", status: "pass", durationMs: 180 },
      ],
    });
    const report = await runCheck({
      root: repo.root,
      repo: "sample-repo",
      contracts: ["migrations"],
      bypasses: {},
      today: FIXED_TODAY,
      base: { sha: base, name: "trunk", problem: null },
      env: NO_BROKER_ENV,
    });
    expect(report.exitCode).toBe(0);
    expect(report.results.find((r) => r.check === "migrations")).toMatchObject({
      status: "PASS",
    });
  });

  it("fails closed when HEAD tree is missing, worktree has uncommitted tracked edits, or receipt is stale", () => {
    const emptyRepo = makeFixtureRepo();
    const scratch = makeTempDir("pb-empty-");
    NodeFS.writeFileSync(
      NodePath.join(scratch, "size.json"),
      JSON.stringify({
        schema: EVIDENCE_SCHEMA,
        section: "size",
        status: "pass",
        tree: "0000000000000000000000000000000000000000",
        checks: [{ name: "size", status: "pass", durationMs: 1 }],
      }),
    );
    const noHead = validateSectionEvidence({
      root: emptyRepo.root,
      section: "size",
      settings: {},
      evidenceDir: DEFAULT_EVIDENCE_DIR,
      env: { ...NO_BROKER_ENV, PLAYBOOK_EVIDENCE_DIR: scratch },
    });
    expect(noHead.status).toBe("UNPROVEN");
    expect(noHead.summary).toContain("cannot resolve HEAD^{tree}");

    const repo = makeFixtureRepo();
    repo.write(".gitignore", ".playbook/evidence/\n");
    repo.write("src/a.ts", "export const a = 1;\n");
    repo.commit("base");
    const missing = validateSectionEvidence({
      root: repo.root,
      section: "size",
      settings: {},
      evidenceDir: DEFAULT_EVIDENCE_DIR,
      env: NO_BROKER_ENV,
    });
    expect(missing.status).toBe("UNPROVEN");

    writeEvidence(repo, "size");
    repo.write("src/a.ts", "export const a = 2;\n");
    const dirty = validateSectionEvidence({
      root: repo.root,
      section: "size",
      settings: {},
      evidenceDir: DEFAULT_EVIDENCE_DIR,
      env: NO_BROKER_ENV,
    });
    expect(dirty.status).toBe("UNPROVEN");
    expect(dirty.summary).toContain("uncommitted tracked changes");

    repo.commit("change tree without refreshing evidence");
    const stale = validateSectionEvidence({
      root: repo.root,
      section: "size",
      settings: {},
      evidenceDir: DEFAULT_EVIDENCE_DIR,
      env: NO_BROKER_ENV,
    });
    expect(stale.status).toBe("UNPROVEN");
    expect(stale.summary).toContain("stale evidence");
  });

  it("enforces PLAYBOOK_EVIDENCE_DIR exclusivity over worktree receipts, CI trust boundary, and jobId", () => {
    const repo = makeFixtureRepo();
    repo.write("src/a.ts", "export const a = 1;\n");
    repo.commit("base");
    // Plant a forged PASS receipt at settings.evidence inside the worktree.
    writeEvidence(repo, "size", { status: "pass" }, ".playbook/forged-size.json");

    // Under CI / ship-queue without PLAYBOOK_EVIDENCE_DIR, worktree receipts are refused.
    const ciMissingEnv = validateSectionEvidence({
      root: repo.root,
      section: "size",
      settings: { evidence: ".playbook/forged-size.json" },
      evidenceDir: DEFAULT_EVIDENCE_DIR,
      env: { ...NO_BROKER_ENV, SHIP_QUEUE_JOB: "99" },
    });
    expect(ciMissingEnv.status).toBe("UNPROVEN");
    expect(ciMissingEnv.summary).toContain("PLAYBOOK_EVIDENCE_DIR is required");

    // PLAYBOOK_EVIDENCE_DIR inside the worktree is refused.
    const insideDir = NodePath.join(repo.root, ".playbook");
    const insideErr = validateSectionEvidence({
      root: repo.root,
      section: "size",
      settings: { evidence: ".playbook/forged-size.json" },
      evidenceDir: DEFAULT_EVIDENCE_DIR,
      env: { ...NO_BROKER_ENV, PLAYBOOK_EVIDENCE_DIR: insideDir },
    });
    expect(insideErr.status).toBe("UNPROVEN");
    expect(insideErr.summary).toContain("outside the repo worktree");

    // When PLAYBOOK_EVIDENCE_DIR is set outside the worktree, ONLY it is searched (worktree ignored).
    const trustedDir = makeTempDir("pb-trusted-");
    const missingInTrusted = validateSectionEvidence({
      root: repo.root,
      section: "size",
      settings: { evidence: ".playbook/forged-size.json" },
      evidenceDir: DEFAULT_EVIDENCE_DIR,
      env: { ...NO_BROKER_ENV, PLAYBOOK_EVIDENCE_DIR: trustedDir },
    });
    expect(missingInTrusted.status).toBe("UNPROVEN");

    NodeFS.writeFileSync(
      NodePath.join(trustedDir, "size.json"),
      JSON.stringify({
        schema: EVIDENCE_SCHEMA,
        section: "size",
        status: "fail",
        tree: repo.tree(),
        jobId: "job-77",
        checks: [{ name: "size", status: "fail", durationMs: 15, detail: "file over 500 LOC" }],
      }),
    );
    const trustedFail = validateSectionEvidence({
      root: repo.root,
      section: "size",
      settings: { evidence: ".playbook/forged-size.json" },
      evidenceDir: DEFAULT_EVIDENCE_DIR,
      env: { ...NO_BROKER_ENV, PLAYBOOK_EVIDENCE_DIR: trustedDir, PLAYBOOK_EVIDENCE_JOB: "job-77" },
    });
    expect(trustedFail.status).toBe("FAIL");
    expect(trustedFail.errors[0]).toContain("file over 500 LOC");

    const wrongJob = validateSectionEvidence({
      root: repo.root,
      section: "size",
      settings: {},
      evidenceDir: DEFAULT_EVIDENCE_DIR,
      env: { ...NO_BROKER_ENV, PLAYBOOK_EVIDENCE_DIR: trustedDir, PLAYBOOK_EVIDENCE_JOB: "job-88" },
    });
    expect(wrongJob.status).toBe("UNPROVEN");
    expect(wrongJob.summary).toContain("PLAYBOOK_EVIDENCE_JOB");

    // Tracked worktree receipt is refused.
    writeEvidence(repo, "tools");
    repo.commit("accidentally commit receipt");
    const tracked = validateSectionEvidence({
      root: repo.root,
      section: "tools",
      settings: {},
      evidenceDir: DEFAULT_EVIDENCE_DIR,
      env: NO_BROKER_ENV,
    });
    expect(tracked.status).toBe("FAIL");
    expect(tracked.summary).toContain("must not be committed to git");
  });

  it("rejects undeclared receipt exceptions and requires matching declared playbook.json exceptions", () => {
    const repo = makeFixtureRepo();
    repo.write("src/parser.ts", "export const p = 1;\n");
    repo.commit("base");
    writeEvidence(repo, "size", {
      exceptions: [
        {
          subject: "src/parser.ts",
          reason: "Cohesive recursive-descent parser with no clean domain seam",
          issue: "#42",
        },
      ],
    });
    const undeclared = validateSectionEvidence({
      root: repo.root,
      section: "size",
      settings: {},
      evidenceDir: DEFAULT_EVIDENCE_DIR,
      env: NO_BROKER_ENV,
    });
    expect(undeclared.status).toBe("FAIL");
    expect(undeclared.errors[0]).toContain("undeclared receipt exception 'src/parser.ts'");

    const mismatchIssue = validateSectionEvidence({
      root: repo.root,
      section: "size",
      settings: {
        exceptions: [{ subject: "src/parser.ts", reason: "Cohesive parser", issue: "#99" }],
      },
      evidenceDir: DEFAULT_EVIDENCE_DIR,
      env: NO_BROKER_ENV,
    });
    expect(mismatchIssue.status).toBe("FAIL");
    expect(mismatchIssue.errors[0]).toContain("does not match declared '#99'");

    const good = validateSectionEvidence({
      root: repo.root,
      section: "size",
      settings: {
        exceptions: [
          {
            subject: "src/parser.ts",
            reason: "Cohesive recursive-descent parser with no clean domain seam",
            issue: "#42",
          },
        ],
      },
      evidenceDir: DEFAULT_EVIDENCE_DIR,
      env: NO_BROKER_ENV,
    });
    expect(good.status).toBe("PASS");
    expect(good.summary).toContain("1 scoped exception(s)");
  });

  it("enforces §3.1 concrete domain seams and rejects generic utils/helpers/misc/common names", () => {
    const repo = makeFixtureRepo();
    repo.commit("base");
    for (const badSeam of ["", "utils", "helpers.ts", "misc", "common"]) {
      writeEvidence(repo, "size", {
        measurements: {
          splitFiles: [{ file: "src/engine.ts", seam: badSeam }],
        },
      });
      const res = validateSectionEvidence({
        root: repo.root,
        section: "size",
        settings: {},
        evidenceDir: DEFAULT_EVIDENCE_DIR,
        env: NO_BROKER_ENV,
      });
      expect(res.status).toBe("FAIL");
      expect(res.errors[0]).toContain("concrete domain seam");
    }

    writeEvidence(repo, "size", {
      measurements: {
        splitFiles: [
          {
            file: "src/engine.ts",
            seam: "SQL query builders (*Sql.ts) vs wire serializers (*Wire.ts)",
          },
        ],
      },
    });
    const good = validateSectionEvidence({
      root: repo.root,
      section: "size",
      settings: {},
      evidenceDir: DEFAULT_EVIDENCE_DIR,
      env: NO_BROKER_ENV,
    });
    expect(good.status).toBe("PASS");
  });

  it("enforces §14 granular substeps[], mandatory tier duration, tier ceilings, and durationMs honesty", () => {
    const repo = makeFixtureRepo();
    repo.commit("base");
    writeEvidence(repo, "ci", {
      checks: [{ name: "integration", status: "pass", durationMs: 45_000 }],
      measurements: { setupMs: 12_000, testMs: 33_000, selectedSuites: ["integration"] },
    });
    const missingSubstepsAndTier = validateSectionEvidence({
      root: repo.root,
      section: "ci",
      settings: {},
      evidenceDir: DEFAULT_EVIDENCE_DIR,
      env: NO_BROKER_ENV,
    });
    expect(missingSubstepsAndTier.status).toBe("FAIL");
    expect(
      missingSubstepsAndTier.errors.some((e) =>
        e.includes("without granular substeps[] breakdown"),
      ),
    ).toBe(true);
    expect(
      missingSubstepsAndTier.errors.some((e) => e.includes("at least one tier duration")),
    ).toBe(true);

    writeEvidence(repo, "ci", {
      durationMs: 100,
      checks: [
        { name: "lint", status: "pass", durationMs: 500 },
        { name: "test", status: "pass", durationMs: 800 },
      ],
      measurements: {
        setupMs: 200,
        testMs: 800,
        tier1Ms: 1_300,
        selectedSuites: ["unit"],
      },
    });
    const badTotal = validateSectionEvidence({
      root: repo.root,
      section: "ci",
      settings: {},
      evidenceDir: DEFAULT_EVIDENCE_DIR,
      env: NO_BROKER_ENV,
    });
    expect(badTotal.status).toBe("FAIL");
    expect(badTotal.errors[0]).toContain("less than slowest check");

    writeEvidence(repo, "ci", {
      durationMs: 600,
      checks: [
        { name: "a", status: "pass", durationMs: 500 },
        { name: "b", status: "pass", durationMs: 500 },
        { name: "c", status: "pass", durationMs: 500 },
      ],
      measurements: {
        setupMs: 100,
        testMs: 500,
        tier1Ms: 600,
        selectedSuites: ["unit"],
      },
    });
    const belowParallelBound = validateSectionEvidence({
      root: repo.root,
      section: "ci",
      settings: { parallel: 2 },
      evidenceDir: DEFAULT_EVIDENCE_DIR,
      env: NO_BROKER_ENV,
    });
    expect(belowParallelBound.status).toBe("FAIL");
    expect(belowParallelBound.errors[0]).toContain("physical lower bound 750ms for parallel=2");

    writeEvidence(repo, "ci", {
      durationMs: 45_000,
      checks: [
        {
          name: "integration",
          status: "pass",
          durationMs: 45_000,
          substeps: [
            { name: "compile", durationMs: 10_000 },
            { name: "db-snapshot-boot", durationMs: 2_000 },
            { name: "tests", durationMs: 33_000 },
          ],
        },
      ],
      measurements: {
        setupMs: 12_000,
        testMs: 33_000,
        selectedSuites: ["integration"],
        tier1Ms: 75_000,
      },
    });
    const overTier = validateSectionEvidence({
      root: repo.root,
      section: "ci",
      settings: { maxTier1Ms: 60_000 },
      evidenceDir: DEFAULT_EVIDENCE_DIR,
      env: NO_BROKER_ENV,
    });
    expect(overTier.status).toBe("FAIL");
    expect(overTier.errors[0]).toContain("tier1Ms (75000ms) exceeds ceiling 60000ms");

    writeEvidence(repo, "ci", {
      durationMs: 45_000,
      checks: [
        {
          name: "integration",
          status: "pass",
          durationMs: 45_000,
          substeps: [
            { name: "compile", durationMs: 10_000 },
            { name: "db-snapshot-boot", durationMs: 2_000 },
            { name: "tests", durationMs: 33_000 },
          ],
        },
      ],
      measurements: {
        setupMs: 12_000,
        testMs: 33_000,
        selectedSuites: ["integration"],
        tier1Ms: 45_000,
      },
    });
    const ok = validateSectionEvidence({
      root: repo.root,
      section: "ci",
      settings: { maxTier1Ms: 60_000 },
      evidenceDir: DEFAULT_EVIDENCE_DIR,
      env: NO_BROKER_ENV,
    });
    expect(ok.status).toBe("PASS");
  });

  it("supports combined evidence.json in PLAYBOOK_EVIDENCE_DIR and refuses symlink escape", () => {
    const repo = makeFixtureRepo();
    repo.commit("base");
    const scratch = makeTempDir("pb-ev-");
    NodeFS.writeFileSync(
      NodePath.join(scratch, "evidence.json"),
      JSON.stringify({
        schema: EVIDENCE_SCHEMA,
        tree: repo.tree(),
        sections: {
          tools: {
            status: "pass",
            checks: [{ name: "vp-lint", status: "pass", durationMs: 210 }],
          },
        },
      }),
    );
    const ok = validateSectionEvidence({
      root: repo.root,
      section: "tools",
      settings: {},
      evidenceDir: DEFAULT_EVIDENCE_DIR,
      env: { ...NO_BROKER_ENV, PLAYBOOK_EVIDENCE_DIR: scratch },
    });
    expect(ok.status).toBe("PASS");

    const outside = makeTempDir("pb-outside-");
    NodeFS.writeFileSync(NodePath.join(outside, "size.json"), "{}");
    NodeFS.mkdirSync(NodePath.join(repo.root, ".playbook", "evidence"), { recursive: true });
    NodeFS.symlinkSync(
      NodePath.join(outside, "size.json"),
      NodePath.join(repo.root, ".playbook", "evidence", "size.json"),
    );
    const escaped = validateSectionEvidence({
      root: repo.root,
      section: "size",
      settings: {},
      evidenceDir: DEFAULT_EVIDENCE_DIR,
      env: NO_BROKER_ENV,
    });
    expect(escaped.status).toBe("UNPROVEN");
  });
});
