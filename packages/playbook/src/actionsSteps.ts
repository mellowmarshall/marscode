// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Runs the repo's declared closure command and git plumbing, as the original playbook does.
/**
 * What `playbook actions required` runs and reads, as the original playbook does:
 * the repo's declared command (bash, in the checkout, credentials scrubbed, its own
 * process group, killed at the time limit), git at a commit (a read failure is told
 * apart from an absent file), the gate's base, and a scratch checkout of the base.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as Schema from "effect/Schema";

import { pyDecodeReplace, isPyJsonError, pyJsonLoads, pyReadText } from "./pyJson.ts";
import { isDict, PyDict, pyRepr, pySplitlines, pyStrip, type PyValue } from "./pyValues.ts";

const TREE_GUARD = ".tree-guard.conf";
const LIMIT = 1800;

/** Inherited names a declared command never sees: credentials and the ways to borrow one. */
const SECRET_NAMES =
  /^(?:GH_|GITHUB_|GIT_ASKPASS|SSH_AUTH_SOCK|SSH_AGENT|DOPPLER_|OP_|ANTHROPIC_|OPENAI_|GEMINI_|GOOGLE_|CLAUDE_|AWS_|AZURE_|FLY_|HCLOUD_|CLOUDFLARE_|NEON_|VERCEL_|UPSTASH_|NPM_TOKEN|NODE_AUTH_TOKEN|HOST_GUARD_OVERRIDE|SHIP_QUEUE_OVERRIDE|PGPASSFILE|PGSERVICE)|(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|CREDENTIALS?)(?:_|$)/i;

const GIT_CLEARED = new Set([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_REPLACE_REF_BASE",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
]);

/** The environment of one git call: no inherited git location or config override, no replace refs or grafts. */
function gitEnv(base: NodeJS.ProcessEnv, extra: Record<string, string>): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(base).filter(
      ([k]) =>
        !GIT_CLEARED.has(k) &&
        !k.startsWith("GIT_CONFIG_KEY_") &&
        !k.startsWith("GIT_CONFIG_VALUE_"),
    ),
  );
  return { ...env, GIT_NO_REPLACE_OBJECTS: "1", GIT_GRAFT_FILE: "/dev/null", ...extra };
}

const universal = (b: Buffer) => pyDecodeReplace(b).replaceAll("\r\n", "\n").replaceAll("\r", "\n");

/** Repo config that could run code is switched off; it changes no output git gives here. */
const SAFE = ["-c", "core.fsmonitor=", "-c", "core.hooksPath=/dev/null"];

interface GitOut {
  readonly code: number;
  readonly stdout: Buffer;
}

