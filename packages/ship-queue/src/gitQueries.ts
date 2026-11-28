// @effect-diagnostics nodeBuiltinImport:off - Git reads the queue's gates and phases share, run through the injected process port.
import * as NodePath from "node:path";

import { normalizeRepoSlug } from "@t3tools/guard-protocol/digests";

import type { ProcessResult, ProcessRunner } from "./types.ts";

// Hooks, editors, and prompts never run inside a queue job.
const GIT_ENV: Readonly<Record<string, string>> = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_EDITOR: "true",
  GIT_SEQUENCE_EDITOR: "true",
};

export function git(
  run: ProcessRunner,
  cwd: string,
  args: ReadonlyArray<string>,
): Promise<ProcessResult> {
  return run({
    command: "git",
    args: ["-c", "core.hooksPath=/dev/null", ...args],
    cwd,
    env: GIT_ENV,
  });
}

export async function gitOut(
  run: ProcessRunner,
  cwd: string,
  args: ReadonlyArray<string>,
): Promise<string | null> {
  const res = await git(run, cwd, args);
  return res.exitCode === 0 ? res.stdout.trim() : null;
}

export async function revParse(
  run: ProcessRunner,
  cwd: string,
  ref: string,
): Promise<string | null> {
  return gitOut(run, cwd, ["rev-parse", "-q", "--verify", `${ref}^{commit}`]);
}

export async function currentBranch(run: ProcessRunner, cwd: string): Promise<string | null> {
  const branch = await gitOut(run, cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return branch && branch !== "HEAD" ? branch : null;
}

/** Uncommitted or untracked work, one path per line; ignored files are not work. */
export async function worktreeChanges(run: ProcessRunner, cwd: string): Promise<string[]> {
  const out = await gitOut(run, cwd, ["status", "--porcelain", "--untracked-files=all"]);
  return out ? out.split("\n").filter(Boolean) : [];
}

/** The primary checkout: the parent of the shared `.git` directory. */
export async function primaryOf(run: ProcessRunner, cwd: string): Promise<string | null> {
  const common = await gitOut(run, cwd, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  return common ? NodePath.dirname(common) : null;
}

export async function isAncestor(
  run: ProcessRunner,
  cwd: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  return (
    (await git(run, cwd, ["merge-base", "--is-ancestor", ancestor, descendant])).exitCode === 0
  );
}

export async function remoteUrl(
  run: ProcessRunner,
  cwd: string,
  remote: string,
): Promise<string | null> {
  return gitOut(run, cwd, ["remote", "get-url", remote]);
}

export async function remoteBranchSha(
  run: ProcessRunner,
  cwd: string,
  remote: string,
  branch: string,
): Promise<string | null> {
  const out = await gitOut(run, cwd, ["ls-remote", "--heads", remote, `refs/heads/${branch}`]);
  const sha = out?.split(/\s+/)[0] ?? "";
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

/**
 * `owner/name` for a checkout: `ship-queue.repo` when configured, else the remote URL's last two
 * path segments, so local-path remotes and forge URLs resolve the same way.
 */
export async function resolveRepoSlug(
  run: ProcessRunner,
  cwd: string,
  remote: string,
): Promise<string | null> {
  const configured = await gitOut(run, cwd, ["config", "--get", "ship-queue.repo"]);
  if (configured) return configured.toLowerCase();
  const url = await remoteUrl(run, cwd, remote);
  if (!url) return null;
  const segments = normalizeRepoSlug(url).split("/").filter(Boolean);
  return segments.length >= 2 ? segments.slice(-2).join("/") : null;
}

export async function resolveBaseBranch(
  run: ProcessRunner,
  cwd: string,
  remote: string,
): Promise<string> {
  const configured = await gitOut(run, cwd, ["config", "--get", "ship-queue.base"]);
  if (configured) return configured;
  const head = await gitOut(run, cwd, ["symbolic-ref", "--short", `refs/remotes/${remote}/HEAD`]);
  if (head?.startsWith(`${remote}/`)) return head.slice(remote.length + 1);
  return "main";
}

/**
 * Whether the checkout is exactly `head`: HEAD there, and no tracked change in the index or the
 * worktree (an install or a step can rewrite tracked files without moving HEAD).
 */
export async function checkoutIsPinned(
  run: ProcessRunner,
  cwd: string,
  head: string,
): Promise<boolean> {
  if ((await gitOut(run, cwd, ["rev-parse", "HEAD"])) !== head) return false;
  return (await gitOut(run, cwd, ["status", "--porcelain", "--untracked-files=no"])) === "";
}

/** A gate pass's key: the base supplies the gate, so a pass holds only for this base and head. */
export const passKey = (rebase: { readonly onto: string; readonly head: string }): string =>
  `${rebase.onto} ${rebase.head}`;
