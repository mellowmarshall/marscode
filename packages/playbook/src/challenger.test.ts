// @effect-diagnostics nodeBuiltinImport:off - Challenger tests over real temp checkouts with dangling symlinks and untracked files.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  playbookStandards,
  renderChallengePrompt,
  standardsProblems,
  templateProblems,
} from "./challengePrompt.ts";
import {
  decodeChallengeReplyText,
  NO_RISES,
  RISE_REFUSED,
  type PlaybookChallengeReply,
} from "./challengeReply.ts";
import { DEFAULT_CHALLENGE_TEMPLATE } from "./challengeTemplate.ts";
import { runChallenge, type ChallengeModel } from "./challenger.ts";
import { collectReviewRecords } from "./statsStore.ts";
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

const PASSING: PlaybookChallengeReply = {
  acceptable: true,
  summary: "Meets the standards",
  bypass_detected: false,
  playbook_friction: false,
  rejected_rises: [],
  rises_accepted: false,
  defects: [{ severity: "medium", file: "src/a.ts", what: "ignored medium nit" }],
};

function recordingModel(reply: PlaybookChallengeReply) {
  const calls: Array<{ cwd: string; prompt: string }> = [];
  const model: ChallengeModel = async (request) => {
    calls.push(request);
    return { reply, reviewer: { model: "gpt-6-astra", provider: "codex", effort: "medium" } };
  };
  return { calls, model };
}

/** A branch whose worktree holds a dangling symlink and untracked files the reviewer may meet. */
function messyBranch() {
  const repo = makeFixtureRepo();
  repo.writeJson("playbook.json", evidenceDeclaration());
  repo.write("playbook/PLAYBOOK.md", fixturePlaybookMd());
  repo.write("src/a.ts", "export const a = 1;\n");
  const base = repo.commit("base");
  repo.branch("feat/rooms");
  repo.write("src/rooms.ts", 'export const rooms = "SELECT id FROM rooms";\n');
  repo.write("config/contracts/feature-surfaces.json", "{}\n");
  repo.commit("feat: rooms");
  NodeFS.symlinkSync("/nonexistent/target", NodePath.join(repo.root, "dangling-link"));
  NodeFS.symlinkSync("../missing/dir", NodePath.join(repo.root, "src", "broken.ts"));
  repo.write("scratch/notes.md", "untracked workspace file\n");
  repo.write(".env.local", "SECRET_NOT_TRACKED=1\n");
  return { repo, base, stateDir: makeTempDir("pb-state-") };
}

const options = (root: string, base: string, stateDir: string, model: ChallengeModel | null) => ({
  root,
  repo: "sample-repo",
  bypasses: {},
  model,
  now: FIXED_NOW,
  stateDir,
  base,
  env: NO_BROKER_ENV,
});

