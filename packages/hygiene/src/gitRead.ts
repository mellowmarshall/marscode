// @effect-diagnostics nodeBuiltinImport:off - Read-only git plumbing for the scanner, via node:child_process.
import * as NodeChildProcess from "node:child_process";

const MAX_BUFFER = 512 * 1024 * 1024;

// @effect-diagnostics-next-line extendsNativeError:off - a plain CLI library; no Effect failure channel.
export class GitReadError extends Error {}

/** Runs one read-only git command in `root`; a non-zero exit throws without echoing output. */
export function git(root: string, args: ReadonlyArray<string>, allowExit: number[] = []): string {
  const res = NodeChildProcess.spawnSync("git", [...args], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: MAX_BUFFER,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", LC_ALL: "C" },
  });
  if (res.error) throw new GitReadError(`git ${args[0] ?? ""} could not start`);
  const status = res.status ?? 1;
  if (status !== 0 && !allowExit.includes(status)) {
    throw new GitReadError(`git ${args[0] ?? ""} exited ${status}`);
  }
  return res.stdout;
}

export function gitStatus(root: string, args: ReadonlyArray<string>): number {
  const res = NodeChildProcess.spawnSync("git", [...args], { cwd: root, stdio: "ignore" });
  return res.status ?? 1;
}

export function nulList(out: string): ReadonlyArray<string> {
  return out.split("\0").filter(Boolean);
}

/** The text of `rev:path`, or `null` when the path is absent there. */
export function showFile(root: string, rev: string, path: string): string | null {
  try {
    return git(root, ["show", `${rev}:${path}`]);
  } catch {
    return null;
  }
}
