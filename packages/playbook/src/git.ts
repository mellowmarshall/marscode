// @effect-diagnostics nodeBuiltinImport:off - Read-only git plumbing over the real worktree for the headless playbook engine.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const TREE_GUARD = ".tree-guard.conf";

const MAX_GIT_BUFFER = 64 * 1024 * 1024;

/** Config every engine git call pins, so a repo's own config cannot run code or rewrite output. */
const HARDENED_ARGS = [
  "--no-replace-objects",
  "-c",
  "core.fsmonitor=",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.attributesfile=/dev/null",
  "-c",
  "diff.external=",
  "-c",
  "core.pager=cat",
];
/** Diff and log flags: no external diff driver, no textconv filter. */
const NO_DIFF_DRIVERS = ["--no-ext-diff", "--no-textconv"];

export interface GitResult {
  readonly code: number;
  readonly stdout: string;
}

/** An env without any GIT_* location or config override. */
function withoutGitOverrides(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("GIT_")));
}

/** The environment for one engine git call: no GIT_* from the caller, no system or global config. */
function gitEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...withoutGitOverrides(env),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_GRAFT_FILE: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
}

/** A revision the engine may hand to git: never an option, never multi-line. */
function safeRev(rev: string): boolean {
  return rev.length > 0 && !rev.startsWith("-") && !/[\0\r\n]/.test(rev);
}

