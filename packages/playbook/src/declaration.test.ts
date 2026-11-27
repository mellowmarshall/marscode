// @effect-diagnostics nodeBuiltinImport:off - Declaration loader tests over real temp checkouts.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { loadDeclaration, parseDeclarationText, validateDeclaration } from "./declaration.ts";
import { portableRegexProblem } from "./declarationSchema.ts";
import { readPlaybookDeclaration } from "./declarationSummary.ts";
import { normalizeExceptions } from "./bypass.ts";
import { parseStrictJson } from "./strictJson.ts";
import {
  cleanupTempDirs,
  declarationWithSize,
  fixturePlaybookMd,
  makeFixtureRepo,
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
  it("accepts the minimal declaration and names every schema problem by path", () => {
    expect(validateDeclaration(declarationWithSize({}))).toEqual([]);
    const errors = validateDeclaration({
      contracts: { size: { command: "x", bogus: true }, tools: { steps: [{ name: "Bad Name" }] } },
    });
    expect(errors.some((e) => e.startsWith("contracts.size: unknown key 'bogus'"))).toBe(true);
    expect(errors.some((e) => e.startsWith("contracts.tools.steps[0]: missing required key"))).toBe(
      true,
    );
  });

  it("refuses retired keys and settings in the branch but drops them from a base copy", () => {
    const text = JSON.stringify({
      version: 6,
      contracts: { ...declarationWithSize({}).contracts, size: { command: "x", limit: 400 } },
    });
    const head = parseDeclarationText(text);
    expect(head.errors.some((e) => e.startsWith("version: the version pin is removed"))).toBe(true);
    expect(head.errors.some((e) => e.startsWith("contracts.size.limit:"))).toBe(true);
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
    repo.writeJson("real.json", declarationWithSize({}));
    NodeFS.symlinkSync("real.json", NodePath.join(repo.root, "playbook.json"));
    expect(loadDeclaration(repo.root).errors).toEqual(["playbook.json is not a regular file"]);
    NodeFS.unlinkSync(NodePath.join(repo.root, "playbook.json"));
    repo.writeJson("playbook.json", declarationWithSize({}));
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
  it("summarizes contracts, Baselines and waived sections through the single loader", () => {
    const repo = makeFixtureRepo();
    repo.writeJson(
      "playbook.json",
      declarationWithSize({}, { intent: { contracts: { surface: "config/surface.json" } } }),
    );
    repo.writeJson("playbook.json", {
      contracts: {
        ...declarationWithSize({}).contracts,
        size: { command: "echo '{}'", baseline: "config/baselines/size.json" },
      },
    });
    repo.writeJson("config/baselines/size.json", {
      entries: [
        { rule: "size", file: "a.ts", lines: 600, issue: "#7", expires: "2027-01-31" },
        { rule: "size", file: "b.ts", lines: 700, issue: "#7", expires: "2026-12-31" },
      ],
    });
    repo.write("playbook/PLAYBOOK.md", fixturePlaybookMd());
    const waivers = normalizeExceptions({
      repos: { "sample-repo": { playbook: { tools: "until acme-fixture#12 lands 2026-12-01" } } },
    });
    const view = readPlaybookDeclaration(repo.root, waivers);
    expect(view.hasPlaybookJson).toBe(true);
    expect(view.declarationErrors).toEqual([]);
    const size = view.contracts.find((c) => c.name === "size");
    expect(size).toMatchObject({
      baselineCount: 2,
      nearestExpiry: "2026-12-31",
      status: "enforced",
    });
    expect(view.contracts.find((c) => c.name === "tools")?.status).toBe("waived");
    expect(view.rules.find((r) => r.section === 3)).toMatchObject({
      status: "enforced",
      detail: "baseline 2",
    });
    expect(view.rules.find((r) => r.section === 14)).toMatchObject({ status: "waived" });
    expect(view.rules.find((r) => r.section === 7)?.status).toBe("not-declared");
  });
});
