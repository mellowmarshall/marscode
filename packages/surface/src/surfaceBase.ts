// @effect-diagnostics nodeBuiltinImport:off - headless CLI library on node:* builtins only.
/**
 * The base contract changes are judged against, as the original playbook's gate
 * finds it: the ship queue's onto (SHIP_QUEUE_ONTO, else SHIP_QUEUE_BASE_SHA), else
 * the `base_ref` that origin/HEAD's .tree-guard.conf declares, else origin/HEAD.
 */
import * as NodeChildProcess from "node:child_process";

import { parseTreeGuardConf, TREE_GUARD } from "./surfaceLocate.ts";

export interface GateBase {
  readonly sha: string | null;
  readonly name: string;
  readonly problem: string | null;
}

function git(root: string, args: ReadonlyArray<string>): { status: number | null; stdout: string } {
  const res = NodeChildProcess.spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  return { status: res.status, stdout: res.stdout ?? "" };
}

/** The commit REV names, or null. */
export function resolveCommit(root: string, rev: string): string | null {
  const res = git(root, [
    "rev-parse",
    "--verify",
    "--quiet",
    "--end-of-options",
    `${rev}^{commit}`,
  ]);
  return res.status === 0 && res.stdout.trim() ? res.stdout.trim() : null;
}

/**
 * A file's text at a commit, "" when the path is not there. Any other git
 * failure is a problem, never taken for "absent".
 */
function showFile(
  root: string,
  rev: string,
  path: string,
): { readonly ok: true; readonly text: string } | { readonly ok: false; readonly problem: string } {
  if (git(root, ["cat-file", "-e", `${rev}:${path}`]).status !== 0) {
    const listed = git(root, ["ls-tree", "--name-only", rev, "--", path]);
    return listed.status === 0 && listed.stdout.trim() === ""
      ? { ok: true, text: "" }
      : { ok: false, problem: `git cannot read ${rev}:${path}` };
  }
  const shown = git(root, ["show", `${rev}:${path}`]);
  return shown.status === 0
    ? { ok: true, text: shown.stdout }
    : { ok: false, problem: `git show ${rev}:${path} failed` };
}

function originHead(root: string): string | null {
  const res = git(root, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
  const ref = res.stdout.trim();
  return res.status === 0 && ref.startsWith("refs/remotes/")
    ? ref.slice("refs/remotes/".length)
    : null;
}

export function gateBase(
  root: string,
  env: Readonly<Record<string, string | undefined>>,
): GateBase {
  for (const key of ["SHIP_QUEUE_ONTO", "SHIP_QUEUE_BASE_SHA"] as const) {
    const value = env[key];
    if (!value) continue;
    const sha = resolveCommit(root, value);
    return {
      sha,
      name: `${key}=${value.slice(0, 12)}`,
      problem: sha ? null : `${key}=${value} is not a commit here`,
    };
  }
  const start = originHead(root);
  if (start === null || resolveCommit(root, start) === null) {
    return {
      sha: null,
      name: start ?? "none",
      problem: "no base: origin/HEAD is not set (git remote set-head origin --auto)",
    };
  }
  const conf = showFile(root, start, TREE_GUARD);
  if (!conf.ok) return { sha: null, name: start, problem: conf.problem };
  const name = parseTreeGuardConf(conf.text).get("base_ref") ?? start;
  const sha = resolveCommit(root, name);
  return sha
    ? { sha, name, problem: null }
    : {
        sha: null,
        name,
        problem: `base_ref ${name} (from ${start}:${TREE_GUARD}) does not resolve`,
      };
}
