// @effect-diagnostics nodeBuiltinImport:off - Shared GitHub CLI (`gh`) flag, target repo, and alias argument parser.
import * as NodeChildProcess from "node:child_process";

import type { HostGuardsConfig } from "./hostConfig.ts";
import { inspectRepo, parseRepoSlugArg, type RepoInfo } from "./repoScope.ts";

const GH_ITEM_URL_RE = /^https?:\/\/github\.com\/[^/]+\/[^/]+\/(?:pull|issues)\/\d+(?:\/.*)?$/i;

export const MAX_GH_ALIAS_DEPTH = 8;

const GH_GLOBAL_VALUE_FLAGS = new Set(
  "-R --repo --hostname --subject --author-email -A --match-head-commit -X --method -f --raw-field -F --field --input -H --header -q --jq -t --template -p --preview --cache".split(
    " ",
  ),
);

const GH_COMMANDS = new Set(
  "agent-task alias api attestation auth browse cache codespace completion config copilot extension gist gpg-key help issue label org pr preview project release repo ruleset run search secret ssh-key status variable workflow agent-session version --version --help -h".split(
    " ",
  ),
);

export const GH_HIGH_LEVEL_VALUE_FLAGS = new Set(
  "-R --repo -B --base -H --head -t --title -l --label -a --assignee -r --reviewer -m --milestone -p --project -T --template --add-label --remove-label --add-assignee --remove-assignee --add-reviewer --remove-reviewer --add-project --remove-project --recover --hostname".split(
    " ",
  ),
);

export const GH_API_OTHER_VALUE_FLAGS = new Set(
  "-X --method -H --header -q --jq -t --template --hostname -p --preview --cache".split(" "),
);

export interface MatchedValueFlag {
  readonly value: string;
  readonly step: number;
  readonly setValue: (next: string) => void;
}

export function resolveEnvGhRepoSlug(env: NodeJS.ProcessEnv = process.env): string | null {
  return parseRepoSlugArg(env.GH_REPO ?? "");
}

export function extractGhCommandTokens(
  args: ReadonlyArray<string>,
): Array<{ readonly index: number; readonly word: string }> {
  const tokens: Array<{ readonly index: number; readonly word: string }> = [];
  let skip = false;
  for (let i = 0; i < args.length; i += 1) {
    if (skip) {
      skip = false;
      continue;
    }
    const word = args[i]!;
    if (GH_GLOBAL_VALUE_FLAGS.has(word)) {
      skip = true;
      continue;
    }
    if (word.startsWith("-")) continue;
    tokens.push({ index: i, word: word.toLowerCase() });
  }
  return tokens;
}

export function expandGhAlias(
  args: ReadonlyArray<string>,
  cwd: string,
  config: HostGuardsConfig,
):
  | { readonly shell: true; readonly body: string }
  | { readonly shell: false; readonly expanded: ReadonlyArray<string> }
  | null {
  const tokens = extractGhCommandTokens(args);
  if (tokens.length === 0 || GH_COMMANDS.has(tokens[0]!.word)) return null;
  const res = NodeChildProcess.spawnSync(config.realGh, ["alias", "list"], {
    cwd,
    encoding: "utf8",
    timeout: 15_000,
  });
  if (res.status !== 0) return null;
  const firstWord = tokens[0]!.word;
  for (const line of (res.stdout ?? "").split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const aliasName = line.slice(0, colon).trim().toLowerCase();
    if (aliasName !== firstWord) continue;
    const rawExpansion = line
      .slice(colon + 1)
      .trim()
      .replace(/^'+|'+$/g, "");
    if (rawExpansion.startsWith("!")) {
      return { shell: true, body: rawExpansion };
    }
    const parts = rawExpansion.split(/\s+/).filter(Boolean);
    const idx = tokens[0]!.index;
    return {
      shell: false,
      expanded: [...args.slice(0, idx), ...parts, ...args.slice(idx + 1)],
    };
  }
  return null;
}

/** Expands chained non-shell `gh` aliases up to `MAX_GH_ALIAS_DEPTH`, returning `null` if none or unsafe. */
export function expandNonShellGhAliases(
  args: ReadonlyArray<string>,
  cwd: string,
  config: HostGuardsConfig,
): ReadonlyArray<string> | null {
  let current = args;
  let expandedAny = false;
  const seen = new Set<string>();
  for (let depth = 0; depth < MAX_GH_ALIAS_DEPTH; depth += 1) {
    const alias = expandGhAlias(current, cwd, config);
    if (alias === null) return expandedAny ? current : null;
    if (alias.shell) return null;
    const aliasName = extractGhCommandTokens(current)[0]?.word ?? "";
    if (!aliasName || seen.has(aliasName)) return null;
    seen.add(aliasName);
    current = alias.expanded;
    expandedAny = true;
  }
  return null;
}