function git(
  env: NodeJS.ProcessEnv,
  cwd: string,
  args: ReadonlyArray<string>,
  extra: Record<string, string> = {},
): GitOut {
  const res = NodeChildProcess.spawnSync("git", ["-C", cwd, ...SAFE, ...args], {
    env: gitEnv(env, extra),
    maxBuffer: 1024 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (res.error) return { code: 127, stdout: Buffer.alloc(0) };
  return { code: res.status ?? 1, stdout: res.stdout };
}

/** git could not answer (as opposed to answering "absent"). */
export class GitError extends Schema.TaggedError<GitError>()("GitError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

export const isGitError = Schema.is(GitError);

export function resolveRev(env: NodeJS.ProcessEnv, root: string, rev: string): string | null {
  const res = git(env, root, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]);
  return res.code === 0 ? res.stdout.toString("utf8").trim() : null;
}

/** A file's bytes at REV; null when REV does not hold the path; GitError on any other failure. */
function gitShowBytes(
  env: NodeJS.ProcessEnv,
  root: string,
  rev: string,
  path: string,
): Buffer | null {
  if (resolveRev(env, root, rev) === null) {
    throw new GitError({ detail: `${rev} is not a commit here` });
  }
  if (git(env, root, ["cat-file", "-e", `${rev}:${path}`]).code !== 0) {
    const listed = git(env, root, ["ls-tree", "--name-only", rev, "--", path]);
    if (listed.code === 0 && !listed.stdout.toString("utf8").trim()) return null;
    throw new GitError({ detail: `git cannot read ${rev}:${path}` });
  }
  const shown = git(env, root, ["show", `${rev}:${path}`]);
  if (shown.code !== 0) throw new GitError({ detail: `git show ${rev}:${path} failed` });
  return shown.stdout;
}

/** A file's text at REV (newlines as Python's text mode reads them), as gitShowBytes. */
export function gitShow(
  env: NodeJS.ProcessEnv,
  root: string,
  rev: string,
  path: string,
): string | null {
  const bytes = gitShowBytes(env, root, rev, path);
  return bytes === null ? null : universal(bytes);
}

function parseConf(text: string): Map<string, string[]> {
  const conf = new Map<string, string[]>();
  for (const raw of pySplitlines(text)) {
    const line = pyStrip(raw);
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const at = line.indexOf("=");
    const key = pyStrip(line.slice(0, at));
    conf.set(key, [...(conf.get(key) ?? []), pyStrip(line.slice(at + 1))]);
  }
  return conf;
}

/** The gate's base commit, as the original's gate_base finds it; null when there is none. */
export function gateBaseSha(env: NodeJS.ProcessEnv, root: string): string | null {
  for (const name of ["SHIP_QUEUE_ONTO", "SHIP_QUEUE_BASE_SHA"]) {
    const value = env[name];
    if (value) return resolveRev(env, root, value);
  }
  const head = git(env, root, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
  const ref = head.stdout.toString("utf8").trim();
  if (head.code !== 0 || !ref.startsWith("refs/remotes/")) return null;
  const start = ref.slice("refs/remotes/".length);
  if (resolveRev(env, root, start) === null) return null;
  let confText: string | null;
  try {
    confText = gitShow(env, root, start, TREE_GUARD);
  } catch {
    return null;
  }
  const declared = parseConf(confText ?? "").get("base_ref");
  return resolveRev(env, root, declared?.at(-1) ?? start);
}

/** A file in the working tree as the original's on_disk reads it: bytes, decoded with replacement. */
export function readOnDisk(root: string, rel: string): string | null {
  try {
    return pyDecodeReplace(NodeFS.readFileSync(NodePath.join(root, rel)));
  } catch {
    return null;
  }
}

/** The catalog's actions (in the tree, or at REV); {} when it cannot be read, or is not UTF-8. */
export function catalogActions(
  env: NodeJS.ProcessEnv,
  root: string,
  catalog: string,
  rev: string | null = null,
): PyDict {
  try {
    let text: string | null;
    if (rev) {
      const bytes = gitShowBytes(env, root, rev, catalog);
      text = bytes === null ? null : pyReadText(bytes);
    } else {
      try {
        text = pyReadText(NodeFS.readFileSync(NodePath.join(root, catalog)));
      } catch (cause) {
        if (isPyJsonError(cause)) throw cause;
        text = null;
      }
    }
    const data = pyJsonLoads(text || "{}");
    const acts = isDict(data) ? data.get("actions") : undefined;
    return isDict(acts) ? acts : new PyDict();
  } catch (cause) {
    if (isGitError(cause) || isPyJsonError(cause)) return new PyDict();
    throw cause;
  }
}

export interface Ran {
  /** null: the command did not run. */
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly why: string | null;
}

/** The last LINES non-blank lines the command printed (stdout, then stderr). */
function tail(ran: Ran, lines: number): string[] {
  const text = [ran.stdout, ran.stderr].filter((t) => t).join("\n");
  return pySplitlines(text)
    .filter((l) => pyStrip(l))
    .slice(-lines);
}

function stepLimit(env: NodeJS.ProcessEnv): number {
  const raw = env.PLAYBOOK_STEP_SECONDS;
  if (raw === undefined) return LIMIT;
  const text = pyStrip(raw);
  if (!/^[+-]?\d+(?:_\d+)*$/.test(text)) return LIMIT;
  return Math.max(1, Number(text.replaceAll("_", "")));
}

const SIGNALS = NodeOS.constants.signals as Readonly<Record<string, number>>;
/** The longest delay setTimeout keeps (a longer one fires at once). */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** Python's OSError text for a spawn of bash in ROOT that failed with CAUSE. */
function spawnFailure(root: string, cause: NodeJS.ErrnoException): string {
  const what = NodeFS.existsSync(root) ? "bash" : root;
  if (cause.code === "ENOENT") return `[Errno 2] No such file or directory: ${pyRepr(what)}`;
  if (cause.code === "EACCES") return `[Errno 13] Permission denied: ${pyRepr(what)}`;
  return cause.message;
}

/** COMMAND in ROOT through bash with ENV added to the scrubbed environment; exit 126 or 127 did not run. */
function runStep(
  base: NodeJS.ProcessEnv,
  root: string,
  command: string,
  env: Record<string, string>,
): Promise<Ran> {
  const full: NodeJS.ProcessEnv = {
    ...Object.fromEntries(Object.entries(base).filter(([k]) => !SECRET_NAMES.test(k))),
    ...env,
  };
  const limit = stepLimit(base);
  return new Promise((done) => {
    let child: NodeChildProcess.ChildProcess;
    try {
      child = NodeChildProcess.spawn("bash", ["-c", command], {
        cwd: root,
        env: full,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
    } catch (cause) {
      const why = spawnFailure(root, cause as NodeJS.ErrnoException);
      done({ code: null, stdout: "", stderr: "", why: `it could not start: ${why}` });
      return;
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;
    child.stdout!.on("data", (b: Buffer) => out.push(b));
    child.stderr!.on("data", (b: Buffer) => err.push(b));
    const timer = setTimeout(
      () => {
        timedOut = true;
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {
          // The group is already gone.
        }
      },
      Math.min(limit * 1000, MAX_TIMER_MS),
    );
    child.on("error", (cause) => {
      clearTimeout(timer);
      done({
        code: null,
        stdout: "",
        stderr: "",
        why: `it could not start: ${spawnFailure(root, cause)}`,
      });
    });
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        done({ code: null, stdout: "", stderr: "", why: `it did not finish in ${limit} s` });
        return;
      }
      const stdout = universal(Buffer.concat(out));
      const stderr = universal(Buffer.concat(err));
      const code = status ?? -(SIGNALS[signal ?? ""] ?? 1);
      if (code === 126 || code === 127) {
        const last = pySplitlines(pyStrip(stderr || stdout)).at(-1) ?? `exit ${code}`;
        done({
          code: null,
          stdout,
          stderr,
          why: `it could not start: ${[...last].slice(0, 200).join("")}`,
        });
        return;
      }
      done({ code, stdout, stderr, why: null });
    });
  });
}

/** The commit's tree in a scratch git repository of its own, or null when git cannot write it. */
export async function withScratchCheckout<T>(
  env: NodeJS.ProcessEnv,
  root: string,
  sha: string,
  use: (tree: string | null) => Promise<T>,
): Promise<T> {
  const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "playbook-base-"));
  const tree = NodePath.join(scratch, "tree");
  const index = NodePath.join(scratch, "index");
  try {
    NodeFS.mkdirSync(tree);
    const ok =
      git(env, root, ["read-tree", sha], { GIT_INDEX_FILE: index }).code === 0 &&
      git(env, root, [`--work-tree=${tree}`, "checkout-index", "-a", "-f"], {
        GIT_INDEX_FILE: index,
      }).code === 0 &&
      git(env, tree, ["init", "-q"]).code === 0 &&
      git(env, tree, ["add", "-A", "-f"]).code === 0;
    return await use(ok ? tree : null);
  } finally {
    NodeFS.rmSync(scratch, { recursive: true, force: true });
  }
}

/** (each action's digest, why there is none): the repo's closure command, as the original runs it. */
export async function closure(
  env: NodeJS.ProcessEnv,
  root: string,
  command: PyValue | undefined,
  base: string,
): Promise<[Map<string, string> | null, string | null]> {
  if (!(typeof command === "string" && pyStrip(command))) {
    return [null, "actions/closure: contracts.actions.closure is not declared"];
  }
  const ran = await runStep(env, root, command, { PLAYBOOK_BASE: base });
  if (ran.code === null) return [null, `actions/closure: \`${command}\` did not run: ${ran.why}`];
  if (ran.code !== 0) {
    return [
      null,
      `actions/closure: \`${command}\` exited ${ran.code}: ${tail(ran, 5).join(" | ")}`,
    ];
  }
  let data: PyValue;
  try {
    data = pyJsonLoads(ran.stdout);
  } catch (cause) {
    if (!isPyJsonError(cause)) throw cause;
    return [null, `actions/closure: \`${command}\` printed no JSON (${cause.message})`];
  }
  if (
    !isDict(data) ||
    !data.entries().every(([, v]) => typeof v === "string" && v !== "" && v === pyStrip(v))
  ) {
    return [null, `actions/closure: \`${command}\` did not print {"<action id>": "<digest>"}`];
  }
  return [new Map(data.entries() as Array<[string, string]>), null];
}
