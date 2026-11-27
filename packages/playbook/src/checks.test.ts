import { starterShape } from "@t3tools/fleet";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { runCheck } from "./checks.ts";
import { gateBase, repoName, showFiles } from "./git.ts";
import {
  cleanupTempDirs,
  evidenceDeclaration,
  FIXED_TODAY,
  makeFixtureRepo,
  NO_BROKER_ENV,
  writeEvidence,
} from "./testing/fixtureRepo.ts";

afterEach(cleanupTempDirs);

function repoWithBase(extra: object = {}, ci?: object) {
  const repo = makeFixtureRepo();
  repo.writeJson("playbook.json", evidenceDeclaration(extra, ci));
  repo.writeJson("fleet.json", starterShape("sample-repo"));
  repo.write("src/a.ts", "export const a = 1;\n");
  const base = repo.commit("base");
  repo.branch("feat/change");
  return { repo, base };
}

const check = (root: string, base: string, over: Partial<Parameters<typeof runCheck>[0]> = {}) =>
  runCheck({
    root,
    repo: repoName(root),
    bypasses: {},
    today: FIXED_TODAY,
    base: { sha: base, name: "trunk", problem: null },
    env: NO_BROKER_ENV,
    ...over,
  });

const statusOf = (report: Awaited<ReturnType<typeof runCheck>>, name: string) =>
  report.results.find((r) => r.check === name)?.status;