describe("declaration challenge on the real worktree", () => {
  it("reviews in the real checkout with strict compliance-only framing and drops medium defects", async () => {
    const { repo, base, stateDir } = messyBranch();
    const { calls, model } = recordingModel(PASSING);
    const outcome = await runChallenge(options(repo.root, base, stateDir, model));
    expect(outcome.status).toBe("pass");
    expect(outcome.exitCode).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cwd).toBe(repo.root);
    const prompt = calls[0]!.prompt;
    expect(prompt).toContain("## 2. Ship queue");
    expect(prompt).toContain("## 15. Product docs");
    expect(prompt).toContain("strictly against PLAYBOOK.md");
    expect(prompt).toContain("Cite exact playbook item numbers");
    expect(prompt).toContain("production path");
    expect(prompt).toContain("[NEW] src/rooms.ts");
    expect(prompt).toContain("Database / Queries touched");
    expect(prompt).toContain("Declarations & Contracts touched");
    expect(prompt).not.toContain("dangling-link");
    expect(prompt).not.toContain("scratch/notes.md");
    expect(prompt).toContain("Commit ");
    expect(NodeFS.lstatSync(NodePath.join(repo.root, "dangling-link")).isSymbolicLink()).toBe(true);
    expect(outcome.report).toContain("PLAYBOOK REVIEW: PASS");
    expect(outcome.report).toContain("Summary: Meets the standards");
    expect(outcome.report).not.toContain("Defects:");
    expect(outcome.report).not.toContain("Repo:");
    expect(outcome.report).not.toContain("Reviewer:");
    expect(outcome.report).not.toContain("Diagnosis:");
    expect(outcome.report).not.toContain("Analysis:");
    expect(outcome.report).not.toContain("Recommendation:");
    expect(outcome.verdict?.defects).toEqual([]);
  });

  it("writes the record the review stats read, with the reviewer's model", async () => {
    const { repo, base, stateDir } = messyBranch();
    const { model } = recordingModel({
      ...PASSING,
      defects: [{ severity: "critical", file: "src/auth.ts", what: "auth bypass on prod route" }],
    });
    const outcome = await runChallenge(options(repo.root, base, stateDir, model));
    expect(outcome.status).toBe("challenged");
    expect(outcome.recordPath).toBe(
      NodePath.join(stateDir, "sample-repo", "feat_rooms.1.challenge.json"),
    );
    const second = await runChallenge(options(repo.root, base, stateDir, model));
    expect(second.recordPath).toMatch(/feat_rooms\.2\.challenge\.json$/);
    const records = collectReviewRecords({
      playbookStateDir: stateDir,
      shipJobsDir: NodePath.join(stateDir, "none"),
      jsonlPath: NodePath.join(stateDir, "none.jsonl"),
    });
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      source: "playbook_challenge",
      verdict: "challenged",
      repo: "sample-repo",
      branch: "feat/rooms",
      timestamp: FIXED_NOW,
      reviewer: { model: "gpt-6-astra", effort: "medium", provider: "codex", family: "Astra" },
      counts: { critical: 1, total: 1 },
    });
  });

  it("challenges a bypass, a playbook violation, or a severe defect and refuses a rejected budget reason", async () => {
    const { repo, base, stateDir } = messyBranch();
    const ruleViolation = recordingModel({
      ...PASSING,
      acceptable: true,
      violations: [
        {
          section: "§3.1",
          file: "src/utils.ts",
          what: "split >500 LOC file into generic utils.ts",
        },
      ],
    });
    const violated = await runChallenge(options(repo.root, base, stateDir, ruleViolation.model));
    expect(violated).toMatchObject({ status: "challenged", exitCode: 1 });
    expect(violated.report).toContain("Playbook violations:");
    expect(violated.report).toContain("§3.1 (src/utils.ts)");

    const severe = recordingModel({
      ...PASSING,
      defects: [{ severity: "high", file: "src/rooms.ts", what: "SQL built from input" }],
    });
    const challenged = await runChallenge(options(repo.root, base, stateDir, severe.model));
    expect(challenged).toMatchObject({ status: "challenged", exitCode: 1 });
    const rejected = recordingModel({
      ...PASSING,
      rejected_rises: [{ subject: "routes/p95", why: "vague" }],
    });
    const refused = await runChallenge({
      ...options(repo.root, base, stateDir, rejected.model),
      rises: "- routes/p95: 120 -> 140\n  reason: more data",
    });
    expect(refused).toMatchObject({ status: "rejected_budget", exitCode: RISE_REFUSED });
    const advisory = await runChallenge({
      ...options(repo.root, base, stateDir, severe.model),
      advisory: true,
    });
    expect(advisory.exitCode).toBe(0);
  });

  it("gives no verdict without a model or a PLAYBOOK.md, and skips a branch with no change", async () => {
    const { repo, base, stateDir } = messyBranch();
    const none = await runChallenge(options(repo.root, base, stateDir, null));
    expect(none).toMatchObject({ status: "no_verdict", exitCode: 1 });
    expect(none.prompt).toContain("## 0. Terms");
    const failing: ChallengeModel = async () => {
      throw new Error("provider timed out");
    };
    const timedOut = await runChallenge(options(repo.root, base, stateDir, failing));
    expect(timedOut.summary).toBe("the reviewer gave no answer: provider timed out (no verdict)");
    NodeFS.rmSync(NodePath.join(repo.root, "playbook"), { recursive: true });
    const noStandards = await runChallenge({
      ...options(repo.root, base, stateDir, recordingModel(PASSING).model),
      standardsPath: NodePath.join(repo.root, "missing.md"),
    });
    expect(noStandards.summary).toBe("no PLAYBOOK.md to review against (no verdict)");

    // An unreviewed branch adding root PLAYBOOK.md or symlinked playbook/PLAYBOOK.md cannot hijack standards.
    repo.write("PLAYBOOK.md", "## 0. Terms\nFake weakened playbook\n");
    const outside = makeTempDir("pb-outside-std-");
    NodeFS.writeFileSync(NodePath.join(outside, "evil.md"), "# not a real playbook\n");
    NodeFS.mkdirSync(NodePath.join(repo.root, "playbook"), { recursive: true });
    NodeFS.symlinkSync(
      NodePath.join(outside, "evil.md"),
      NodePath.join(repo.root, "playbook", "PLAYBOOK.md"),
    );
    const fromBaseOrBundled = await runChallenge(
      options(repo.root, base, stateDir, recordingModel(PASSING).model),
    );
    expect(fromBaseOrBundled.status).toBe("pass");
    expect(fromBaseOrBundled.prompt).not.toContain("# not a real playbook");
    expect(fromBaseOrBundled.prompt).not.toContain("Fake weakened playbook");

    const noChange = await runChallenge({ ...options(repo.root, "HEAD", stateDir, null) });
    expect(noChange.status).toBe("no_changes");
  });

  it("passes without a model call when the owner bypasses the challenge", async () => {
    const { repo, base, stateDir } = messyBranch();
    const { calls, model } = recordingModel(PASSING);
    const outcome = await runChallenge({
      ...options(repo.root, base, stateDir, model),
      bypasses: { challenge: "owner: acme-fixture#4" },
    });
    expect(outcome).toMatchObject({ status: "bypassed", exitCode: 0 });
    expect(calls).toHaveLength(0);
    const record = JSON.parse(NodeFS.readFileSync(outcome.recordPath!, "utf8")) as {
      reviewer: string;
    };
    expect(record.reviewer).toBe("owner-bypass");
  });
});