/** Matches a flag with separate, `=`, or attached short value and returns a mutator for `args`. */
export function matchGhValueFlag(
  args: string[],
  index: number,
  shortFlag: string | null,
  longFlag: string,
): MatchedValueFlag | null {
  const a = args[index]!;
  if (a === longFlag || (shortFlag !== null && a === shortFlag)) {
    if (index + 1 >= args.length) return null;
    return {
      value: args[index + 1]!,
      step: 1,
      setValue: (v) => {
        args[index + 1] = v;
      },
    };
  }
  if (a.startsWith(`${longFlag}=`)) {
    const prefix = `${longFlag}=`;
    return {
      value: a.slice(prefix.length),
      step: 0,
      setValue: (v) => {
        args[index] = `${prefix}${v}`;
      },
    };
  }
  if (shortFlag !== null && a.startsWith(`${shortFlag}=`)) {
    const prefix = `${shortFlag}=`;
    return {
      value: a.slice(prefix.length),
      step: 0,
      setValue: (v) => {
        args[index] = `${prefix}${v}`;
      },
    };
  }
  if (
    shortFlag !== null &&
    !a.startsWith("--") &&
    a.startsWith(shortFlag) &&
    a.length > shortFlag.length
  ) {
    return {
      value: a.slice(shortFlag.length),
      step: 0,
      setValue: (v) => {
        args[index] = `${shortFlag}${v}`;
      },
    };
  }
  return null;
}

export function extractLeadingGhCommands(args: ReadonlyArray<string>): ReadonlyArray<string> {
  const words: string[] = [];
  for (let i = 0; i < args.length && words.length < 2; i += 1) {
    const a = args[i]!;
    if (a === "--") break;
    if (a === "-R" || a === "--repo" || a === "--hostname") {
      i += 1;
      continue;
    }
    if (!a.startsWith("-")) words.push(a.toLowerCase());
  }
  return words;
}

export function inspectGhCommandTarget(
  args: ReadonlyArray<string>,
  cwd: string,
  config: HostGuardsConfig,
  env: NodeJS.ProcessEnv = process.env,
): {
  readonly slug: string | null;
  readonly repo: RepoInfo | null;
  readonly baseBranch: string | null;
} {
  let explicitSlug: string | null = null;
  let urlSlug: string | null = null;
  let baseBranch: string | null = null;

  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    if (a === "--") {
      for (const pos of args.slice(i + 1)) {
        if (GH_ITEM_URL_RE.test(pos.trim())) urlSlug = parseRepoSlugArg(pos);
      }
      break;
    }
    const eq = a.startsWith("-") ? a.indexOf("=") : -1;
    const flag = eq === -1 ? a : a.slice(0, eq);
    if (
      GH_HIGH_LEVEL_VALUE_FLAGS.has(flag) ||
      flag === "-b" ||
      flag === "--body" ||
      flag === "-F" ||
      flag === "--body-file"
    ) {
      const val = eq === -1 ? (args[i + 1] ?? "") : a.slice(eq + 1);
      if (eq === -1) i += 1;
      if (flag === "-R" || flag === "--repo") explicitSlug = parseRepoSlugArg(val);
      if (flag === "-B" || flag === "--base") {
        baseBranch = val.trim().replace(/^refs\/heads\//, "") || null;
      }
      continue;
    }
    if (a.startsWith("-") && !a.startsWith("--") && a.length > 2) {
      const p = a.slice(0, 2);
      const v = a.slice(2).replace(/^=/, "");
      if (p === "-R") explicitSlug = parseRepoSlugArg(v);
      else if (p === "-B") baseBranch = v.trim().replace(/^refs\/heads\//, "") || null;
      continue;
    }
    if (!a.startsWith("-") && GH_ITEM_URL_RE.test(a.trim())) {
      urlSlug = parseRepoSlugArg(a);
    }
  }

  const envSlug = resolveEnvGhRepoSlug(env);
  const here = inspectRepo(cwd, config, env);
  const slug = explicitSlug ?? urlSlug ?? envSlug ?? (here && here.slug !== "?" ? here.slug : null);
  return { slug, repo: here && slug !== null && here.slug === slug ? here : null, baseBranch };
}

export function scanGhApiInvocation(args: ReadonlyArray<string>): {
  readonly apiIdx: number;
  readonly endpoint: string;
  readonly method: string;
} | null {
  const apiIdx = args.findIndex((a) => a.toLowerCase() === "api");
  if (apiIdx === -1) return null;

  let endpoint = "";
  let method = "";
  let hasBodyBearingFlag = false;
  const copy = [...args];

  for (let i = 0; i < copy.length; i += 1) {
    if (i === apiIdx) continue;
    const a = copy[i]!;
    if (a === "--") {
      if (!endpoint && i + 1 < copy.length) endpoint = copy[i + 1]!;
      break;
    }
    const mMatch = matchGhValueFlag(copy, i, "-X", "--method");
    if (mMatch) {
      method = mMatch.value.toUpperCase();
      i += mMatch.step;
      continue;
    }
    const fMatch =
      matchGhValueFlag(copy, i, "-f", "--raw-field") ??
      matchGhValueFlag(copy, i, "-F", "--field") ??
      matchGhValueFlag(copy, i, null, "--input");
    if (fMatch) {
      hasBodyBearingFlag = true;
      i += fMatch.step;
      continue;
    }
    const eq = a.startsWith("-") ? a.indexOf("=") : -1;
    if (GH_API_OTHER_VALUE_FLAGS.has(eq === -1 ? a : a.slice(0, eq))) {
      if (eq === -1) i += 1;
      continue;
    }
    if (!a.startsWith("-") && !endpoint) endpoint = a;
  }

  return { apiIdx, endpoint, method: method || (hasBodyBearingFlag ? "POST" : "GET") };
}
