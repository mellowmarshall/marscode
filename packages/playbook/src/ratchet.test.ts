import { describe, expect, it } from "vite-plus/test";

import {
  baselineGrowth,
  expiredEntries,
  fingerprint,
  parseBaseline,
  tooFarEntries,
  type BaselineEntry,
} from "./baseline.ts";
import {
  bypassReason,
  exceptionChanges,
  normalizeExceptions,
  repoBypasses,
  sectionBypassReason,
  sectionRuleReasons,
} from "./bypass.ts";
import { loosenedDeclaration, reportedCommandChanges } from "./ratchet.ts";
import { declarationWithSize, FIXED_TODAY } from "./testing/fixtureRepo.ts";

const entry = (over: Partial<BaselineEntry> = {}): BaselineEntry => ({
  rule: "size",
  file: "src/big.ts",
  issue: "#7",
  expires: "2027-01-31",
  fingerprint: null,
  lines: 600,
  count: 1,
  value: null,
  ...over,
});

describe("declaration ratchet", () => {
  const base = declarationWithSize(
    {},
    {
      design: { client: ["apps/web/src", "apps/mobile/src"], tokens: "packages/ui/tokens.css" },
      intent: { contracts: { surface: "config/surface.json" } },
    },
  );

  it("passes a branch that only tightens or adopts a contract", () => {
    const head = declarationWithSize(
      {},
      {
        design: {
          client: ["apps/web/src", "apps/mobile/src", "apps/desktop/src"],
          tokens: "packages/ui/tokens.css",
        },
        intent: { contracts: { surface: "config/surface.json", fleet: "fleet-shape.json" } },
        migrations: { dir: "migrations" },
      },
    );
    expect(loosenedDeclaration(head, base)).toEqual([]);
  });

  it("refuses a removed contract, a dropped list item, a moved intent file and an opt-out", () => {
    const head = {
      contracts: {
        ...declarationWithSize({}).contracts,
        size: { none: "no source" },
        design: { client: ["apps/web/src"], tokens: "tokens.css" },
      },
    };
    const problems = loosenedDeclaration(head, base);
    expect(problems).toContain("contract intent removed");
    expect(problems).toContain("contract size opted out: the base declares it");
    expect(problems).toContain("design.client dropped: apps/mobile/src");
    expect(problems.some((p) => p.startsWith("design.tokens widened or moved"))).toBe(true);
  });

  it("reports the repo's own commands without refusing them", () => {
    const head = declarationWithSize({ "a.ts": 1 });
    expect(loosenedDeclaration(head, declarationWithSize({}))).toEqual([]);
    expect(reportedCommandChanges(head, declarationWithSize({}))).toEqual([
      `size.command: "echo '{}'" -> "echo '{\\"a.ts\\":1}'"`,
    ]);
  });

  it("treats a first Baseline as adoption and its removal as loosening", () => {
    const withBaseline = declarationWithSize({}, {});
    const head = {
      contracts: { ...withBaseline.contracts, size: { command: "echo '{}'", baseline: "b.json" } },
    };
    expect(loosenedDeclaration(head, withBaseline)).toEqual([]);
    expect(loosenedDeclaration(withBaseline, head)).toEqual([
      'size.baseline removed: "b.json" -> None',
    ]);
  });

  it("refuses a new size exempt place and a first allowlist that holds entries", () => {
    const head = {
      contracts: {
        ...declarationWithSize({}).contracts,
        size: {
          command: "echo '{}'",
          exempt: { "^vendor/": "third party" },
          allowlist: "allow.txt",
        },
      },
    };
    const problems = loosenedDeclaration(head, declarationWithSize({}), (rel) =>
      rel === "allow.txt" ? "# header\nsrc/a.ts#parse\n" : null,
    );
    expect(problems).toEqual([
      "size.allowlist added: allow.txt must start empty (1)",
      "size.exempt adds exempt place(s): ^vendor/ (the owner's call)",
    ]);
  });
});

