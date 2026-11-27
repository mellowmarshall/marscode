import { starterShape } from "@t3tools/fleet";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { runCheck } from "./checks.ts";
import { gateBase, repoName, showFiles } from "./git.ts";
import {
  cleanupTempDirs,
  declarationWithSize,
  FIXED_TODAY,
  makeFixtureRepo,
  NO_BROKER_ENV,
} from "./testing/fixtureRepo.ts";

afterEach(cleanupTempDirs);

function repoWithBase(extra: object = {}) {
  const repo = makeFixtureRepo();
  repo.writeJson("playbook.json", declarationWithSize({ "src/a.ts": 10 }, extra));
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

describe("playbook check on a real worktree", () => {
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

  it("passes every declared deterministic gate on a clean branch", async () => {
    const { repo, base } = repoWithBase();
    const report = await check(repo.root, base);
    expect(statusOf(report, "declaration")).toBe("PASS");
    expect(statusOf(report, "ratchet")).toBe("PASS");
    expect(statusOf(report, "size")).toBe("PASS");
    expect(statusOf(report, "tools")).toBe("PASS");
    expect(statusOf(report, "fleet")).toBe("PASS");
    expect(statusOf(report, "generations")).toBe("PASS");
    expect(statusOf(report, "optimization")).toBe("PASS");
    expect(report.exitCode).toBe(0);
    const sizeOnly = await check(repo.root, base, { contracts: ["size", "tools"] });
    expect(sizeOnly.exitCode).toBe(0);
  });

  it("fails a declaration that loosens against the base unless the owner overrides", async () => {
    const { repo, base } = repoWithBase();
    const head = declarationWithSize({ "src/a.ts": 10 });
    const { optimization: _dropped, ...rest } = head.contracts;
    repo.writeJson("playbook.json", { contracts: rest });
    repo.commit("drop optimization");
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

  it("holds files over 500 lines to their Baseline, which may only shrink", async () => {
    const { repo, base } = repoWithBase();
    repo.writeJson("playbook.json", declarationWithSize({ "src/a.ts": 10, "src/big.ts": 640 }));
    repo.commit("grow");
    const over = await check(repo.root, base, { contracts: ["size"] });
    expect(over.results.find((r) => r.check === "size")?.errors).toEqual([
      "src/big.ts: 640 code lines, over the 500-line limit",
    ]);
    repo.writeJson("playbook.json", {
      contracts: {
        ...declarationWithSize({ "src/a.ts": 10, "src/big.ts": 640 }).contracts,
        size: {
          command: `echo '${JSON.stringify({ "src/a.ts": 10, "src/big.ts": 640 })}'`,
          baseline: "config/baselines/size.json",
        },
      },
    });
    repo.writeJson("config/baselines/size.json", {
      entries: [
        { rule: "size", file: "src/big.ts", lines: 640, issue: "#7", expires: "2027-01-31" },
      ],
    });
    repo.commit("adopt a size Baseline");
    const held = await check(repo.root, base, { contracts: ["size"] });
    expect(statusOf(held, "size")).toBe("PASS");
    expect(statusOf(held, "baseline size")).toBe("PASS");
    const expired = await check(repo.root, base, { contracts: ["size"], today: "2027-02-01" });
    expect(expired.results.find((r) => r.check === "baseline size")?.summary).toBe(
      "1 expired, 0 past the 180-day limit",
    );
  });

  it("runs declared tool steps in the checkout and fails on a non-zero exit", async () => {
    const { repo, base } = repoWithBase();
    repo.writeJson(
      "playbook.json",
      declarationWithSize(
        { "src/a.ts": 10 },
        {
          tools: {
            steps: [
              { name: "lint", class: "lint", run: "test -f src/a.ts", languages: ["ts"] },
              {
                name: "typecheck",
                class: "typecheck",
                run: "echo broken >&2; exit 4",
                languages: ["ts"],
              },
            ],
          },
        },
      ),
    );
    repo.commit("steps");
    const report = await check(repo.root, base, { contracts: ["tools"] });
    expect(statusOf(report, "tools lint")).toBe("PASS");
    expect(report.results.find((r) => r.check === "tools typecheck")).toMatchObject({
      status: "FAIL",
      errors: ["broken"],
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
    repo.writeJson("playbook.json", declarationWithSize({ "src/a.ts": 900 }));
    repo.commit("over");
    const report = await check(repo.root, base, {
      contracts: ["size"],
      bypasses: { size: "refactor tracked in acme-fixture#2" },
    });
    expect(report.results.find((r) => r.check === "size")?.summary).toBe(
      "bypassed by owner (refactor tracked in acme-fixture#2)",
    );
  });

  it("fails an invalid declaration before any gate runs", async () => {
    const { repo, base } = repoWithBase();
    repo.write("playbook.json", '{"contracts": {"size": {"limit": 400}}}');
    const report = await check(repo.root, base);
    expect(report.results).toHaveLength(1);
    expect(report.results[0]).toMatchObject({ check: "declaration", status: "FAIL" });
  });
});
