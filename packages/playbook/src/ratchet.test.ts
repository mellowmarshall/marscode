import { describe, expect, it } from "vite-plus/test";

import {
  bypassReason,
  exceptionChanges,
  normalizeExceptions,
  repoBypasses,
  sectionBypassReason,
  sectionRuleReasons,
} from "./bypass.ts";
import { declarationRatchet, reportedCommandChanges } from "./ratchet.ts";
import { evidenceDeclaration } from "./testing/fixtureRepo.ts";

const loosenedDeclaration = (...args: Parameters<typeof declarationRatchet>) =>
  declarationRatchet(...args).problems;

describe("declaration ratchet", () => {
  const base = evidenceDeclaration(
    {
      design: { evidence: ".playbook/evidence/design.json", choke: "packages/ui" },
      intent: { contracts: { surface: "config/surface.json" } },
    },
    {
      evidence: ".playbook/evidence/ci.json",
      parallel: 4,
      granularThresholdMs: 30_000,
      maxTier1Ms: 60_000,
      full: ["pnpm-lock.yaml"],
    },
  );

  it("passes a branch that only tightens, adopts, or removes scoped exceptions", () => {
    const head = evidenceDeclaration(
      {
        design: { evidence: ".playbook/evidence/design.json", choke: "packages/ui" },
        intent: { contracts: { surface: "config/surface.json", fleet: "fleet-shape.json" } },
        migrations: { engine: "surrealql", dir: "migrations" },
      },
      {
        evidence: ".playbook/evidence/ci.json",
        parallel: 8,
        granularThresholdMs: 25_000,
        maxTier1Ms: 50_000,
        full: ["pnpm-lock.yaml"],
      },
    );
    expect(loosenedDeclaration(head, base)).toEqual([]);
  });

  it("refuses removed contracts, opt-outs, moved intent files, added exceptions, and loosened CI bounds", () => {
    const { intent: _removed, ...withoutIntent } = evidenceDeclaration().contracts;
    const head = {
      contracts: {
        ...withoutIntent,
        size: { none: "no source files at all" },
        design: {
          evidence: ".playbook/evidence/design.json",
          exceptions: [{ subject: "raw.tsx", reason: "temporary raw button", issue: "#9" }],
        },
      },
      ci: {
        evidence: ".playbook/evidence/ci.json",
        parallel: 2,
        granularThresholdMs: 60_000,
        maxTier1Ms: 90_000,
        full: [],
      },
    };
    const problems = loosenedDeclaration(head, base);
    expect(problems).toContain("contract intent removed");
    expect(problems).toContain("contract size opted out: the base declares it");
    expect(
      problems.some((p) => p.includes("design.exceptions adds scoped exception 'raw.tsx'")),
    ).toBe(true);
    expect(problems.some((p) => p.includes("ci.parallel lowered"))).toBe(true);
    expect(problems.some((p) => p.includes("ci.granularThresholdMs loosened"))).toBe(true);
    expect(problems.some((p) => p.includes("ci.maxTier1Ms loosened"))).toBe(true);
    expect(problems.some((p) => p.includes("ci.full removed trigger(s): pnpm-lock.yaml"))).toBe(
      true,
    );
  });

  it("reports evidence path changes without refusing them", () => {
    const head = evidenceDeclaration({ size: { evidence: ".playbook/custom-size.json" } });
    expect(loosenedDeclaration(head, evidenceDeclaration())).toEqual([]);
    expect(reportedCommandChanges(head, evidenceDeclaration())).toEqual([
      'size.evidence: ".playbook/evidence/size.json" -> ".playbook/custom-size.json"',
    ]);
  });

  it("refuses a first size allowlist that already holds entries and catches growth on an existing allowlist", () => {
    const head = evidenceDeclaration({
      size: { evidence: ".playbook/evidence/size.json", allowlist: "allow.txt" },
    });
    const first = loosenedDeclaration(head, evidenceDeclaration(), (rel) =>
      rel === "allow.txt" ? "# header\nsrc/a.ts#parse\n" : null,
    );
    expect(first).toEqual(["size.allowlist added: allow.txt must start empty (1)"]);

    const missingOrSymlink = loosenedDeclaration(head, evidenceDeclaration(), () => null);
    expect(missingOrSymlink).toEqual([
      "size.allowlist added: 'allow.txt' is missing, unreadable, or a symlink (§3.2)",
    ]);

    const grown = loosenedDeclaration(
      head,
      head,
      (rel) => (rel === "allow.txt" ? "src/a.ts\nsrc/b.ts\n" : null),
      (rel) => (rel === "allow.txt" ? "src/a.ts\n" : null),
    );
    expect(grown).toEqual(["size.allowlist added 1 entry(ies): src/b.ts (§3.2)"]);

    const shrunk = loosenedDeclaration(
      head,
      head,
      (rel) => (rel === "allow.txt" ? "src/a.ts\n" : null),
      (rel) => (rel === "allow.txt" ? "src/a.ts\nsrc/b.ts\n" : null),
    );
    expect(shrunk).toEqual([]);
  });

  it("refuses ci.always gate removals and ci.select changes", () => {
    const ciBase = evidenceDeclaration(
      {},
      {
        evidence: ".playbook/evidence/ci.json",
        always: ["lint", "typecheck"],
        select: { "packages/a": ["test:a"] },
      },
    );
    const ciHead = evidenceDeclaration(
      {},
      {
        evidence: ".playbook/evidence/ci.json",
        always: ["lint"],
        select: { "packages/a": [] },
      },
    );
    const problems = loosenedDeclaration(ciHead, ciBase);
    expect(problems).toContain("ci.always removed mandatory gate(s): typecheck (§14.2)");
    expect(problems.some((p) => p.startsWith("ci.select changed:"))).toBe(true);

    const addedSelect = loosenedDeclaration(
      evidenceDeclaration({}, { evidence: ".playbook/evidence/ci.json", select: "scripts/sel.sh" }),
      evidenceDeclaration({}, { evidence: ".playbook/evidence/ci.json" }),
    );
    expect(addedSelect.some((p) => p.startsWith("ci.select changed:"))).toBe(true);
  });
});

