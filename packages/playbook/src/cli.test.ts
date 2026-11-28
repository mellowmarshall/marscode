// @effect-diagnostics nodeBuiltinImport:off - CLI subcommand tests over real temp checkouts.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { starterShape } from "@t3tools/fleet";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { runPlaybookCli } from "./cli.ts";
import {
  cleanupTempDirs,
  evidenceDeclaration,
  fixturePlaybookMd,
  makeFixtureRepo,
  makeTempDir,
  NO_BROKER_ENV,
  writeEvidence,
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
  repo.writeJson("playbook.json", evidenceDeclaration());
  repo.writeJson("fleet.json", starterShape("sample-repo"));
  repo.write("playbook/PLAYBOOK.md", fixturePlaybookMd());
  repo.write("src/a.ts", "export const a = 1;\n");
  const base = repo.commit("base");
  repo.branch("feat/cli");
  repo.write("src/b.ts", "export const b = 2;\n");
  repo.commit("add b");
  writeEvidence(repo, "size");
  writeEvidence(repo, "fleet");
  writeEvidence(repo, "tools");
  return { repo, base, state: makeTempDir("pb-cli-state-") };
}

describe("playbook CLI", () => {
  it("prints its version and usage, supports subcommand --help, and refuses an unknown command", async () => {
    const dir = makeTempDir("pb-cli-");
    expect(await cli(dir, ["version"])).toMatchObject({ code: 0, out: "playbook 8" });
    expect((await cli(dir, [])).code).toBe(2);
    expect((await cli(dir, ["bogus"])).err).toMatch(/unknown command bogus/);
    for (const sub of ["check", "challenge", "amend", "init", "stats", "version"]) {
      const longHelp = await cli(dir, [sub, "--help"]);
      expect(longHelp.code).toBe(0);
      expect(longHelp.out).toContain(`playbook`);
      const shortHelp = await cli(dir, [sub, "-h"]);
      expect(shortHelp.code).toBe(0);
    }
  });

  it("init writes the minimal evidence-only declaration once", async () => {
    const repo = makeFixtureRepo();
    const dry = await cli(repo.root, ["init", "--dry-run"]);
    expect(JSON.parse(dry.out)).toHaveProperty("contracts.size.evidence");
    expect(JSON.parse(dry.out)).toHaveProperty("ci.granularThresholdMs", 30000);
    expect(NodeFS.existsSync(NodePath.join(repo.root, "playbook.json"))).toBe(false);
    expect((await cli(repo.root, ["init"])).code).toBe(0);
    expect((await cli(repo.root, ["init"])).err).toMatch(/already exists/);
  });

  it("check validates repo evidence against the queue's base and prints JSON", async () => {
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
    const text = await cli(repo.root, ["-C", "src", "check", "--ship"], {
      SHIP_QUEUE_BASE_SHA: base,
    });
    expect(text.out).toContain("PASS fleet:");
    expect(text.code).toBe(0);
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
    const disabledCfg = NodePath.join(state, "disabled-host-config.json");
    NodeFS.writeFileSync(disabledCfg, JSON.stringify({ playbook_challenge: null }));
    const noModel = await cli(repo.root, ["challenge", "--base", base], {
      XDG_STATE_HOME: state,
      PLAYBOOK_HOST_CONFIG: disabledCfg,
    });
    expect(noModel.code).toBe(1);
    expect(noModel.out).toContain("no reviewer model is configured");

    const binDir = NodePath.join(state, "bin");
    NodeFS.mkdirSync(binDir, { recursive: true });
    const fakeCodex = NodePath.join(binDir, "codex");
    NodeFS.writeFileSync(
      fakeCodex,
      `#!/usr/bin/env bash
out=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then out="$2"; shift 2; continue; fi
  shift
done
cat >/dev/null
printf '%s\\n' '${JSON.stringify(reply)}' > "$out"
printf '{"type":"turn.completed"}\\n'
`,
      { mode: 0o755 },
    );
    const liveCfg = NodePath.join(state, "live-host-config.json");
    NodeFS.writeFileSync(
      liveCfg,
      JSON.stringify({
        challenge_timeout_s: 60,
        playbook_challenge: {
          default: { provider: "codex", model: "gpt-6.2-astra", effort: "medium" },
          fallbacks: [],
        },
      }),
    );
    const liveOut = NodePath.join(state, "live-report.txt");
    const liveRes = await cli(repo.root, ["challenge", "--base", base, "--out", liveOut], {
      XDG_STATE_HOME: state,
      HOME: state,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      PLAYBOOK_HOST_CONFIG: liveCfg,
    });
    expect(liveRes.code).toBe(0);
    expect(liveRes.out).toContain("PLAYBOOK REVIEW: PASS");
    expect(NodeFS.readFileSync(liveOut, "utf8")).toContain(
      "Reviewer:       gpt-6.2-astra (medium)",
    );
  });

  it("challenge reviews a ship-queue job that has no ci-output.txt", async () => {
    const { repo, base, state } = branchRepo();
    const jobDir = NodePath.join(state, "jobs", "1042");
    NodeFS.mkdirSync(jobDir, { recursive: true });
    const bodyFile = NodePath.join(jobDir, "body.md");
    NodeFS.writeFileSync(bodyFile, "fix(cli): a job body\n");
    const promptFile = NodePath.join(state, "prompt.txt");
    const binDir = NodePath.join(state, "bin");
    NodeFS.mkdirSync(binDir, { recursive: true });
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
    NodeFS.writeFileSync(
      NodePath.join(binDir, "codex"),
      `#!/usr/bin/env bash
out=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then out="$2"; shift 2; continue; fi
  shift
done
cat > '${promptFile}'
printf '%s\\n' '${JSON.stringify(reply)}' > "$out"
printf '{"type":"turn.completed"}\\n'
`,
      { mode: 0o755 },
    );
    const cfg = NodePath.join(state, "host-config.json");
    NodeFS.writeFileSync(
      cfg,
      JSON.stringify({
        challenge_timeout_s: 60,
        playbook_challenge: {
          default: { provider: "codex", model: "gpt-6.2-astra", effort: "medium" },
          fallbacks: [],
        },
      }),
    );
    const out = NodePath.join(jobDir, "declaration-challenge.txt");
    const env = {
      XDG_STATE_HOME: state,
      HOME: state,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      PLAYBOOK_HOST_CONFIG: cfg,
      SHIP_QUEUE_JOB: "1042",
      SHIP_QUEUE_BODYFILE: bodyFile,
    };
    const res = await cli(repo.root, ["challenge", "--base", base, "--out", out], env);
    expect(res.err).not.toMatch(/ENOENT/);
    expect(res.code).toBe(0);
    expect(NodeFS.readFileSync(out, "utf8")).toContain("PLAYBOOK REVIEW: PASS");
    expect(NodeFS.readFileSync(promptFile, "utf8")).toContain(
      "no CI output: this ship-queue job ran no CI before the review",
    );

    NodeFS.writeFileSync(NodePath.join(jobDir, "ci-output.txt"), "ci: 42 tests passed\n");
    expect((await cli(repo.root, ["challenge", "--base", base, "--out", out], env)).code).toBe(0);
    expect(NodeFS.readFileSync(promptFile, "utf8")).toContain("ci: 42 tests passed");
  });

  it("amend validates PLAYBOOK.md and emits the owner's override descriptor", async () => {
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
      "FAIL amend: PLAYBOOK.md has no section §1 Contracts, Growth & Scoped Exceptions",
    );
    expect((await cli(repo.root, ["amend", "README.md", "--base", base])).err).toMatch(
      /can be amended/,
    );
  });
});