describe("Baseline shrink-only ratchet", () => {
  it("parses entries and refuses malformed ones by field", () => {
    const parsed = parseBaseline(
      JSON.stringify({
        entries: [
          { rule: "size", file: "a.ts", lines: 600, issue: "#7", expires: "2027-01-31" },
          { rule: "size", file: "../x", lines: 1, issue: "7", expires: "2027-02-30" },
        ],
      }),
      "b.json",
    );
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.errors).toEqual([
      "b.json entries[1]: file '../x' must be repo-relative",
      "b.json entries[1]: issue '7' must look like #123",
      "b.json entries[1]: expires '2027-02-30' is not a real date",
    ]);
  });

  it("holds every entry to shrink-only against the base", () => {
    const base = [
      entry(),
      entry({
        rule: "design/raw",
        file: "ui.tsx",
        fingerprint: fingerprint("a  b"),
        lines: null,
        count: 2,
      }),
    ];
    const current = [
      entry({ lines: 650, expires: "2027-03-01", issue: "#8" }),
      entry({
        rule: "design/raw",
        file: "ui.tsx",
        fingerprint: fingerprint("a b"),
        lines: null,
        count: 3,
      }),
      entry({ file: "src/new.ts" }),
    ];
    expect(baselineGrowth(current, base, { adopting: false })).toEqual([
      "grew: src/big.ts [size] 600 -> 650 lines",
      "expiry moved later: src/big.ts [size] 2027-01-31 -> 2027-03-01",
      "issue changed: src/big.ts [size] #7 -> #8",
      "count grew: ui.tsx [design/raw] 2 -> 3",
      "added: src/new.ts [size] (#7, expires 2027-01-31)",
    ]);
    expect(baselineGrowth([entry({ lines: 550 })], base.slice(0, 1), { adopting: false })).toEqual(
      [],
    );
  });

  it("lets adoption add entries except for files new on the branch", () => {
    const added = baselineGrowth([entry({ file: "src/fresh.ts" }), entry()], [], {
      adopting: true,
      addedFiles: new Set(["src/fresh.ts"]),
    });
    expect(added).toEqual([
      "added: src/fresh.ts [size] (#7, expires 2027-01-31) (a brand-new file cannot be baselined)",
    ]);
  });

  it("finds expired entries and entries past the 180-day limit from a fixed today", () => {
    const entries = [
      entry({ expires: "2026-11-26" }),
      entry({ expires: "2027-05-26" }),
      entry({ expires: "2027-05-27" }),
    ];
    expect(expiredEntries(entries, FIXED_TODAY).map((e) => e.expires)).toEqual(["2026-11-26"]);
    expect(tooFarEntries(entries, FIXED_TODAY).map((e) => e.expires)).toEqual(["2027-05-27"]);
  });
});

describe("owner exceptions", () => {
  const data = {
    repos: {
      "*": { playbook: { maps: "no maps host-wide" } },
      "sample-repo": {
        playbook: {
          "§3": "size refactor tracked in #7",
          "10/The limit": "x",
          challenge: "owner said",
        },
        guards: "vendor exempt 2026-10-01 #3",
      },
    },
  };

  it("merges the wildcard repo and resolves sections, names and aliases", () => {
    const bp = repoBypasses(data, "Sample-Repo");
    expect(bypassReason(bp, "size")).toBe("size refactor tracked in #7");
    expect(bypassReason(bp, "13")).toBe("no maps host-wide");
    expect(bypassReason(bp, "declaration-challenge")).toBe("owner said");
    expect(bypassReason(bp, "tools")).toBeNull();
    expect(sectionBypassReason(bp, 3)).toBe("size refactor tracked in #7");
    expect(sectionRuleReasons(bp, 10, ["The limit", "Other"])).toEqual([["The limit", "x"]]);
  });

  it("flattens waivers for display with their dates and issue refs", () => {
    const flat = normalizeExceptions({ path: "/x", entries: data });
    expect(flat.find((w) => w.scope === "guards")).toMatchObject({
      repo: "sample-repo",
      date: "2026-10-01",
      issueRef: "#3",
    });
    expect(flat.filter((w) => w.scope === "playbook")).toHaveLength(4);
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
