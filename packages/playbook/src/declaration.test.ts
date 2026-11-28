// @effect-diagnostics nodeBuiltinImport:off - Declaration loader tests over real temp checkouts.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { normalizeExceptions } from "./bypass.ts";
import { runCheck } from "./checks.ts";
import { loadDeclaration, parseDeclarationText, validateDeclaration } from "./declaration.ts";
import { repoName } from "./git.ts";
import { declarationRatchet } from "./ratchet.ts";
import { portableRegexProblem } from "./declarationSchema.ts";
import { readPlaybookDeclaration } from "./declarationSummary.ts";
import { parseStrictJson } from "./strictJson.ts";
import {
  cleanupTempDirs,
  evidenceDeclaration,
  FIXED_TODAY,
  fixturePlaybookMd,
  makeFixtureRepo,
  NO_BROKER_ENV,
} from "./testing/fixtureRepo.ts";

afterEach(cleanupTempDirs);

describe("strict JSON", () => {
  it("refuses a key repeated in one object, at any depth", () => {
    expect(() => parseStrictJson('{"a": 1, "a": 2}')).toThrow(/duplicate key "a"/);
    expect(() => parseStrictJson('{"x": {"b": 1, "c": {"b": 2}, "b": 3}}')).toThrow(/"b"/);
    expect(
      parseStrictJson('{"a": {"k": 1}, "b": {"k": 2}, "s": "{\\"k\\": 1, \\"k\\": 2}"}'),
    ).toEqual({
      a: { k: 1 },
      b: { k: 2 },
      s: '{"k": 1, "k": 2}',
    });
  });
});

describe("playbook.json parsing", () => {
  it("accepts the evidence-only declaration and names every schema problem by path", () => {
    expect(validateDeclaration(evidenceDeclaration())).toEqual([]);
    expect(
      validateDeclaration(
        evidenceDeclaration(
          {},
          {
            tools: ["node@22"],
            settings: { web: ["pnpm"] },
            doppler: ["demo/ci"],
            arch: ["x86_64"],
            evidence: ["artifacts/logs"],
            parallel: 4,
            granularThresholdMs: 30_000,
            maxTier1Ms: 60_000,
          },
        ),
      ),
    ).toEqual([]);
    const errors = validateDeclaration({
      contracts: {
        size: { bogus: true },
        tools: { exceptions: [{ subject: "a.ts", reason: "short", issue: "bad" }] },
      },
    });
    expect(errors.some((e) => e.startsWith("contracts.size: unknown key 'bogus'"))).toBe(true);
    expect(errors.some((e) => e.includes("contracts.tools.exceptions[0].issue"))).toBe(true);
  });

  it("refuses retired keys, baselines, and self-checking commands in head but drops them from base", () => {
    const text = JSON.stringify({
      version: 6,
      contracts: {
        ...evidenceDeclaration().contracts,
        size: { command: "x", baseline: "config/size-baseline.json", limit: 400 },
      },
    });
    const head = parseDeclarationText(text);
    expect(head.errors.some((e) => e.startsWith("version: the version pin is removed"))).toBe(true);
    expect(head.errors.some((e) => e.includes("baselines are removed"))).toBe(true);
    expect(head.errors.some((e) => e.startsWith("contracts.size.command:"))).toBe(true);
    const base = parseDeclarationText(text, { base: true });
    expect(base.errors).toEqual([]);
    expect(base.data?.version).toBeUndefined();
  });

  it("reports duplicate keys and bad JSON as not valid JSON", () => {
    expect(parseDeclarationText('{"contracts": {}, "contracts": {}}').errors[0]).toMatch(
      /^not valid JSON: duplicate key/,
    );
    expect(parseDeclarationText("{").data).toBeNull();
  });

  it("loads the real worktree's file and refuses a symlinked declaration", () => {
    const repo = makeFixtureRepo();
    expect(loadDeclaration(repo.root).errors).toEqual(["playbook.json is missing"]);
    repo.writeJson("real.json", evidenceDeclaration());
    NodeFS.symlinkSync("real.json", NodePath.join(repo.root, "playbook.json"));
    expect(loadDeclaration(repo.root).errors).toEqual(["playbook.json is not a regular file"]);
    NodeFS.unlinkSync(NodePath.join(repo.root, "playbook.json"));
    repo.writeJson("playbook.json", evidenceDeclaration());
    const decl = loadDeclaration(repo.root);
    expect(decl.errors).toEqual([]);
    expect(Object.keys((decl.data?.contracts ?? {}) as object)).toContain("size");
  });

  it("flags regexes that do not read the same in every engine", () => {
    expect(portableRegexProblem("^src/[a-z]+\\.ts$")).toBeNull();
    expect(portableRegexProblem("\\d+")).toMatch(/not an ERE escape/);
    expect(portableRegexProblem("(?:a)")).toMatch(/not ERE/);
    expect(portableRegexProblem("a+?")).toMatch(/lazy/);
  });
});

