// @effect-diagnostics nodeBuiltinImport:off - `git config` write guard: parses options the way git's parse-options does (unique-prefix long options, bundled short flags).
import * as NodePath from "node:path";

import type { HostGuardsConfig } from "./hostConfig.ts";
import { ALLOW_VERDICT, type GuardVerdict } from "./pushGuard.ts";
import { runHardenedGit, type RepoInfo } from "./repoScope.ts";

const HOOK_NAMES = new Set([
  "pre-commit",
  "pre-push",
  "commit-msg",
  "prepare-commit-msg",
  "pre-merge-commit",
]);
const GUARDED_CONFIG_RE = /^(core\.hookspath|include\.path|includeif\..*)$/i;

interface LongOption {
  readonly value: boolean;
  readonly negatable: boolean;
}
const flag = (negatable: boolean): LongOption => ({ value: false, negatable });
const valued: LongOption = { value: true, negatable: true };

/** Every long option of `git config` (all modes, git 2.53); `--no-<name>` where git allows it. */
const CONFIG_LONG_OPTIONS: Readonly<Record<string, LongOption>> = {
  global: flag(true),
  system: flag(true),
  local: flag(true),
  worktree: flag(true),
  file: valued,
  blob: valued,
  get: flag(false),
  "get-all": flag(false),
  "get-regexp": flag(false),
  "get-urlmatch": flag(false),
  "replace-all": flag(false),
  add: flag(false),
  unset: flag(false),
  "unset-all": flag(false),
  "rename-section": flag(false),
  "remove-section": flag(false),
  list: flag(false),
  edit: flag(false),
  "get-color": flag(false),
  "get-colorbool": flag(false),
  null: flag(true),
  "name-only": flag(true),
  "show-origin": flag(true),
  "show-scope": flag(true),
  "show-names": flag(true),
  type: valued,
  bool: flag(false),
  int: flag(false),
  "bool-or-int": flag(false),
  "bool-or-str": flag(false),
  path: flag(false),
  "expiry-date": flag(false),
  default: valued,
  comment: valued,
  "fixed-value": flag(true),
  includes: flag(true),
  all: flag(true),
  regexp: flag(true),
  value: valued,
  url: valued,
  append: flag(true),
};
const CONFIG_SHORT_OPTIONS: Readonly<Record<string, { readonly long: string }>> = {
  f: { long: "file" },
  t: { long: "type" },
  z: { long: "null" },
  l: { long: "list" },
  e: { long: "edit" },
};
const LONG_NAMES: ReadonlyArray<string> = Object.entries(CONFIG_LONG_OPTIONS).flatMap(
  ([name, opt]) => (opt.negatable ? [name, `no-${name}`] : [name]),
);

const READ_MODES = new Set(["get", "get-all", "get-regexp", "list", "get-color", "get-colorbool"]);
/** Options a read may carry before its key; anything else makes the call a write. */
const READ_OPTIONS = new Set([
  ...READ_MODES,
  "global",
  "system",
  "local",
  "worktree",
  "file",
  "blob",
  "type",
  "default",
  "show-origin",
  "show-scope",
  "show-names",
  "null",
  "name-only",
  "includes",
  "no-includes",
  "bool",
  "int",
  "bool-or-int",
  "bool-or-str",
  "path",
  "expiry-date",
]);
/** Section-wide edits: any key can become core.hooksPath or an include, so they are owner-only. */
const SECTION_EDITS = new Set(["rename-section", "remove-section", "edit"]);

type Resolved =
  | { readonly kind: "option"; readonly name: string; readonly takesValue: boolean }
  | { readonly kind: "bad"; readonly word: string };

/** git's rule: an exact name wins, else a unique prefix; anything else is refused. */
function resolveGitLongOption(
  word: string,
  names: ReadonlyArray<string> = LONG_NAMES,
): string | null {
  const body = word.slice(2);
  if (!body) return null;
  if (names.includes(body)) return body;
  const matches = names.filter((n) => n.startsWith(body));
  return matches.length === 1 ? matches[0]! : null;
}

function resolveLong(word: string): Resolved {
  const eq = word.indexOf("=");
  const name = resolveGitLongOption(eq === -1 ? word : word.slice(0, eq));
  if (name === null) return { kind: "bad", word };
  const opt = CONFIG_LONG_OPTIONS[name.replace(/^no-/, "")] ?? CONFIG_LONG_OPTIONS[name];
  const positive = Boolean(CONFIG_LONG_OPTIONS[name]);
  const takesValue = positive && opt?.value === true;
  if (eq !== -1 && !takesValue) return { kind: "bad", word };
  return { kind: "option", name, takesValue: takesValue && eq === -1 };
}

/** Splits a short bundle (`-ze`, `-fpath`) into options; a value option takes the rest. */
function resolveShort(word: string): {
  readonly names: ReadonlyArray<string>;
  readonly bad: boolean;
  readonly takesValue: boolean;
} {
  const names: string[] = [];
  for (let i = 1; i < word.length; i += 1) {
    const short = CONFIG_SHORT_OPTIONS[word[i]!];
    if (!short) return { names, bad: true, takesValue: false };
    names.push(short.long);
    if (CONFIG_LONG_OPTIONS[short.long]?.value) {
      return { names, bad: false, takesValue: i === word.length - 1 };
    }
  }
  return { names, bad: false, takesValue: false };
}