describe("playbook check (evidence-only) on a real worktree", () => {
  it("names the fixture repo by its origin and finds the queue's base", () => {
    const { repo, base } = repoWithBase();
    expect(repoName(repo.root)).toBe("sample-repo");
    expect(gateBase(repo.root, { SHIP_QUEUE_BASE_SHA: base }).sha).toBe(base);
    expect(gateBase(repo.root, {}).problem).toMatch(/origin\/HEAD is not set/);
  });

  it("reads many blobs in one batch, missing ones as null", () => {
    const { repo, base } = repoWithBase();
    repo.write("src/a.ts", "export const a = 2; // é\n");
    const tip = repo.commit("edit");
    const blobs = showFiles(repo.root, [`${base}:src/a.ts`, `${tip}:src/a.ts`, `${tip}:nope.ts`]);
    expect([...blobs.entries()]).toEqual([
      [`${base}:src/a.ts`, "export const a = 1;\n"],
      [`${tip}:src/a.ts`, "export const a = 2; // é\n"],
      [`${tip}:nope.ts`, null],
    ]);
  });

  it("passes every declared contract when valid tree-bound evidence receipts exist", async () => {
    const { repo, base } = repoWithBase({}, { evidence: ".playbook/evidence/ci.json" });
    writeEvidence(repo, "size");
    writeEvidence(repo, "fleet");
    writeEvidence(repo, "tools");
    writeEvidence(repo, "ci");
    const report = await check(repo.root, base);
    expect(statusOf(report, "declaration")).toBe("PASS");
    expect(statusOf(report, "ratchet")).toBe("PASS");
    expect(statusOf(report, "size")).toBe("PASS");
    expect(statusOf(report, "tools")).toBe("PASS");
    expect(statusOf(report, "fleet")).toBe("PASS");
    expect(statusOf(report, "generations")).toBe("PASS");
    expect(statusOf(report, "optimization")).toBe("PASS");
    expect(statusOf(report, "ci")).toBe("PASS");
    expect(report.exitCode).toBe(0);
    const sizeOnly = await check(repo.root, base, { contracts: ["size", "tools"] });
    expect(sizeOnly.exitCode).toBe(0);
  });

  it("fails a declaration that loosens against the base unless the owner overrides", async () => {
    const { repo, base } = repoWithBase();
    const head = evidenceDeclaration();
    const { optimization: _dropped, ...rest } = head.contracts;
    repo.writeJson("playbook.json", {
      evidenceDir: head.evidenceDir,
      contracts: rest,
      ci: head.ci,
    });
    repo.commit("drop optimization");
    writeEvidence(repo, "size");
    const refused = await check(repo.root, base, { contracts: ["size"] });
    expect(refused.results.find((r) => r.check === "ratchet")).toMatchObject({
      status: "FAIL",
      summary: "contract optimization removed",
    });
    expect(refused.exitCode).toBe(1);
    const asked: string[] = [];
    const granted = await check(repo.root, base, {
      contracts: ["size"],
      override: async (reason) => {
        asked.push(reason);
        return true;
      },
    });
    expect(asked).toEqual(["ratchet: contract optimization removed"]);
    expect(statusOf(granted, "ratchet")).toBe("PASS");
  });

  it("fails when a repo's evidence receipt reports a failing check", async () => {
    const { repo, base } = repoWithBase();
    writeEvidence(repo, "tools", {
      status: "fail",
      checks: [
        { name: "lint", status: "pass", durationMs: 50 },
        { name: "typecheck", status: "fail", durationMs: 110, detail: "broken type in src/a.ts" },
      ],
    });
    const report = await check(repo.root, base, { contracts: ["tools"] });
    expect(report.results.find((r) => r.check === "tools")).toMatchObject({
      status: "FAIL",
      errors: ["check 'typecheck' failed: broken type in src/a.ts"],
    });
  });

  it("requires every contract change to be declared under ## Contract Intent", async () => {
    const { repo, base } = repoWithBase({
      intent: { contracts: { surface: "config/contracts/feature-surfaces.json" } },
    });
    repo.writeJson("config/contracts/feature-surfaces.json", {
      routes: { "/v1/rooms": { methods: ["POST"], domain: "rooms", apiFile: "src/rooms.ts" } },
    });
    repo.commit("add a route");
    const noBody = await check(repo.root, base, { contracts: ["intent"], body: null });
    expect(statusOf(noBody, "intent")).toBe("UNPROVEN");
    const undeclared = await check(repo.root, base, {
      contracts: ["intent"],
      body: "## Summary\nx\n",
    });
    expect(undeclared.results.find((r) => r.check === "intent")?.errors[0]).toMatch(
      /^Undeclared contract change: ADD surface POST \/v1\/rooms/,
    );
    const declared = await check(repo.root, base, {
      contracts: ["intent"],
      body: "## Contract Intent\n- ADD surface POST /v1/rooms (members create rooms)\n",
    });
    expect(statusOf(declared, "intent")).toBe("PASS");
  });

  it("skips a waived contract and reports the owner's reason", async () => {
    const { repo, base } = repoWithBase();
    const report = await check(repo.root, base, {
      contracts: ["size"],
      bypasses: { size: "refactor tracked in acme-fixture#2" },
    });
    expect(report.results.find((r) => r.check === "size")?.summary).toBe(
      "bypassed by owner (refactor tracked in acme-fixture#2)",
    );
  });

  it("emits UNPROVEN for any contract or ci block omitted without an explicit opt-out (§1.2)", async () => {
    const repo = makeFixtureRepo();
    repo.writeJson("playbook.json", {
      contracts: { size: { evidence: ".playbook/evidence/size.json" } },
    });
    const base = repo.commit("base");
    writeEvidence(repo, "size");
    const report = await check(repo.root, base);
    expect(statusOf(report, "size")).toBe("PASS");
    expect(statusOf(report, "fleet")).toBe("UNPROVEN");
    expect(statusOf(report, "ci")).toBe("UNPROVEN");
    expect(report.exitCode).toBe(3);
  });

  it("fails an invalid declaration (including retired baseline/command) before any check runs", async () => {
    const { repo, base } = repoWithBase();
    repo.write("playbook.json", '{"contracts": {"size": {"baseline": "b.json"}}}');
    const report = await check(repo.root, base);
    expect(report.results).toHaveLength(1);
    expect(report.results[0]).toMatchObject({ check: "declaration", status: "FAIL" });
    expect(report.results[0]?.errors[0]).toContain("baselines are removed");
  });
});
