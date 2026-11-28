// @effect-diagnostics nodeBuiltinImport:off - Git CLI argument parsers (globals, no-verify, checkout/branch/config classification, aliases).
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { HostGuardsConfig } from "./hostConfig.ts";
import { ALLOW_VERDICT, type GuardVerdict } from "./pushGuard.ts";
import { runHardenedGit, type RepoInfo } from "./repoScope.ts";

const GLOBAL_VALUE_OPTS = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--config-env",
  "--super-prefix",
  "--attr-source",
  "--list-cmds",
  "--exec-path",
]);

const NO_VERIFY_SUBS = new Set(["commit", "push", "merge", "rebase", "am", "pull"]);
const HOOK_NAMES = new Set([
  "pre-commit",
  "pre-push",
  "commit-msg",
  "prepare-commit-msg",
  "pre-merge-commit",
]);
const COMMIT_VALUE_SHORTS = new Set(["m", "F", "c", "C", "t", "S"]);
const GUARDED_CONFIG_RE = /^(core\.hookspath|include\.path|includeif\..*)$/i;
const CHECKOUT_BRANCH_FLAGS = new Set(["-b", "-B", "--orphan", "--detach", "-d", "-t", "--track"]);
const CHECKOUT_VAL_FLAGS = new Set(["-b", "-B", "--orphan", "--conflict", "--pathspec-from-file"]);

const BRANCH_LIST_MODE = new Set([
  "-l",
  "--list",
  "--merged",
  "--no-merged",
  "--contains",
  "--no-contains",
  "--points-at",
]);
const BRANCH_VALUE_REQUIRED = new Set(["--sort", "--format", "--points-at"]);
const BRANCH_VALUE_OPTIONAL = new Set(["--merged", "--no-merged", "--contains", "--no-contains"]);
const BRANCH_LIST_FLAGS = new Set([
  ...BRANCH_LIST_MODE,
  ...BRANCH_VALUE_REQUIRED,
  "-a",
  "--all",
  "-r",
  "--remotes",
  "--show-current",
  "-v",
  "-vv",
  "--verbose",
  "-i",
  "--ignore-case",
  "--omit-empty",
  "--column",
  "--no-column",
  "--color",
  "--no-color",
  "--abbrev",
  "--no-abbrev",
  "-q",
  "--quiet",
]);

export function splitGitGlobals(
  args: ReadonlyArray<string>,
  initialCwd: string,
  env: NodeJS.ProcessEnv = process.env,
): {
  readonly configs: ReadonlyArray<string>;
  readonly cwd: string;
  readonly sub: ReadonlyArray<string>;
  readonly extraEnv: Record<string, string>;
} {
  const configs: string[] = [];
  const extraEnv: Record<string, string> = {};
  let cwd = initialCwd;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    if (!a.startsWith("-")) {
      return { configs, cwd, sub: args.slice(i), extraEnv };
    }
    const eq = a.indexOf("=");
    const name = eq === -1 ? a : a.slice(0, eq);
    let value = eq === -1 ? "" : a.slice(eq + 1);
    if (GLOBAL_VALUE_OPTS.has(name)) {
      if (eq === -1) {
        value = i + 1 < args.length ? args[i + 1]! : "";
        i += 1;
      }
      if (name === "-C") {
        cwd = NodePath.resolve(cwd, value);
      } else if (name === "-c") {
        configs.push(value);
      } else if (name === "--config-env") {
        const veq = value.indexOf("=");
        const key = veq === -1 ? value : value.slice(0, veq);
        const varName = veq === -1 ? "" : value.slice(veq + 1);
        configs.push(`${key}=${env[varName] ?? ""}`);
      } else if (name === "--git-dir" || name === "--work-tree") {
        extraEnv[name === "--git-dir" ? "GIT_DIR" : "GIT_WORK_TREE"] = NodePath.resolve(cwd, value);
      }
    }
  }
  return { configs, cwd, sub: [], extraEnv };
}

function isTrackedHooksDir(repo: RepoInfo, value: string, config: HostGuardsConfig): boolean {
  if (!value || NodePath.isAbsolute(value) || value.split("/").includes("..")) {
    return false;
  }
  const trimmed = value.replace(/^\/+|\/+$/g, "");
  const listing =
    runHardenedGit(repo.top, ["ls-tree", "--name-only", `HEAD:${trimmed}`], config) ?? "";
  return listing.split(/\s+/).some((name) => HOOK_NAMES.has(name));
}

