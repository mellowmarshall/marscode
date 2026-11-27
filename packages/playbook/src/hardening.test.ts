// @effect-diagnostics nodeBuiltinImport:off - Regression tests for option injection, hostile repo config, symlinked parents and fail-closed verdicts.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { judgeChallengeReply, NO_RISES, type PlaybookChallengeReply } from "./challengeReply.ts";
import { runChallenge, type ChallengeModel } from "./challenger.ts";
import { changedFiles, diffText, readWorktreeFile, resolveCommit, showFile } from "./git.ts";
import {
  cleanupTempDirs,
  evidenceDeclaration,
  FIXED_NOW,
  fixturePlaybookMd,
  makeFixtureRepo,
  makeTempDir,
  NO_BROKER_ENV,
} from "./testing/fixtureRepo.ts";

afterEach(cleanupTempDirs);

const REPLY: PlaybookChallengeReply = {
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

function branch() {
  const repo = makeFixtureRepo();
  repo.writeJson("playbook.json", evidenceDeclaration());
  repo.write("playbook/PLAYBOOK.md", fixturePlaybookMd());
  repo.write("src/a.ts", "export const a = 1;\n");
  const base = repo.commit("base");
  repo.branch("feat/x");
  repo.write("src/a.ts", "export const a = 2;\n");
  repo.commit("change a");
  return { repo, base, stateDir: makeTempDir("pb-hard-state-") };
}

function countingModel() {
  const calls: string[] = [];
  const model: ChallengeModel = async ({ cwd }) => {
    calls.push(cwd);
    return { reply: REPLY, reviewer: { model: "m", provider: "p", effort: "" } };
  };
  return { calls, model };
}

describe("refs are never read as git options", () => {
  it("returns no verdict for an option-shaped base and writes no file", async () => {
    const { repo, stateDir } = branch();
    const evil = NodePath.join(makeTempDir("pb-evil-"), "evil");
    const { calls, model } = countingModel();
    const outcome = await runChallenge({
      root: repo.root,
      repo: "sample-repo",
      bypasses: {},
      model,
      now: FIXED_NOW,
      stateDir,
      base: `--output=${evil}`,
      env: NO_BROKER_ENV,
    });
    expect(outcome).toMatchObject({ status: "no_verdict", exitCode: 1 });
    expect(outcome.summary).toContain("does not resolve to a commit");
    expect(NodeFS.existsSync(evil)).toBe(false);
    expect(calls).toEqual([]);
    expect(NodeFS.readdirSync(stateDir)).toEqual([]);
  });

  it("refuses an option-shaped tip and any ref helper given one", async () => {
    const { repo, base, stateDir } = branch();
    const evil = NodePath.join(makeTempDir("pb-evil-"), "tip");
    const outcome = await runChallenge({
      root: repo.root,
      repo: "sample-repo",
      bypasses: {},
      model: countingModel().model,
      now: FIXED_NOW,
      stateDir,
      base,
      tip: `--output=${evil}`,
      env: NO_BROKER_ENV,
    });
    expect(outcome.status).toBe("no_verdict");
    expect(resolveCommit(repo.root, `--output=${evil}`)).toBeNull();
    expect(changedFiles(repo.root, `--output=${evil}`, "HEAD")).toBeNull();
    expect(diffText(repo.root, base, `--output=${evil}`)).toBe("");
    expect(showFile(repo.root, `--output=${evil}`, "x")).toBeNull();
    expect(NodeFS.existsSync(evil)).toBe(false);
  });

  it("fails closed with no verdict when no base can be found", async () => {
    const { repo, stateDir } = branch();
    const outcome = await runChallenge({
      root: repo.root,
      repo: "sample-repo",
      bypasses: {},
      model: countingModel().model,
      now: FIXED_NOW,
      stateDir,
      env: NO_BROKER_ENV,
    });
    expect(outcome).toMatchObject({ status: "no_verdict", exitCode: 1 });
    expect(outcome.summary).toMatch(/^no base commit to compare against \(no base: origin\/HEAD/);
  });
});

describe("challenge records never clobber each other", () => {
  it("skips a pass another run already claimed and gives parallel runs distinct records", async () => {
    const { repo, base, stateDir } = branch();
    const folder = NodePath.join(stateDir, "sample-repo");
    NodeFS.mkdirSync(folder, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(folder, "feat_x.1.challenge.json"), "");
    const options = {
      root: repo.root,
      repo: "sample-repo",
      bypasses: {},
      model: countingModel().model,
      now: FIXED_NOW,
      stateDir,
      base,
      env: NO_BROKER_ENV,
    };
    const [a, b] = await Promise.all([runChallenge(options), runChallenge(options)]);
    expect([a.recordPath, b.recordPath].toSorted()).toEqual([
      NodePath.join(folder, "feat_x.2.challenge.json"),
      NodePath.join(folder, "feat_x.3.challenge.json"),
    ]);
    expect(NodeFS.readFileSync(NodePath.join(folder, "feat_x.1.challenge.json"), "utf8")).toBe("");
  });
});

describe("a repo's own git config cannot steer the engine", () => {
  it("ignores diff.external, textconv drivers and hooks set in the repo", () => {
    const { repo, base } = branch();
    const git = (...args: string[]) =>
      NodeFS.appendFileSync(NodePath.join(repo.root, ".git", "config"), `${args.join("\n")}\n`);
    git("[diff]", "\texternal = /bin/false", '[diff "evil"]', "\ttextconv = /bin/false");
    repo.write(".gitattributes", "*.ts diff=evil\n");
    expect(changedFiles(repo.root, base, "HEAD")?.map((f) => f.path)).toEqual(["src/a.ts"]);
    const patch = diffText(repo.root, base, "HEAD");
    expect(patch).toContain("-export const a = 1;");
    expect(patch).toContain("+export const a = 2;");
  });
});

describe("worktree reads stay inside the repo", () => {
  it("refuses a file reached through a symlinked parent directory outside the root", () => {
    const repo = makeFixtureRepo();
    const outside = makeTempDir("pb-outside-");
    NodeFS.writeFileSync(NodePath.join(outside, "PLAYBOOK.md"), "secret\n");
    NodeFS.symlinkSync(outside, NodePath.join(repo.root, "playbook"));
    expect(readWorktreeFile(repo.root, "playbook/PLAYBOOK.md")).toBeNull();
    expect(readWorktreeFile(repo.root, "../outside")).toBeNull();
    expect(readWorktreeFile(repo.root, "/etc/hostname")).toBeNull();
    repo.write("docs/inner.md", "inside\n");
    NodeFS.symlinkSync("docs", NodePath.join(repo.root, "alias"));
    expect(readWorktreeFile(repo.root, "alias/inner.md")).toBe("inside\n");
  });
});

describe("defect severities fail closed", () => {
  const judge = (severity: string) =>
    judgeChallengeReply({ ...REPLY, defects: [{ severity, file: "a.ts", what: "x" }] }, NO_RISES);

  it("treats breaking, critical, high, mixed-case and unknown severities as severe", () => {
    for (const severity of ["critical", "High", "BREAKING", "severe", ""]) {
      expect(judge(severity).passed, severity).toBe(false);
    }
    expect(judge("").defects[0]?.severity).toBe("unknown");
  });

  it("drops medium and low defects without blocking (§2.2)", () => {
    expect(judge("MEDIUM")).toMatchObject({ passed: true, defects: [] });
    expect(judge(" Low ")).toMatchObject({ passed: true, defects: [] });
  });
});
