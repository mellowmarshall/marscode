// @effect-diagnostics nodeBuiltinImport:off - Drives the real `playbook` bin with node:child_process over temp checkouts.
/**
 * The subcommands and flags the original playbook CLI accepts: each run through the real
 * bin (process.execPath on src/bin.ts) against a real temp git checkout.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { starterShape } from "@t3tools/fleet";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { classifyModel } from "./modelClassify.ts";
import { appendReviewStatRecord } from "./statsStore.ts";
import type { ReviewStatRecord } from "./statsTypes.ts";
import {
  cleanupTempDirs,
  evidenceDeclaration,
  fixturePlaybookMd,
  makeFixtureRepo,
  makeTempDir,
  NO_BROKER_ENV,
} from "./testing/fixtureRepo.ts";

afterEach(cleanupTempDirs);

const BIN = NodeURL.fileURLToPath(new URL("./bin.ts", import.meta.url));

interface Run {
  readonly code: number | null;
  readonly out: string;
  readonly err: string;
}

function playbook(cwd: string, args: ReadonlyArray<string>, env: NodeJS.ProcessEnv = {}): Run {
  const res = NodeChildProcess.spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...NO_BROKER_ENV, ...env },
  });
  return { code: res.status, out: res.stdout, err: res.stderr };
}

describe("playbook usage", () => {
  it("prints usage to stderr with exit 2 when no command is given, and takes -C DIR or -CDIR", () => {
    const dir = makeTempDir("pb-parity-");
    const none = playbook(dir, []);
    expect(none.code).toBe(2);
    expect(none.out).toBe("");
    expect(none.err).toContain("usage: playbook [-C DIR] <command>");
    expect(playbook(dir, ["help"]).code).toBe(0);
    const repo = makeFixtureRepo();
    expect(playbook(dir, [`-C${repo.root}`, "ci-files"]).code).toBe(0);
    expect(playbook(dir, ["-C", repo.root, "ci-files"]).code).toBe(0);
    expect(playbook(dir, [`-C${NodePath.join(dir, "missing")}`, "ci-files"]).code).toBe(2);
  });
});

describe("playbook minimal", () => {
  it("prints the minimal declaration on one line, merging --merge's contracts", () => {
    const dir = makeTempDir("pb-parity-");
    const plain = playbook(dir, ["minimal"]);
    expect(plain.code).toBe(0);
    expect(plain.out).toMatch(
      /^\{"evidenceDir": "\.playbook\/evidence", "contracts": \{"size": \{"evidence": "\.playbook\/evidence\/size\.json"\}, /,
    );
    expect(plain.out.trim().split("\n")).toHaveLength(1);
    const merged = playbook(dir, [
      "minimal",
      "--merge",
      '{"size": null, "fleet": {"file": "fleet.json"}, "docs": {"none": "no docs — yet"}}',
    ]);
    expect(merged.code).toBe(0);
    expect(merged.out).toContain('"docs": {"none": "no docs \\u2014 yet"}');
    const data = JSON.parse(merged.out) as { contracts: Record<string, unknown> };
    expect(data.contracts.size).toBeUndefined();
    expect(data.contracts.fleet).toEqual({
      none: "no deployed infrastructure yet",
      file: "fleet.json",
    });
    const bad = playbook(dir, ["minimal", "--merge", "{nope"]);
    expect(bad.code).toBe(2);
    expect(bad.err).toMatch(/^playbook: --merge is not JSON: /);
    expect(playbook(dir, ["minimal", "--merge", "[1]"]).code).toBe(2);
  });
});

describe("playbook check flags", () => {
  it("accepts --trigger's choices, refuses others, and refuses a --pr-body that is not a file", () => {
    const repo = makeFixtureRepo();
    repo.writeJson("playbook.json", evidenceDeclaration());
    repo.commit("base");
    const plain = playbook(repo.root, ["check", "size"]);
    for (const trigger of ["every", "paths", "full"]) {
      const r = playbook(repo.root, ["check", "size", "--trigger", trigger]);
      expect(r.code).toBe(plain.code);
      expect(r.out).toBe(plain.out);
    }
    const bad = playbook(repo.root, ["check", "--trigger", "sometimes"]);
    expect(bad.code).toBe(2);
    expect(bad.err).toContain("argument --trigger: invalid choice: 'sometimes'");
    const body = playbook(repo.root, ["check", "--pr-body", "nope.md"]);
    expect(body.code).toBe(2);
    expect(body.err).toBe("playbook: --pr-body nope.md is not a file\n");
  });
});

describe("playbook db-dict", () => {
  it("finds concepts, tables and columns, and exits 1 on no match and 2 with no dictionary", () => {
    const repo = makeFixtureRepo();
    const dir = makeTempDir("pb-parity-");
    expect(playbook(repo.root, ["db-dict", "email"]).code).toBe(2);
    repo.writeJson("playbook.json", { contracts: { dictionary: { file: "dict.json" } } });
    repo.writeJson("dict.json", {
      concepts: {
        "user.email": {
          canonicalType: "text",
          purpose: "where a member is reached",
          aliases: ["mail"],
        },
      },
      tables: {
        members: {
          purpose: "people who sign in",
          columns: {
            email: { type: "text", concept: "user.email", role: "primary", purpose: "login" },
            backup_email: { type: "text", concept: "user.email" },
          },
        },
      },
    });
    const r = playbook(repo.root, ["db-dict", "Email"]);
    expect(r.code).toBe(0);
    expect(r.out).toBe(
      [
        "concept user.email (text): where a member is reached aliases: mail; 2 column(s): members.email (role primary), members.backup_email",
        "column members.email text concept=user.email: login",
        "column members.backup_email text concept=user.email: ",
        "",
      ].join("\n"),
    );
    expect(playbook(repo.root, ["db-dict", "sign in"]).out).toBe(
      "table members: people who sign in\n",
    );
    const none = playbook(repo.root, ["db-dict", "invoice"]);
    expect(none.code).toBe(1);
    expect(none.out).toBe(
      "playbook db-dict: nothing in dict.json names 'invoice'; a new column needs a concept (-- schema-ok #N)\n",
    );
    expect(playbook(repo.root, ["db-dict"]).code).toBe(2);
    expect(playbook(dir, ["-C", repo.root, "db-dict", "mail"]).code).toBe(0);
  });
});

describe("playbook intent-diff and intent-audit", () => {
  function intentRepo() {
    const repo = makeFixtureRepo();
    repo.writeJson("playbook.json", {
      contracts: { intent: { contracts: { fleet: "fleet.json" } } },
    });
    const shape = starterShape("sample-repo") as { env: Record<string, unknown> };
    shape.env.LOG_LEVEL = { why: "how much the API logs", apps: [] };
    repo.writeJson("fleet.json", shape);
    const base = repo.commit("base");
    repo.branch("feat/env");
    shape.env.NEW_FLAG = { why: "turns the new flow on", apps: [] };
    shape.env.LOG_LEVEL = { why: "how much the API logs, per app", apps: [] };
    repo.writeJson("fleet.json", shape);
    return { repo, base, shape };
  }

  it("prints the contract changes against the base, with a MODIFY's fields", () => {
    const { repo, base } = intentRepo();
    const r = playbook(repo.root, ["intent-diff", "--base", "trunk"]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toBe(
      [
        'MODIFY fleet env.LOG_LEVEL (why: "how much the API logs" -> "how much the API logs, per app")',
        "ADD fleet env.NEW_FLAG",
        `intent-diff: 2 contract change(s) against ${base.slice(0, 12)}`,
        "",
      ].join("\n"),
    );
    const json = JSON.parse(playbook(repo.root, ["intent-diff", "--base", base, "--json"]).out);
    expect(json).toEqual({
      base,
      changes: [
        {
          action: "MODIFY",
          contract: "fleet",
          item: "env.LOG_LEVEL",
          fields: ['why: "how much the API logs" -> "how much the API logs, per app"'],
        },
        { action: "ADD", contract: "fleet", item: "env.NEW_FLAG", fields: [] },
      ],
    });
    expect(playbook(repo.root, ["intent-diff"], { SHIP_QUEUE_BASE_SHA: base }).out).toContain(
      "2 contract change(s)",
    );
  });

  it("exits 2 for an undeclared contract, a bad choice, and no base", () => {
    const { repo } = intentRepo();
    const surface = playbook(repo.root, [
      "intent-diff",
      "--base",
      "trunk",
      "--contract",
      "surface",
    ]);
    expect(surface.code).toBe(2);
    expect(surface.err).toBe(
      "playbook intent-diff: playbook.json declares no such intent contract (contracts.intent.contracts)\n",
    );
    expect(
      playbook(repo.root, ["intent-diff", "--contract", "walks", "--base", "trunk"]).code,
    ).toBe(2);
    const bad = playbook(repo.root, ["intent-diff", "--contract", "routes"]);
    expect(bad.code).toBe(2);
    expect(bad.err).toContain("argument --contract: invalid choice: 'routes'");
    const noBase = playbook(repo.root, ["intent-diff"]);
    expect(noBase.code).toBe(2);
    expect(noBase.err).toBe(
      "playbook intent-diff: no base to compare against (the gate base); git fetch origin\n",
    );
    expect(playbook(repo.root, ["intent-diff", "--base", "nope"]).err).toContain(
      "no base to compare against (nope)",
    );
  });

  it("records each declared change at the merged commit, and a mismatch with exit 1", () => {
    const { repo, base } = intentRepo();
    const merged = repo.commit("merge the env change");
    const state = makeTempDir("pb-parity-body-");
    const body = NodePath.join(state, "body.md");
    NodeFS.writeFileSync(
      body,
      "## Contract Intent\n- ADD fleet env.NEW_FLAG (turns the new flow on)\n- MODIFY fleet env.LOG_LEVEL (logs per app now)\n",
    );
    const ok = playbook(repo.root, [
      "intent-audit",
      "--base",
      base,
      "--merged",
      merged,
      "--body",
      body,
    ]);
    expect(ok.code, ok.err).toBe(0);
    expect(ok.out).toBe(
      [
        `contract-intent audit: MODIFY fleet env.LOG_LEVEL (logs per app now) merged=${merged}`,
        `contract-intent audit: ADD fleet env.NEW_FLAG (turns the new flow on) merged=${merged}`,
        `contract-intent audit: 2 record(s) at merged=${merged}`,
        "",
      ].join("\n"),
    );
    const viaEnv = playbook(repo.root, ["intent-audit", "--base", base, "--merged", merged], {
      SHIP_QUEUE_BODYFILE: body,
    });
    expect(viaEnv.out).toContain("2 record(s)");
    const mismatch = playbook(repo.root, ["intent-audit", "--base", base, "--merged", "HEAD"]);
    expect(mismatch.code).toBe(1);
    expect(mismatch.out).toContain(
      "contract-intent audit: MISMATCH Undeclared contract change: ADD fleet env.NEW_FLAG.",
    );
    expect(mismatch.out).toContain("contract-intent audit: 0 record(s) at merged=HEAD");
  });

  it("refuses missing arguments and a merged commit that does not exist, and records nothing undeclared", () => {
    const { repo, base } = intentRepo();
    const missing = playbook(repo.root, ["intent-audit", "--base", base]);
    expect(missing.code).toBe(2);
    expect(missing.err).toContain("the following arguments are required: --merged");
    const bad = playbook(repo.root, ["intent-audit", "--base", base, "--merged", "nope"]);
    expect(bad.code).toBe(2);
    expect(bad.err).toBe("playbook intent-audit: nope is not a commit here\n");
    repo.writeJson("playbook.json", evidenceDeclaration());
    const merged = repo.commit("no intent contracts");
    const none = playbook(repo.root, ["intent-audit", "--base", base, "--merged", merged]);
    expect(none.code).toBe(0);
    expect(none.out).toBe(
      "playbook intent-audit: the merged playbook.json declares no intent contracts; nothing to record\n",
    );
  });
});

describe("playbook ci-files", () => {
  it("follows the declared CI and merge steps' shell scripts at a commit", () => {
    const repo = makeFixtureRepo();
    repo.write(
      ".tree-guard.conf",
      "ship_ci=scripts/ship-steps.sh ci\nship_merge=pre-push\nship_merge=./scripts/merge.sh\n",
    );
    repo.write(
      "scripts/ship-steps.sh",
      [
        "#!/usr/bin/env bash",
        'ROOT="$(git rev-parse --show-toplevel)"',
        ". ./scripts/lib/common.sh",
        'case "$1" in',
        '  ci) bash scripts/ci-local.sh "$@" ;;',
        '  gate) "$ROOT/scripts/gate.sh" ;;',
        "esac",
        "# bash scripts/commented.sh",
        "node scripts/not-shell.mjs",
        "",
      ].join("\n"),
    );
    repo.write("scripts/lib/common.sh", "helper() { :; }\n");
    repo.write("scripts/ci-local.sh", "#!/bin/sh\nexec ./scripts/suite.bash\n");
    repo.write("scripts/suite.bash", "echo suite\n");
    repo.write("scripts/gate.sh", "echo gate\n");
    repo.write("scripts/merge.sh", "sh scripts/missing.sh\n");
    repo.write("scripts/commented.sh", "echo no\n");
    const first = repo.commit("ci scripts");
    repo.write("scripts/merge.sh", "sh scripts/later.sh\n");
    repo.write("scripts/later.sh", "echo later\n");
    repo.commit("later step");
    expect(playbook(repo.root, ["ci-files", "--rev", first]).out).toBe(
      [
        "scripts/ci-local.sh",
        "scripts/gate.sh",
        "scripts/lib/common.sh",
        "scripts/merge.sh",
        "scripts/ship-steps.sh",
        "scripts/suite.bash",
        "",
      ].join("\n"),
    );
    expect(playbook(repo.root, ["ci-files"]).out).toContain("scripts/later.sh\n");
    const none = playbook(repo.root, ["ci-files", "--rev", "no-such-rev"]);
    expect(none.code).toBe(0);
    expect(none.out).toBe("\n");
  });
});

describe("playbook stats", () => {
  const record = (over: Partial<ReviewStatRecord>): ReviewStatRecord => ({
    id: "x",
    source: "ship_queue_review",
    timestamp: "2026-11-20T00:00:00.000Z",
    repo: "sample-repo",
    branch: "feat/a",
    commit: "",
    worktree: "",
    threadId: "",
    reviewThreadId: "",
    verdict: "pass",
    reviewer: classifyModel("claude-opus-5-5", "claudeAgent"),
    submitter: classifyModel("gpt-6-astra (high)"),
    counts: { breaking: 0, critical: 0, high: 1, medium: 0, low: 2, info: 0, total: 3 },
    bypassDetected: false,
    playbookFriction: false,
    rejectedRisesCount: 0,
    fallbackUsed: false,
    durationS: null,
    ...over,
  });

  function statsEnv(): NodeJS.ProcessEnv {
    const state = makeTempDir("pb-parity-stats-");
    return {
      XDG_STATE_HOME: state,
      SHIP_QUEUE_ROOT: NodePath.join(state, "queue"),
      T3_REVIEW_STATS_JSONL: NodePath.join(state, "review-stats.jsonl"),
    };
  }

  it("prints the review-stats table, and an empty one", () => {
    const dir = makeTempDir("pb-parity-");
    const env = statsEnv();
    expect(playbook(dir, ["stats"], env).out).toBe(
      "Review Stats (side=reviewer, by=model): 0 reviews, 0 issues (0 breaking, 0 critical, 0 high, 0 medium, 0 low)\n  (no matching reviews)\n",
    );
    const jsonl = env.T3_REVIEW_STATS_JSONL!;
    appendReviewStatRecord(record({ id: "a" }), jsonl);
    appendReviewStatRecord(
      record({
        id: "b",
        verdict: "fail",
        counts: { breaking: 1, critical: 0, high: 0, medium: 0, low: 0, info: 2, total: 3 },
      }),
      jsonl,
    );
    appendReviewStatRecord(record({ id: "c", verdict: "bypassed" }), jsonl);
    const out = playbook(dir, ["stats", "--by", "repo"], env).out.split("\n");
    expect(out[0]).toBe(
      "Review Stats (side=reviewer, by=repo): 2 reviews, 6 issues (1 breaking, 0 critical, 1 high, 0 medium, 2 low, 2 info)",
    );
    expect(out[1]).toBe("GROUP        REVIEWS  PASS%  TOTAL  BRK  CRIT  HIGH  MED  LOW  AVG ");
    expect(out[2]).toBe("-----------  -------  -----  -----  ---  ----  ----  ---  ---  ----");
    expect(out[3]).toBe("sample-repo        2    50%      6    1     0     1    0    2  3.00");
    expect(playbook(dir, ["stats", "--by", "repo", "--include-bypasses"], env).out).toContain(
      "): 3 reviews",
    );
    expect(playbook(dir, ["stats", "--lab", "nobody"], env).out).toContain("(no matching reviews)");
  });

  it("refuses an unknown choice, a non-integer --days, and an unknown flag with exit 2", () => {
    const dir = makeTempDir("pb-parity-");
    const env = statsEnv();
    const side = playbook(dir, ["stats", "--side", "author"], env);
    expect(side.code).toBe(2);
    expect(side.err).toContain("argument --side: invalid choice: 'author'");
    expect(playbook(dir, ["stats", "--by", "week"], env).code).toBe(2);
    expect(playbook(dir, ["stats", "--source", "ci"], env).code).toBe(2);
    expect(playbook(dir, ["stats", "--days", "two"], env).code).toBe(2);
    expect(playbook(dir, ["stats", "--bogus"], env).code).toBe(2);
    expect(playbook(dir, ["stats", "--days", "7", "--side", "pair"], env).code).toBe(0);
  });
});

describe("playbook amend with a text file", () => {
  it("asks the owner about the text and never writes it unless approved", () => {
    const repo = makeFixtureRepo();
    repo.writeJson("playbook.json", evidenceDeclaration());
    repo.write("playbook/PLAYBOOK.md", fixturePlaybookMd());
    const base = repo.commit("base");
    const state = makeTempDir("pb-parity-amend-");
    const text = NodePath.join(state, "new.md");
    NodeFS.writeFileSync(text, `${fixturePlaybookMd()}\nAn amended rule.   \r\n\n\n`);
    const file = NodePath.join(repo.root, "playbook", "PLAYBOOK.md");
    const before = NodeFS.readFileSync(file, "utf8");
    const collected = playbook(repo.root, [
      "amend",
      "playbook/PLAYBOOK.md",
      text,
      "--base",
      base,
      "--collect",
    ]);
    expect(collected.code, collected.err).toBe(0);
    const bundle = JSON.parse(collected.out).bundle;
    expect(bundle.diff_preview).toContain("+An amended rule.\n");
    expect(NodeFS.readFileSync(file, "utf8")).toBe(before);
    // The approval covers the diff the text makes once written: the same as the worktree's then.
    NodeFS.writeFileSync(file, `${fixturePlaybookMd().replace(/\n+$/, "")}\n\nAn amended rule.\n`);
    const written = playbook(repo.root, [
      "amend",
      "playbook/PLAYBOOK.md",
      "--base",
      base,
      "--collect",
    ]);
    expect(written.code, written.err).toBe(0);
    expect(JSON.parse(written.out).bundle.protected_diff_sha256).toBe(bundle.protected_diff_sha256);
    NodeFS.writeFileSync(file, before);
    const denied = playbook(repo.root, ["amend", "playbook/PLAYBOOK.md", text, "--base", base]);
    expect(denied.code).toBe(1);
    expect(denied.err).toMatch(/override was not granted/);
    expect(NodeFS.readFileSync(file, "utf8")).toBe(before);
    const local = `${fixturePlaybookMd()}\nA local edit.\n`;
    NodeFS.writeFileSync(file, local);
    const baseText = NodePath.join(state, "base.md");
    NodeFS.writeFileSync(baseText, fixturePlaybookMd());
    const same = playbook(repo.root, ["amend", "playbook/PLAYBOOK.md", baseText, "--base", base]);
    expect(same.code).toBe(0);
    expect(same.out).toContain("is unchanged against the base");
    expect(NodeFS.readFileSync(file, "utf8")).toBe(local);
    const outside = playbook(repo.root, ["amend", "README.md", text, "--base", base]);
    expect(outside.code).toBe(2);
    expect(outside.err).toContain("playbook amend: README.md is not one of");
    const unreadable = playbook(repo.root, [
      "amend",
      "playbook/PLAYBOOK.md",
      NodePath.join(state, "none.md"),
      "--base",
      base,
    ]);
    expect(unreadable.code).toBe(2);
    expect(unreadable.err).toContain("cannot read");
  });
});