const CONFIG_VALUE_FLAGS = new Set([
  "-f",
  "--file",
  "--blob",
  "--type",
  "--default",
  "--comment",
  "--value",
]);
const CONFIG_READ_MODES = new Set(["--get", "--get-all", "--get-regexp", "--list", "-l"]);
/** Flags a read may carry before its key; anything else makes the call a write. */
const CONFIG_READ_FLAGS = new Set([
  "--local",
  "--global",
  "--system",
  "--worktree",
  "--show-origin",
  "--show-scope",
  "--null",
  "-z",
  "--name-only",
  "--includes",
  "--no-includes",
  "--bool",
  "--int",
  "--bool-or-int",
  "--path",
  "--expiry-date",
]);
/** Section-wide edits: any key can become core.hooksPath or an include, so they are owner-only. */
const CONFIG_SECTION_EDITS = new Set([
  "--rename-section",
  "--remove-section",
  "-e",
  "--edit",
  "rename-section",
  "remove-section",
  "edit",
]);

/**
 * Splits `git config` arguments: options until the first positional (or `--`), then every word
 * is positional, whatever it looks like. `unknown` marks an option no read may carry.
 */
function splitConfigArgs(rest: ReadonlyArray<string>): {
  readonly readMode: boolean;
  readonly positionals: ReadonlyArray<string>;
  readonly unknown: boolean;
} {
  const positionals: string[] = [];
  let readMode = false;
  let unknown = false;
  let parsing = true;
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i]!;
    if (parsing && (a === "--" || a === "--end-of-options")) {
      parsing = false;
      continue;
    }
    if (!parsing || positionals.length > 0 || !a.startsWith("-") || a === "-") {
      positionals.push(a);
      continue;
    }
    const name = a.startsWith("--") && a.includes("=") ? a.slice(0, a.indexOf("=")) : a;
    if (CONFIG_VALUE_FLAGS.has(name)) {
      if (name === a) i += 1;
    } else if (CONFIG_READ_MODES.has(a)) {
      readMode = true;
    } else if (!CONFIG_READ_FLAGS.has(a)) {
      unknown = true;
    }
  }
  return { readMode, positionals, unknown };
}

/** Whether `git config` is one of the exact read shapes; everything else is a write. */
function isConfigRead(rest: ReadonlyArray<string>): boolean {
  const { readMode, positionals, unknown } = splitConfigArgs(rest);
  if (unknown) return false;
  if (readMode) return positionals.length <= 1;
  if (positionals.length === 1) return true;
  return (
    (positionals.length === 2 && positionals[0] === "get") ||
    (positionals.length === 1 && positionals[0] === "list")
  );
}

export function checkGitConfigWrite(
  repo: RepoInfo,
  sub: ReadonlyArray<string>,
  config: HostGuardsConfig,
): GuardVerdict {
  const rest = sub.slice(1);
  const terminator = rest.findIndex((a) => a === "--" || a === "--end-of-options");
  const optionRegion = terminator === -1 ? rest : rest.slice(0, terminator);
  // git also reads options after positionals, so a section edit anywhere before `--` counts.
  const { positionals } = splitConfigArgs(rest);
  const subcommand = positionals[0] ?? "";
  const sectionEdit =
    optionRegion.find((w) => w.startsWith("-") && CONFIG_SECTION_EDITS.has(w.split("=", 1)[0]!)) ??
    (CONFIG_SECTION_EDITS.has(subcommand) ? subcommand : undefined);
  if (sectionEdit) {
    return {
      verdict: "deny",
      reason: `host git guard: refusing git config ${sectionEdit} in ${repo.slug}: a section edit can switch its hooks off; owner approval required.`,
    };
  }
  const keys = rest.filter((a) => GUARDED_CONFIG_RE.test(a));
  if (keys.length === 0) return ALLOW_VERDICT;
  if (isConfigRead(rest)) return ALLOW_VERDICT;

  const firstKey = keys[0]!;
  if (firstKey.toLowerCase() !== "core.hookspath") {
    return {
      verdict: "deny",
      reason: `host git guard: refusing to write ${firstKey} in ${repo.slug}: an included file can switch its hooks off.`,
    };
  }
  if (rest.some((o) => o.startsWith("--unset")) || subcommand === "unset") {
    return {
      verdict: "deny",
      reason: `host git guard: refusing to unset core.hooksPath in ${repo.slug}: it drops the repo's hooks.`,
    };
  }
  // Only `[set] core.hooksPath <dir>` with no other flag may set it, to a tracked hooks dir.
  const keyAt = subcommand === "set" ? 1 : 0;
  const plainSet =
    rest.every((w) => !w.startsWith("-")) &&
    positionals.length === keyAt + 2 &&
    positionals[keyAt] === firstKey;
  const value = plainSet ? (positionals.at(-1) ?? "") : "";
  if (!isTrackedHooksDir(repo, value, config)) {
    return {
      verdict: "deny",
      reason: `host git guard: refusing core.hooksPath=${value} in ${repo.slug}: only a hooks directory the repo tracks may be set.`,
    };
  }
  return ALLOW_VERDICT;
}