describe("owner exceptions", () => {
  const data = {
    repos: {
      "*": { playbook: { maps: "no maps host-wide" } },
      "sample-repo": {
        playbook: {
          "§3": "size refactor tracked in #7",
          "9/Repo evidence": "x",
          "14": "legacy numeric waiver must not silently waive ci",
          challenge: "owner said",
        },
        guards: "vendor exempt 2026-10-01 #3",
      },
    },
  };

  it("merges the wildcard repo, resolves names/aliases, and refuses bare renumbered numeric keys 12..15", () => {
    const bp = repoBypasses(data, "Sample-Repo");
    expect(bypassReason(bp, "size")).toBe("size refactor tracked in #7");
    expect(bypassReason(bp, "12")).toBe("no maps host-wide");
    expect(bypassReason(bp, "declaration-challenge")).toBe("owner said");
    expect(bypassReason(bp, "tools")).toBeNull();
    expect(bypassReason(bp, "ci")).toBeNull();
    expect(sectionBypassReason(bp, 14)).toBeNull();
    expect(sectionBypassReason(bp, 3)).toBe("size refactor tracked in #7");
    expect(sectionRuleReasons(bp, 9, ["Repo evidence", "Other"])).toEqual([["Repo evidence", "x"]]);
  });

  it("flattens waivers for display with their dates and issue refs", () => {
    const flat = normalizeExceptions({ path: "/x", entries: data });
    expect(flat.find((w) => w.scope === "guards")).toMatchObject({
      repo: "sample-repo",
      date: "2026-10-01",
      issueRef: "#3",
    });
    expect(flat.filter((w) => w.scope === "playbook")).toHaveLength(5);
  });

  it("holds an added or changed exception value for the owner, never a removal", () => {
    const base = { repos: { a: { playbook: { size: "r1", tools: "r2" } } } };
    const head = { repos: { a: { playbook: { size: "r1 changed" } }, b: { guards: "new" } } };
    expect(exceptionChanges(head, base)).toEqual([
      'repos.a.playbook.size: "r1" -> "r1 changed"',
      'repos.b.guards: null -> "new"',
    ]);
    expect(exceptionChanges({ repos: { a: { playbook: { size: "r1" } } } }, base)).toEqual([]);
  });
});
