// @effect-diagnostics nodeBuiltinImport:off - Real temp checkouts and bare repos for the git and /data rule checks.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterAll, expect, it } from "@effect/vitest";

import { validateReaperPolicyRules } from "./ReaperPolicy.ts";
import { sweepApprovedPolicy } from "./reaper/ReaperEphemeralSweep.ts";
import { PathGuard } from "./reaper/ReaperPathGuard.ts";
import { gitCannotAnswer, realGitTracksFiles } from "./ReaperRulePathChecks.testkit.ts";

const root = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "rules-")));
const home = NodePath.join(root, "home");
const repo = NodePath.join(home, "Dev", "repo");
const git = (...args: string[]) =>
  NodeChildProcess.execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-C", repo, ...args], {
    env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  });
NodeFS.mkdirSync(NodePath.join(repo, "src"), { recursive: true });
NodeFS.mkdirSync(NodePath.join(repo, "build"), { recursive: true });
NodeFS.writeFileSync(NodePath.join(repo, "build", "checked-in.txt"), "kept by git\n");
git("init", "-q");
git("add", "build/checked-in.txt");
const mirror = NodePath.join(home, "Dev", "mirrors", "foo.git");
NodeFS.mkdirSync(NodePath.join(mirror, "objects"), { recursive: true });
const bare = NodePath.join(home, "Dev", "mirrors", "plain");
for (const dir of ["objects", "refs"]) {
  NodeFS.mkdirSync(NodePath.join(bare, dir), { recursive: true });
}
NodeFS.writeFileSync(NodePath.join(bare, "HEAD"), "ref: refs/heads/main\n");
afterAll(() => NodeFS.rmSync(root, { recursive: true, force: true }));
const tracksFiles = await realGitTracksFiles();

const check = async (path: string, agentProposal = true, git = tracksFiles) => {
  const result = await validateReaperPolicyRules(
    [{ path, maxAgeDays: 7, keepLatest: 0, enabled: false }],
    [],
    home,
    git,
    { agentProposal },
  );
  return result.ok ? null : result.error;
};

it("refuses git data, bare repos, and checkout contents, and allows untracked build output", async () => {
  expect(await check(NodePath.join(repo, ".git"))).toContain("git repository data");
  expect(await check(NodePath.join(repo, ".git", "objects"))).toContain("git repository data");
  expect(await check(NodePath.join(repo, ".GIT", "worktrees", "build"))).toContain(
    "git repository data",
  );
  expect(await check(mirror)).toContain("git repository data");
  expect(await check(NodePath.join(mirror, "objects"))).toContain("git repository data");
  expect(await check(NodePath.join(bare, "objects"))).toContain("git repository data");
  expect(await check(NodePath.join(repo, "src"))).toContain("inside git checkout");
  expect(await check(`${repo}/target/../src`)).toContain("inside git checkout");
  expect(await check(repo)).toContain("checkout/worktree root");
  expect(await check(NodePath.join(repo, "build"))).toContain("contains tracked files");
  expect(await check(NodePath.join(repo, "target"))).toBeNull();
  expect(await check(NodePath.join(repo, "node_modules"))).toBeNull();
  // The same checks hold for the user's own rules.
  expect(await check(NodePath.join(repo, "src"), false)).toContain("inside git checkout");
});

it("refuses build output in a checkout when git cannot answer", async () => {
  expect(await check(NodePath.join(repo, "target"), true, gitCannotAnswer)).toContain(
    "could not check it for tracked files",
  );
});

it("holds agent proposals under /data to a final build output, tmp, or cache name", async () => {
  expect(await check("/data/postgres/main")).toContain("not build output, tmp, or cache");
  expect(await check("/data/acme/tmp/main")).toContain("not build output, tmp, or cache");
  expect(await check("/data/postgres/main", false)).toBeNull();
  expect(await check("/data/acme/tmp")).toBeNull();
  expect(await check("/data/acme/web/dist")).toBeNull();
});

it("skips a saved rule at sweep time once its parent has become a repo", async () => {
  const parent = NodePath.join(root, "later-repo");
  const output = NodePath.join(parent, "reports");
  NodeFS.mkdirSync(output, { recursive: true });
  const old = NodePath.join(output, "old.txt");
  NodeFS.writeFileSync(old, "old\n");
  const nowMs = 1_767_225_600_000;
  const longAgo = (nowMs - 90 * 86_400_000) / 1000;
  NodeFS.utimesSync(old, longAgo, longAgo);
  const rule = { path: output, maxAgeDays: 7, keepLatest: 0, enabled: true };
  const logs: string[] = [];
  const ctx = {
    uid: process.getuid?.() ?? -1,
    nowMs,
    guard: new PathGuard([]),
    dryRun: true,
    log: (line: string) => void logs.push(line),
    homeDir: home,
    historyRoots: [],
  };
  expect((await sweepApprovedPolicy([rule], ctx, tracksFiles)).removed).toBe(1);

  NodeFS.mkdirSync(NodePath.join(parent, ".git"));
  expect((await sweepApprovedPolicy([rule], { ...ctx, dryRun: false }, tracksFiles)).removed).toBe(
    0,
  );
  expect(NodeFS.existsSync(old)).toBe(true);
  expect(logs.at(-1)).toContain("Skipped approved rule");
});