export function hasNoVerifyFlag(sub: ReadonlyArray<string>): boolean {
  const name = sub[0] ?? "";
  if (!NO_VERIFY_SUBS.has(name)) return false;
  for (const a of sub.slice(1)) {
    if (a === "--") return false;
    const base = a.split("=", 1)[0] ?? "";
    if (base.length >= 6 && base.startsWith("--no-v") && "--no-verify".startsWith(base)) {
      return true;
    }
    if (name === "commit" && /^-[A-Za-z]+$/.test(a)) {
      for (const ch of a.slice(1)) {
        if (ch === "n") return true;
        if (COMMIT_VALUE_SHORTS.has(ch)) break;
      }
    }
  }
  return false;
}

export function isCheckoutBranchOp(
  sub: ReadonlyArray<string>,
  cwd: string,
  runEnv: NodeJS.ProcessEnv,
  config: HostGuardsConfig,
): boolean {
  const args = sub.slice(1);
  if (
    args.some(
      (a) =>
        CHECKOUT_BRANCH_FLAGS.has(a) ||
        a.startsWith("-b") ||
        a.startsWith("-B") ||
        a.startsWith("--orphan="),
    )
  ) {
    return true;
  }
  if (args.includes("--")) return false;
  const targets: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    if (a.startsWith("-")) {
      if (CHECKOUT_VAL_FLAGS.has(a)) i += 1;
    } else {
      targets.push(a);
    }
  }
  if (targets.length !== 1) return false;
  const target = targets[0]!;
  if (
    runHardenedGit(cwd, ["rev-parse", "--verify", `refs/heads/${target}`], config, runEnv) !== null
  ) {
    return true;
  }
  if (
    target !== "HEAD" &&
    runHardenedGit(
      cwd,
      ["rev-parse", "--verify", `refs/remotes/origin/${target}`],
      config,
      runEnv,
    ) !== null
  ) {
    return true;
  }
  if (NodeFS.existsSync(NodePath.join(cwd, target))) return false;
  if (runHardenedGit(cwd, ["ls-files", "--error-unmatch", "--", target], config, runEnv) !== null) {
    return false;
  }
  return true;
}

export function isBranchCreation(sub: ReadonlyArray<string>): boolean {
  const args = sub.slice(1);
  const options: string[] = [];
  const words: string[] = [];
  let ended = false;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    if (ended || !a.startsWith("-") || a === "-") {
      words.push(a);
    } else if (a === "--") {
      ended = true;
    } else {
      options.push(a);
      if (
        !a.includes("=") &&
        i + 1 < args.length &&
        (BRANCH_VALUE_REQUIRED.has(a) ||
          (BRANCH_VALUE_OPTIONAL.has(a) && !(args[i + 1] ?? "").startsWith("-")))
      ) {
        i += 1;
      }
    }
  }
  if (
    options.some(
      (o) =>
        o === "-d" || o === "-D" || o === "--delete" || o.startsWith("-d") || o.startsWith("-D"),
    )
  ) {
    return false;
  }
  if (options.some((o) => !BRANCH_LIST_FLAGS.has(o.split("=", 1)[0] ?? ""))) {
    return true;
  }
  return words.length > 0 && !options.some((o) => BRANCH_LIST_MODE.has(o.split("=", 1)[0] ?? ""));
}

export function splitSimpleAliasArgs(raw: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]!;
    if (quote) {
      if (ch === "\\" && quote === '"' && i + 1 < raw.length) {
        cur += raw[i + 1]!;
        i += 1;
      } else if (ch === quote) {
        quote = null;
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === "\\" && i + 1 < raw.length) {
      cur += raw[i + 1]!;
      i += 1;
    } else if (/\s/.test(ch)) {
      if (cur) {
        out.push(cur);
        cur = "";
      }
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}
