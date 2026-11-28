// @effect-diagnostics nodeBuiltinImport:off - Real temp checkout for the git and /data rule checks.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterAll, expect, it } from "@effect/vitest";

import { validateReaperPolicyRules } from "./ReaperPolicy.ts";

const root = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "rules-")));
const home = NodePath.join(root, "home");
const repo = NodePath.join(home, "Dev", "repo");
NodeFS.mkdirSync(NodePath.join(repo, ".git", "objects"), { recursive: true });
NodeFS.mkdirSync(NodePath.join(repo, "src"), { recursive: true });
afterAll(() => NodeFS.rmSync(root, { recursive: true, force: true }));

const check = (path: string, agentProposal = true) => {
  const result = validateReaperPolicyRules(
    [{ path, maxAgeDays: 7, keepLatest: 0, enabled: false }],
    [],
    home,
    { agentProposal },
  );
  return result.ok ? null : result.error;
};

it("refuses git metadata and checkout contents, and allows a checkout's build output", () => {
  expect(check(NodePath.join(repo, ".git"))).toContain("git metadata");
  expect(check(NodePath.join(repo, ".git", "objects"))).toContain("git metadata");
  expect(check(NodePath.join(repo, "src"))).toContain("inside git checkout");
  expect(check(`${repo}/target/../src`)).toContain("inside git checkout");
  expect(check(repo)).toContain("checkout/worktree root");
  expect(check(NodePath.join(repo, "target"))).toBeNull();
  expect(check(NodePath.join(repo, "node_modules"))).toBeNull();
  // The same checks hold for the user's own rules.
  expect(check(NodePath.join(repo, "src"), false)).toContain("inside git checkout");
});

it("holds agent proposals under /data to build output, tmp, and cache", () => {
  expect(check("/data/postgres/main")).toContain("not build output, tmp, or cache");
  expect(check("/data/postgres/main", false)).toBeNull();
  expect(check("/data/acme/tmp")).toBeNull();
  expect(check("/data/acme/web/dist")).toBeNull();
});