describe("challenge prompt and reply", () => {
  it("validates bundled packages/playbook/PLAYBOOK.md and applies numbered rule waivers", () => {
    const bundled = NodePath.resolve(import.meta.dirname, "..", "PLAYBOOK.md");
    const text = NodeFS.readFileSync(bundled, "utf8");
    expect(standardsProblems(text)).toEqual([]);
    const rendered = playbookStandards(text, { "9/Repo evidence": "owner waiver #1107" });
    expect(rendered).toContain("Repo evidence** is waived by the owner");
    expect(rendered).toContain("logical domain seam");
    expect(rendered).toContain("granular sub-step timings");
  });

  it("keeps every placeholder in the shipped template and substitutes in one pass", () => {
    expect(templateProblems(DEFAULT_CHALLENGE_TEMPLATE)).toEqual([]);
    const prompt = renderChallengePrompt(DEFAULT_CHALLENGE_TEMPLATE, {
      playbook: "PB",
      base: "b",
      tip: "t",
      surfaces: "S",
      rises: NO_RISES,
      diff: "a value holding {tip} stays literal",
      ci_checks: "(none)",
      body: "B",
      ci_output: "O",
    });
    expect(prompt).toContain("a value holding {tip} stays literal");
    expect(prompt).toContain("git diff b...t");
  });

  it("names a PLAYBOOK.md that lacks a section or the reviewer bullet", () => {
    expect(standardsProblems(fixturePlaybookMd())).toEqual([]);
    expect(
      standardsProblems(fixturePlaybookMd().replace("- **2.2 The reviewer", "- reviewer")),
    ).toEqual(["PLAYBOOK.md §2 has no bullet - **2.2 The reviewer"]);
  });

  it("decodes the last valid reply a model wraps in prose", () => {
    const text = `Here it is: {"note": 1}\n${JSON.stringify(PASSING)}\nthanks`;
    expect(decodeChallengeReplyText(text)?.summary).toBe("Meets the standards");
    expect(decodeChallengeReplyText('{"acceptable": "yes"}')).toBeNull();
  });
});