describe("declaration view", () => {
  it("summarizes contracts, evidence paths, scoped exception counts, and waived sections", () => {
    const repo = makeFixtureRepo();
    repo.writeJson(
      "playbook.json",
      evidenceDeclaration({
        size: {
          evidence: ".playbook/evidence/size.json",
          exceptions: [
            { subject: "a.ts", reason: "Cohesive parser state machine", issue: "#7" },
            { subject: "b.ts", reason: "Cohesive wire protocol codec", issue: "#7" },
          ],
        },
      }),
    );
    repo.write("playbook/PLAYBOOK.md", fixturePlaybookMd());
    const waivers = normalizeExceptions({
      repos: { "sample-repo": { playbook: { tools: "until acme-fixture#12 lands 2026-12-01" } } },
    });
    const view = readPlaybookDeclaration(repo.root, waivers);
    expect(view.hasPlaybookJson).toBe(true);
    expect(view.declarationErrors).toEqual([]);
    const size = view.contracts.find((c) => c.name === "size");
    expect(size).toMatchObject({
      evidencePath: ".playbook/evidence/size.json",
      exceptionCount: 2,
      status: "enforced",
    });
    expect(view.contracts.find((c) => c.name === "tools")?.status).toBe("waived");
    expect(view.rules.find((r) => r.section === 3)).toMatchObject({
      status: "enforced",
      detail: "2 exception(s)",
    });
    expect(view.rules.find((r) => r.section === 13)).toMatchObject({ status: "waived" });
    expect(view.rules.find((r) => r.section === 7)?.status).toBe("not-declared");
  });
});

describe("retired playbook 7 settings", () => {
  /** Every contract setting the playbook 7 schema declares that the playbook 8 schema refuses. */
  const V7_SETTINGS: Readonly<Record<string, ReadonlyArray<string>>> = {
    size: ["exempt"],
    tools: ["python_external", "knip_env"],
    dictionary: ["markdown", "protection"],
    migrations: ["code", "list", "name", "protection", "scripts", "truncate"],
    actions: [
      "chokepoint",
      "held_back",
      "source",
      "ledger",
      "floors",
      "walks",
      "closure",
      "measuredBy",
      "tests",
    ],
    design: [
      "tokens",
      "ui",
      "interactive",
      "style_properties",
      "slots",
      "slot_calls",
      "system",
      "client",
      "content_values",
      "touch_calls",
      "chokepoint",
    ],
    optimization: ["receipts", "measuredBy"],
    docs: ["user_triggers", "admin_triggers", "demo"],
  };
  const evidenceOnly = () =>
    Object.fromEntries(
      Object.keys(V7_SETTINGS).map((c) => [c, { evidence: `.playbook/evidence/${c}.json` }]),
    );
  const v7Declaration = () =>
    evidenceDeclaration(
      Object.fromEntries(
        Object.entries(V7_SETTINGS).map(([contract, keys]) => [
          contract,
          {
            evidence: `.playbook/evidence/${contract}.json`,
            ...Object.fromEntries(keys.map((k) => [k, `v7 ${k}`])),
          },
        ]),
      ),
    );

  it("refuses each in a branch by name, and drops each from a base", () => {
    const text = JSON.stringify(v7Declaration());
    const head = parseDeclarationText(text);
    for (const [contract, keys] of Object.entries(V7_SETTINGS)) {
      for (const key of keys) {
        expect(head.errors.some((e) => e.startsWith(`contracts.${contract}.${key}: `))).toBe(true);
      }
    }
    expect(head.errors.filter((e) => e.includes("unknown key"))).toEqual([]);
    expect(parseDeclarationText(text, { base: true }).errors).toEqual([]);
  });

  it("retires v7's object-form actions.evidence but keeps the v8 receipt path", () => {
    const v7 = { contracts: { actions: { evidence: { run: "pnpm test:actions", tests: ["a"] } } } };
    const head = parseDeclarationText(JSON.stringify(v7));
    expect(head.errors.some((e) => e.startsWith("contracts.actions.evidence: the v7"))).toBe(true);
    expect(parseDeclarationText(JSON.stringify(v7), { base: true }).errors).toEqual([]);
    const v8 = { contracts: { actions: { evidence: ".playbook/evidence/actions.json" } } };
    expect(
      parseDeclarationText(JSON.stringify(v8)).errors.filter((e) => e.includes("actions.evidence")),
    ).toEqual([]);
  });

  it("never counts removing them as a loosening", async () => {
    const base = parseDeclarationText(JSON.stringify(v7Declaration()), { base: true }).data!;
    expect(declarationRatchet(evidenceDeclaration(evidenceOnly()), base).problems).toEqual([]);

    const repo = makeFixtureRepo();
    repo.writeJson("playbook.json", v7Declaration());
    const baseSha = repo.commit("a playbook 7 base");
    repo.branch("feat/131-retire");
    repo.writeJson("playbook.json", evidenceDeclaration(evidenceOnly()));
    repo.commit("drop the retired settings");
    const asked: string[] = [];
    const report = await runCheck({
      root: repo.root,
      repo: repoName(repo.root),
      contracts: ["size"],
      bypasses: {},
      today: FIXED_TODAY,
      base: { sha: baseSha, name: "trunk", problem: null },
      env: NO_BROKER_ENV,
      override: async (reason) => {
        asked.push(reason);
        return false;
      },
    });
    expect(asked).toEqual([]);
    expect(report.results.find((r) => r.check === "ratchet")).toMatchObject({
      status: "PASS",
      summary: "playbook.json only tightens",
    });
  });
});