export function git(root: string, args: ReadonlyArray<string>): GitResult {
  const res = NodeChildProcess.spawnSync("git", ["-C", root, ...HARDENED_ARGS, ...args], {
    encoding: "utf8",
    env: gitEnv(),
    maxBuffer: MAX_GIT_BUFFER,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (res.error) return { code: 127, stdout: "" };
  return { code: res.status ?? 1, stdout: res.stdout ?? "" };
}

/**
 * `git diff BASE -- REL` as it would read with TEXT in REL's place, worked out in a
 * scratch index so the worktree is never written; null when git cannot.
 */
export function diffWithText(
  root: string,
  baseSha: string,
  rel: string,
  text: string,
): string | null {
  const scratch = NodeFS.mkdtempSync(
    NodePath.join(NodeFS.realpathSync(NodeOS.tmpdir()), "playbook-amend-"),
  );
  const env = { ...gitEnv(), GIT_INDEX_FILE: NodePath.join(scratch, "index") };
  const run = (args: ReadonlyArray<string>, input?: string) =>
    NodeChildProcess.spawnSync("git", ["-C", root, ...HARDENED_ARGS, ...args], {
      encoding: "utf8",
      env,
      input,
      maxBuffer: MAX_GIT_BUFFER,
    });
  try {
    const blob = run(["hash-object", "-w", "--stdin"], text);
    const mode = run(["ls-tree", "--end-of-options", baseSha, "--", rel]).stdout.split(" ")[0];
    if (blob.status !== 0 || run(["read-tree", "--end-of-options", baseSha]).status !== 0)
      return null;
    const info = `${mode || "100644"},${blob.stdout.trim()},${rel}`;
    if (run(["update-index", "--add", "--cacheinfo", info]).status !== 0) return null;
    const diff = run([
      "diff",
      "--cached",
      ...NO_DIFF_DRIVERS,
      "--binary",
      "--end-of-options",
      baseSha,
      "--",
      rel,
    ]);
    return diff.status === 0 ? diff.stdout : null;
  } finally {
    NodeFS.rmSync(scratch, { recursive: true, force: true });
  }
}

export function repoRoot(start: string): string {
  const res = git(start, ["rev-parse", "--show-toplevel"]);
  const top = res.stdout.trim();
  return res.code === 0 && top ? top : NodePath.resolve(start);
}

/** The commit REV names, or null (also for a REV that could be read as an option). */
export function resolveCommit(root: string, rev: string): string | null {
  if (!safeRev(rev)) return null;
  const res = git(root, [
    "rev-parse",
    "--verify",
    "--quiet",
    "--end-of-options",
    `${rev}^{commit}`,
  ]);
  const sha = res.stdout.trim();
  return res.code === 0 && sha ? sha : null;
}

/** The tree hash REV points to, or null. */
export function resolveTree(root: string, rev: string): string | null {
  if (!safeRev(rev)) return null;
  const res = git(root, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${rev}^{tree}`]);
  const sha = res.stdout.trim();
  return res.code === 0 && sha ? sha : null;
}

export function mergeBase(root: string, a: string, b: string): string | null {
  if (!safeRev(a) || !safeRev(b)) return null;
  const res = git(root, ["merge-base", "--end-of-options", a, b]);
  const sha = res.stdout.trim();
  return res.code === 0 && sha ? sha : null;
}

/** A file's text at REV, or null when the commit does not hold it. */
export function showFile(root: string, rev: string, path: string): string | null {
  const spec = `${rev}:${path}`;
  return showFiles(root, [spec]).get(spec) ?? null;
}

/** Many `rev:path` blobs in one `git cat-file --batch` call; a missing one maps to null. */
export function showFiles(
  root: string,
  specs: ReadonlyArray<string>,
): ReadonlyMap<string, string | null> {
  const out = new Map<string, string | null>();
  // Object names reach git on stdin, so none can be read as an option.
  const unique = [...new Set(specs)].filter((s) => safeRev(s));
  if (unique.length === 0) return out;
  const res = NodeChildProcess.spawnSync(
    "git",
    ["-C", root, ...HARDENED_ARGS, "cat-file", "--batch"],
    {
      env: gitEnv(),
      input: `${unique.join("\n")}\n`,
      maxBuffer: MAX_GIT_BUFFER,
    },
  );
  const buf = res.status === 0 && Buffer.isBuffer(res.stdout) ? res.stdout : Buffer.alloc(0);
  let pos = 0;
  for (const spec of unique) {
    const eol = buf.indexOf(10, pos);
    if (eol < 0) {
      out.set(spec, null);
      continue;
    }
    const header = buf.subarray(pos, eol).toString("utf8");
    const size = /^[0-9a-f]+ blob (\d+)$/.exec(header)?.[1];
    if (size === undefined) {
      out.set(spec, null);
      pos = eol + 1;
      const other = /^[0-9a-f]+ \w+ (\d+)$/.exec(header)?.[1];
      if (other !== undefined) pos += Number(other) + 1;
      continue;
    }
    out.set(spec, buf.subarray(eol + 1, eol + 1 + Number(size)).toString("utf8"));
    pos = eol + 1 + Number(size) + 1;
  }
  return out;
}

/**
 * A file's text in the real worktree; null when absent, a symlink, not a regular file, or
 * reached through a parent directory (a symlink) that resolves outside the repo root.
 */
export function readWorktreeFile(root: string, rel: string): string | null {
  if (!rel || NodePath.isAbsolute(rel) || rel.includes("\0")) return null;
  try {
    const rootReal = NodeFS.realpathSync(root);
    const full = NodePath.resolve(rootReal, rel);
    const parentReal = NodeFS.realpathSync(NodePath.dirname(full));
    if (parentReal !== rootReal && !parentReal.startsWith(rootReal + NodePath.sep)) return null;
    const target = NodePath.join(parentReal, NodePath.basename(full));
    const st = NodeFS.lstatSync(target);
    if (!st.isFile()) return null;
    return NodeFS.readFileSync(target, "utf8");
  } catch {
    return null;
  }
}

export function parseConf(text: string): Readonly<Record<string, ReadonlyArray<string>>> {
  const conf: Record<string, string[]> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const idx = line.indexOf("=");
    const key = line.slice(0, idx).trim();
    (conf[key] ??= []).push(line.slice(idx + 1).trim());
  }
  return conf;
}

function originHead(root: string): string | null {
  const res = git(root, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
  const ref = res.stdout.trim();
  return res.code === 0 && ref.startsWith("refs/remotes/")
    ? ref.slice("refs/remotes/".length)
    : null;
}

export interface GateBase {
  readonly sha: string | null;
  readonly name: string;
  readonly problem: string | null;
}

/** The base a gate compares against: the queue's onto, else origin/HEAD's declared base_ref. */
export function gateBase(root: string, env: NodeJS.ProcessEnv = process.env): GateBase {
  for (const key of ["SHIP_QUEUE_ONTO", "SHIP_QUEUE_BASE_SHA"] as const) {
    const value = env[key]?.trim();
    if (!value) continue;
    const sha = resolveCommit(root, value);
    return {
      sha,
      name: `${key}=${value.slice(0, 12)}`,
      problem: sha ? null : `${key}=${value} is not a commit here`,
    };
  }
  const start = originHead(root);
  if (!start || !resolveCommit(root, start)) {
    return {
      sha: null,
      name: start ?? "none",
      problem: "no base: origin/HEAD is not set (git remote set-head origin --auto)",
    };
  }
  const declared = parseConf(showFile(root, start, TREE_GUARD) ?? "").base_ref;
  const name = declared?.at(-1) ?? start;
  const sha = resolveCommit(root, name);
  return sha
    ? { sha, name, problem: null }
    : {
        sha: null,
        name,
        problem: `base_ref ${name} (from ${start}:${TREE_GUARD}) does not resolve`,
      };
}

export interface ChangedFile {
  readonly status: string;
  readonly path: string;
  readonly oldPath: string | null;
}

/** Files changed BASE...TIP, renames detected, or null when git cannot answer. */
export function changedFiles(
  root: string,
  base: string,
  tip: string,
): ReadonlyArray<ChangedFile> | null {
  if (!safeRev(base) || !safeRev(tip)) return null;
  const res = git(root, [
    "diff",
    ...NO_DIFF_DRIVERS,
    "--name-status",
    "-M",
    "-z",
    "--end-of-options",
    `${base}...${tip}`,
  ]);
  if (res.code !== 0) return null;
  const parts = res.stdout.split("\0").filter((p) => p.length > 0);
  const out: ChangedFile[] = [];
  for (let i = 0; i < parts.length;) {
    const status = parts[i] ?? "";
    if (status.startsWith("R") || status.startsWith("C")) {
      const oldPath = parts[i + 1] ?? "";
      const path = parts[i + 2] ?? "";
      out.push({ status: status[0]!, path, oldPath });
      i += 3;
    } else {
      out.push({ status: status[0] ?? "M", path: parts[i + 1] ?? "", oldPath: null });
      i += 2;
    }
  }
  return out;
}

/** The unified diff BASE...TIP of PATHS (falls back to BASE..TIP when there is no merge base). */
export function diffText(
  root: string,
  base: string,
  tip: string,
  paths: ReadonlyArray<string> = [],
): string {
  if (!safeRev(base) || !safeRev(tip)) return "";
  const tail = paths.length > 0 ? ["--", ...paths] : [];
  const diff = (range: string) =>
    git(root, ["diff", ...NO_DIFF_DRIVERS, "--end-of-options", range, ...tail]);
  const three = diff(`${base}...${tip}`);
  if (three.code === 0) return three.stdout;
  const two = diff(`${base}..${tip}`);
  return two.code === 0 ? two.stdout : "";
}

export function originSlug(root: string): string | null {
  const res = git(root, ["remote", "get-url", "origin"]);
  const url = res.stdout.trim();
  if (res.code !== 0 || !url.includes("github.com")) return null;
  const tail = url.split("github.com")[1]!.replace(/^[:/]+/, "");
  return tail.endsWith(".git") ? tail.slice(0, -4) : tail;
}

/** The repo's name: its GitHub origin's, else the directory's. */
export function repoName(root: string): string {
  const slug = originSlug(root);
  return slug ? slug.split("/").at(-1)! : NodePath.basename(NodePath.resolve(root));
}

export function currentBranch(root: string): string {
  const show = git(root, ["branch", "--show-current"]).stdout.trim();
  if (show) return show;
  const abbrev = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim();
  return abbrev && abbrev !== "HEAD" ? abbrev : "detached";
}

export function commitMessages(root: string, base: string, tip: string): string {
  if (!safeRev(base) || !safeRev(tip)) return "";
  const log = (...args: string[]) =>
    git(root, ["log", ...NO_DIFF_DRIVERS, ...args.slice(0, -1), "--end-of-options", args.at(-1)!]);
  const res = log("--format=Commit %h: %s%n%b", `${base}..${tip}`);
  if (res.code === 0 && res.stdout.trim()) return res.stdout.trim();
  return log("-1", "--format=%B", tip).stdout.trim();
}

/** True when any tracked file differs from HEAD; null when git status cannot run. */
export function hasTrackedChanges(root: string): boolean | null {
  const res = git(root, ["status", "--porcelain", "--untracked-files=no"]);
  if (res.code !== 0) return null;
  return res.stdout.trim().length > 0;
}

/** True when RELPATH is tracked in the git index (e.g. to reject committed evidence receipts). */
export function isTrackedFile(root: string, relPath: string): boolean {
  if (!relPath || NodePath.isAbsolute(relPath) || relPath.includes("\0")) return false;
  return git(root, ["ls-files", "--error-unmatch", "--", relPath]).code === 0;
}