function isSectionEditWord(word: string): boolean {
  if (word.startsWith("--")) {
    const r = resolveLong(word);
    return r.kind === "option" && SECTION_EDITS.has(r.name);
  }
  return resolveShort(word).names.some((n) => SECTION_EDITS.has(n));
}

interface ParsedConfigArgs {
  readonly options: ReadonlyArray<string>;
  readonly positionals: ReadonlyArray<string>;
  /** An option git would not map to exactly one known option. */
  readonly bad: string | null;
  /** A section edit seen anywhere before `--`, including after positionals. */
  readonly sectionEdit: string | null;
}

/**
 * Options until the first positional or `--`, as git's parse-options stops there; later words are
 * positional. A long option after a positional that names a section edit still counts (fail closed).
 */
function parseConfigArgs(rest: ReadonlyArray<string>): ParsedConfigArgs {
  const options: string[] = [];
  const positionals: string[] = [];
  let bad: string | null = null;
  let sectionEdit: string | null = null;
  let parsing = true;
  let ended = false;
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i]!;
    if (!ended && (a === "--" || a === "--end-of-options")) {
      ended = true;
      parsing = false;
      continue;
    }
    if (!parsing || !a.startsWith("-") || a === "-") {
      if (positionals.length === 0 && !ended && SECTION_EDITS.has(a)) sectionEdit = a;
      if (!ended && positionals.length > 0 && a.startsWith("-") && isSectionEditWord(a)) {
        sectionEdit = a;
      }
      positionals.push(a);
      parsing = false;
      continue;
    }
    let names: ReadonlyArray<string>;
    let takesValue: boolean;
    if (a.startsWith("--")) {
      const r = resolveLong(a);
      if (r.kind === "bad") {
        bad ??= a;
        continue;
      }
      names = [r.name];
      takesValue = r.takesValue;
    } else {
      const r = resolveShort(a);
      if (r.bad) bad ??= a;
      names = r.names;
      takesValue = r.takesValue;
    }
    for (const name of names) {
      options.push(name);
      if (SECTION_EDITS.has(name)) sectionEdit ??= a;
    }
    if (takesValue) i += 1;
  }
  return { options, positionals, bad, sectionEdit };
}

function isConfigRead(parsed: ParsedConfigArgs): boolean {
  const { options, positionals } = parsed;
  if (options.some((o) => !READ_OPTIONS.has(o))) return false;
  if (options.some((o) => READ_MODES.has(o))) return positionals.length <= 1;
  if (positionals.length === 1) return true;
  return positionals.length === 2 && positionals[0] === "get";
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

export function checkGitConfigWrite(
  repo: RepoInfo,
  sub: ReadonlyArray<string>,
  config: HostGuardsConfig,
): GuardVerdict {
  const rest = sub.slice(1);
  const parsed = parseConfigArgs(rest);
  if (parsed.sectionEdit) {
    return {
      verdict: "deny",
      reason: `host git guard: refusing git config ${parsed.sectionEdit} in ${repo.slug}: a section edit can switch its hooks off; owner approval required.`,
    };
  }
  if (parsed.bad) {
    return {
      verdict: "deny",
      reason: `host git guard: refusing git config ${parsed.bad} in ${repo.slug}: the option is unknown or ambiguous; owner approval required.`,
    };
  }
  const keys = rest.filter((a) => GUARDED_CONFIG_RE.test(a));
  if (keys.length === 0) return ALLOW_VERDICT;
  if (isConfigRead(parsed)) return ALLOW_VERDICT;

  const firstKey = keys[0]!;
  if (firstKey.toLowerCase() !== "core.hookspath") {
    return {
      verdict: "deny",
      reason: `host git guard: refusing to write ${firstKey} in ${repo.slug}: an included file can switch its hooks off.`,
    };
  }
  const subcommand = parsed.positionals[0] ?? "";
  if (parsed.options.some((o) => o === "unset" || o === "unset-all") || subcommand === "unset") {
    return {
      verdict: "deny",
      reason: `host git guard: refusing to unset core.hooksPath in ${repo.slug}: it drops the repo's hooks.`,
    };
  }
  // Only `[set] core.hooksPath <dir>` with no other flag may set it, to a tracked hooks dir.
  const keyAt = subcommand === "set" ? 1 : 0;
  const plainSet =
    rest.every((w) => !w.startsWith("-")) &&
    parsed.positionals.length === keyAt + 2 &&
    parsed.positionals[keyAt] === firstKey;
  const value = plainSet ? (parsed.positionals.at(-1) ?? "") : "";
  if (!isTrackedHooksDir(repo, value, config)) {
    return {
      verdict: "deny",
      reason: `host git guard: refusing core.hooksPath=${value} in ${repo.slug}: only a hooks directory the repo tracks may be set.`,
    };
  }
  return ALLOW_VERDICT;
}
