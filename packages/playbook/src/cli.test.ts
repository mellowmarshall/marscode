// @effect-diagnostics nodeBuiltinImport:off - CLI subcommand tests over real temp checkouts.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { runPlaybookCli } from "./cli.ts";
import {
  cleanupTempDirs,
  declarationWithSize,
  fixturePlaybookMd,
  makeFixtureRepo,
  makeTempDir,
  NO_BROKER_ENV,
} from "./testing/fixtureRepo.ts";

afterEach(cleanupTempDirs);

async function cli(cwd: string, argv: ReadonlyArray<string>, env: NodeJS.ProcessEnv = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runPlaybookCli(argv, {
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    env: { ...NO_BROKER_ENV, ...env },
    cwd,
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

function branchRepo() {
  const repo = makeFixtureRepo();
  repo.writeJson("playbook.json", declarationWithSize({ "src/a.ts": 3 }));
  repo.write("playbook/PLAYBOOK.md", fixturePlaybookMd());
  repo.write("src/a.ts", "export const a = 1;\n");
  const base = repo.commit("base");
  repo.branch("feat/cli");
  repo.write("src/b.ts", "export const b = 2;\n");
  repo.commit("add b");
  return { repo, base, state: makeTempDir("pb-cli-state-") };
}

describe("playbook CLI", () => {
  it("prints its version and usage, and refuses an unknown command", async () => {
    const dir = makeTempDir("pb-cli-");
    expect(await cli(dir, ["version"])).toMatchObject({ code: 0, out: "playbook 7" });
    expect((await cli(dir, [])).code).toBe(2);
    expect((await cli(dir, ["bogus"])).err).toMatch(/unknown command bogus/);
  });

  it("init writes the minimal declaration once", async () => {
    const repo = makeFixtureRepo();
    const dry = await cli(repo.root, ["init", "--dry-run"]);
    expect(JSON.parse(dry.out)).toHaveProperty("contracts.size.command");
    expect(NodeFS.existsSync(NodePath.join(repo.root, "playbook.json"))).toBe(false);
    expect((await cli(repo.root, ["init"])).code).toBe(0);
    expect((await cli(repo.root, ["init"])).err).toMatch(/already exists/);
  });

  it("check runs the gates against the queue's base and prints JSON", async () => {
    const { repo, base } = branchRepo();
    const res = await cli(repo.root, ["check", "size", "--json"], { SHIP_QUEUE_BASE_SHA: base });
    expect(res.code).toBe(0);
    const report = JSON.parse(res.out) as {
      base: string;
      results: Array<{ check: string; status: string }>;
    };
    expect(report.base).toBe(base);
    expect(report.results.map((r) => `${r.check}:${r.status}`)).toEqual([
      "declaration:PASS",
      "ratchet:PASS",
      "size:PASS",
    ]);
    expect((await cli(repo.root, ["check", "nonsense"])).code).toBe(2);
    const text = await cli(repo.root, ["-C", "src", "check"], { SHIP_QUEUE_BASE_SHA: base });
    expect(text.out).toContain("UNPROVEN fleet:");
    expect(text.code).toBe(3);
  });

  it("challenge judges a response file against the real worktree and records it", async () => {
    const { repo, base, state } = branchRepo();
    NodeFS.symlinkSync("/nonexistent", NodePath.join(repo.root, "dangling"));
    const reply = {
      acceptable: true,
      summary: "Meets the standards",
      diagnosis: "ok",
      bypass_detected: false,
      playbook_friction: false,
      rejected_rises: [],
      rises_accepted: false,
      defects: [],
      analysis: "",
      recommendation: "Accept.",
    };
    const responseFile = NodePath.join(state, "reply.txt");
    NodeFS.writeFileSync(responseFile, `model said:\n${JSON.stringify(reply)}\n`);
    const out = NodePath.join(state, "report.txt");
    const res = await cli(
      repo.root,
      ["challenge", "--base", base, "--response", responseFile, "--out", out],
      {
        XDG_STATE_HOME: state,
      },
    );
    expect(res.code).toBe(0);
    expect(res.out).toContain("PLAYBOOK REVIEW: PASS");
    expect(NodeFS.readFileSync(out, "utf8")).toContain("Reviewer:       response-file");
    expect(NodeFS.readdirSync(NodePath.join(state, "playbook", "sample-repo"))).toContain(
      "feat_cli.1.challenge.json",
    );
    const stats = await cli(repo.root, ["stats", "--json"], {
      XDG_STATE_HOME: state,
      SHIP_QUEUE_ROOT: NodePath.join(state, "queue"),
    });
    expect(JSON.parse(stats.out).totals.reviews).toBe(1);
    const noModel = await cli(repo.root, ["challenge", "--base", base], { XDG_STATE_HOME: state });
    expect(noModel.code).toBe(1);
    expect(noModel.out).toContain("no reviewer model is configured");
  });

  it("amend validates the standards and emits the owner's override descriptor", async () => {
    const { repo, base } = branchRepo();
    repo.write("playbook/PLAYBOOK.md", `${fixturePlaybookMd()}\nAn amended rule.\n`);
    const collected = await cli(repo.root, [
      "amend",
      "playbook/PLAYBOOK.md",
      "--base",
      base,
      "--collect",
    ]);
    expect(collected.code).toBe(0);
    const descriptor = JSON.parse(collected.out) as {
      command: string[];
      bundle: {
        gates: Array<{ gate_id: string }>;
        protected_paths: string[];
        protected_diff_sha256: string;
      };
    };
    expect(descriptor.command).toEqual(["playbook", "amend", "playbook/PLAYBOOK.md"]);
    expect(descriptor.bundle.gates[0]?.gate_id).toBe("playbook-amend");
    expect(descriptor.bundle.protected_paths).toEqual(["playbook/PLAYBOOK.md"]);
    expect(descriptor.bundle.protected_diff_sha256).toMatch(/^[0-9a-f]{64}$/);
    const noBroker = await cli(repo.root, ["amend", "playbook/PLAYBOOK.md", "--base", base]);
    expect(noBroker.code).toBe(1);
    expect(noBroker.err).toMatch(/override was not granted/);
    repo.write("playbook/PLAYBOOK.md", "## 0. Terms\n");
    const broken = await cli(repo.root, ["amend", "playbook/PLAYBOOK.md", "--base", base]);
    expect(broken.err).toContain(
      "FAIL amend: PLAYBOOK.md has no section §1 What counts as a contract",
    );
    expect((await cli(repo.root, ["amend", "README.md", "--base", base])).err).toMatch(
      /can be amended/,
    );
  });
});
