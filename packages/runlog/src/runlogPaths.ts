// @effect-diagnostics nodeBuiltinImport:off - headless CLI library on node:* builtins only.
/**
 * Run-log names and files: `<root>/<repo>/<name>-<UTC stamp>[-N].log`. A run
 * never writes another run's log: a second run in the same second gets -2, -3,
 * ... and O_EXCL decides, not a check before.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

/** A longer name keeps its head and a hash of the whole. */
export const NAME_MAX = 60;
const MAX_SUFFIX = 1000;

/** A file-name-safe form of a name. */
export function slug(s: string): string {
  const out = s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  return out || "run";
}

/** A file-name-safe name of at most NAME_MAX characters, so two long commands stay apart. */
export function shortName(name: string): string {
  const s = slug(name);
  if (s.length <= NAME_MAX) return s;
  const hash = NodeCrypto.createHash("sha1").update(s).digest("hex").slice(0, 8);
  return `${s.slice(0, NAME_MAX - 9).replace(/[-.]+$/, "")}-${hash}`;
}

/** The program and its first argument that is not an option: "go-test", "bash-x.test.sh". */
export function defaultName(cmd: ReadonlyArray<string>): string {
  const rest = cmd.slice(1).find((a) => !a.startsWith("-")) ?? "";
  return slug(
    [cmd[0] ?? "", rest]
      .filter((a) => a !== "")
      .map((a) => NodePath.basename(a))
      .join("-"),
  );
}

/** The repository's name, a linked worktree's too (its common .git's parent); else the directory's. */
export function repoName(cwd: string): string {
  const res = NodeChildProcess.spawnSync(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    { cwd, encoding: "utf8", timeout: 10_000 },
  );
  const common = res.status === 0 ? res.stdout.trim() : "";
  if (common) {
    const base = NodePath.basename(common);
    return slug(
      base === ".git" ? NodePath.basename(NodePath.dirname(common)) : base.replace(/\.git$/, ""),
    );
  }
  return slug(NodePath.basename(cwd));
}

/** `20261127T043127Z`. */
export function utcStamp(epochMs: number): string {
  // @effect-diagnostics-next-line globalDate:off
  return new Date(epochMs)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
}

export interface OpenedLog {
  readonly path: string;
  readonly fd: number;
}

export interface OpenLogInput {
  readonly root: string;
  readonly cwd: string;
  readonly name: string | null;
  readonly cmd: ReadonlyArray<string>;
  readonly nowMs: number;
}

/** Creates this run's log file, exclusively. */
export function openLog(input: OpenLogInput): OpenedLog {
  const dir = NodePath.join(input.root, repoName(input.cwd));
  NodeFS.mkdirSync(dir, { recursive: true });
  const base = `${shortName(input.name ?? defaultName(input.cmd))}-${utcStamp(input.nowMs)}`;
  for (let n = 1; n < MAX_SUFFIX; n += 1) {
    const path = NodePath.join(dir, `${base}${n > 1 ? `-${n}` : ""}.log`);
    try {
      return { path, fd: NodeFS.openSync(path, "wx", 0o644) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
  }
  throw new Error(`no free log name for ${base} in ${dir}`);
}

export interface LogEntry {
  readonly path: string;
  readonly mtimeMs: number;
}

/** The logs in `<root>/<repo>`, newest first. */
export function listLogs(root: string, repo: string): LogEntry[] {
  const dir = NodePath.join(root, repo);
  let names: string[];
  try {
    names = NodeFS.readdirSync(dir);
  } catch {
    return [];
  }
  const out: LogEntry[] = [];
  for (const name of names) {
    if (!name.endsWith(".log")) continue;
    const path = NodePath.join(dir, name);
    try {
      const st = NodeFS.statSync(path);
      if (st.isFile()) out.push({ path, mtimeMs: st.mtimeMs });
    } catch {
      continue;
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.path < b.path ? 1 : -1));
}
