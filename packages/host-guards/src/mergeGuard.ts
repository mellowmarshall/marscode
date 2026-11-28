// @effect-diagnostics nodeBuiltinImport:off - GitHub CLI merge guard: blocks direct merges, PR creation, base retargeting, repo sync, shell aliases, and manual merge drills.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";

import { decideGhApiCall } from "./ghApiGuard.ts";
import { decideGhRepoAdmin } from "./ghRepoAdmin.ts";
import {
  expandGhAlias,
  extractGhCommandTokens,
  inspectGhCommandTarget,
  MAX_GH_ALIAS_DEPTH,
  resolveEnvGhRepoSlug,
} from "./ghArgParse.ts";
import { safeRealpath, type HostGuardsConfig } from "./hostConfig.ts";
import { defaultProcFs, type ProcFsReader } from "./procFs.ts";
import { isQueueDaemonInAncestry } from "./t3ServerTrust.ts";
import { ALLOW_VERDICT, type GuardVerdict } from "./pushGuard.ts";
import { FALLBACK_BASES, formatMergeRefusal, inspectRepo, isSlugInScope } from "./repoScope.ts";

const MERGE_LONG_VALUES = new Set([
  "--subject",
  "--body",
  "--body-file",
  "--author-email",
  "--match-head-commit",
]);

const PR_URL_RE = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/\d+$/i;

function parsePrMergeSelector(args: ReadonlyArray<string>): {
  readonly repoArgs: ReadonlyArray<string>;
  readonly selector: ReadonlyArray<string>;
} | null {
  let repoArgs: string[] = [];
  let selector: string[] = [];
  let words = 0;

  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    if (a === "--repo") {
      if (i + 1 >= args.length) return null;
      repoArgs = ["--repo", args[i + 1]!];
      i += 1;
      continue;
    }
    if (a.startsWith("--repo=")) {
      repoArgs = ["--repo", a.slice("--repo=".length)];
      continue;
    }
    if (MERGE_LONG_VALUES.has(a)) {
      i += 1;
      if (i >= args.length) return null;
      continue;
    }
    if (a === "--") {
      const rest = args.slice(i + 1);
      if (rest.length > 1 || (rest.length > 0 && selector.length > 0)) return null;
      return { repoArgs, selector: [...selector, ...rest] };
    }
    if (a.startsWith("--")) continue;
    if (a.startsWith("-") && a.length > 1) {
      let short = a.slice(1);
      while (short.length > 0) {
        const flag = short[0]!;
        short = short.slice(1);
        if ("RtbFA".includes(flag)) {
          let value: string;
          if (short.length > 0) {
            value = short.startsWith("=") ? short.slice(1) : short;
          } else {
            i += 1;
            if (i >= args.length) return null;
            value = args[i]!;
          }
          if (flag === "R") repoArgs = ["--repo", value];
          break;
        }
        if ("dmrs".includes(flag)) {
          if (short.startsWith("=")) break;
          continue;
        }
        return null;
      }
      continue;
    }
    words += 1;
    if (words > 2) {
      if (selector.length > 0) return null;
      selector = [a];
    }
  }
  return { repoArgs, selector };
}

function resolvePrMergeTarget(
  args: ReadonlyArray<string>,
  cwd: string,
  config: HostGuardsConfig,
  env: NodeJS.ProcessEnv,
): { readonly owner: string; readonly name: string } | null {
  const parsed = parsePrMergeSelector(args);
  if (!parsed) return null;

  const firstSel = parsed.selector[0] ?? "";
  const directUrl = PR_URL_RE.exec(firstSel.trim());
  if (directUrl?.[1] && directUrl[2]) {
    return { owner: directUrl[1].toLowerCase(), name: directUrl[2].toLowerCase() };
  }

  const explicitRepo = parsed.repoArgs[1]?.trim() ?? "";
  if (explicitRepo && /^[^/\s]+\/[^/\s]+$/.test(explicitRepo)) {
    const [owner, name] = explicitRepo.split("/");
    return { owner: owner!.toLowerCase(), name: name!.toLowerCase().replace(/\.git$/, "") };
  }

  const envSlug = resolveEnvGhRepoSlug(env);
  if (envSlug) {
    const [owner, name] = envSlug.split("/");
    return { owner: owner!, name: name! };
  }

  const res = NodeChildProcess.spawnSync(
    config.realGh,
    ["pr", "view", ...parsed.repoArgs, "--json", "url", "--jq", ".url", "--", ...parsed.selector],
    { cwd, env, encoding: "utf8", timeout: 30_000 },
  );
  if (res.status !== 0) return null;
  const match = PR_URL_RE.exec((res.stdout ?? "").trim());
  if (!match?.[1] || !match[2]) return null;
  return { owner: match[1].toLowerCase(), name: match[2].toLowerCase() };
}

const REPO_SYNC_VALUE_FLAGS = new Set([
  "-b",
  "--branch",
  "-s",
  "--source",
  "-R",
  "--repo",
  "--hostname",
]);

function resolveRepoSyncTarget(
  args: ReadonlyArray<string>,
  syncTokenIndex: number,
  cwd: string,
  config: HostGuardsConfig,
  env: NodeJS.ProcessEnv,
): string | null {
  let repoFlag = "";
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    if (i <= syncTokenIndex && (a.toLowerCase() === "repo" || a.toLowerCase() === "sync")) {
      continue;
    }
    if (a === "--") {
      positionals.push(...args.slice(i + 1));
      break;
    }
    const eq = a.indexOf("=");
    const flag = eq === -1 ? a : a.slice(0, eq);
    if (REPO_SYNC_VALUE_FLAGS.has(flag)) {
      const val = eq === -1 ? (args[i + 1] ?? "") : a.slice(eq + 1);
      if (eq === -1) i += 1;
      if (flag === "-R" || flag === "--repo") repoFlag = val.trim();
      continue;
    }
    if (!a.startsWith("--") && a.length > 2 && ["-b", "-s", "-R"].includes(a.slice(0, 2))) {
      if (a.startsWith("-R")) repoFlag = a.slice(2).trim();
      continue;
    }
    if (a.startsWith("-")) continue;
    positionals.push(a);
  }
  if (positionals[0]) return positionals[0].trim();
  if (repoFlag) return repoFlag;
  const envSlug = resolveEnvGhRepoSlug(env);
  if (envSlug) return envSlug;
  const here = inspectRepo(cwd, config, env);
  return here && here.slug !== "?" ? here.slug : null;
}

export function decideGh(
  args: ReadonlyArray<string>,
  cwd: string,
  config: HostGuardsConfig,
  options?: {
    readonly depth?: number | undefined;
    readonly seenAliases?: ReadonlySet<string> | undefined;
    readonly procFs?: ProcFsReader | undefined;
    readonly env?: NodeJS.ProcessEnv | undefined;
  },
): GuardVerdict {
  const depth = options?.depth ?? 0;
  const seenAliases = options?.seenAliases ?? new Set<string>();
  const procFs = options?.procFs ?? defaultProcFs;
  const env = options?.env ?? process.env;

  const alias = expandGhAlias(args, cwd, config);
  if (alias !== null) {
    const aliasName = extractGhCommandTokens(args)[0]?.word ?? "alias";
    if (alias.shell) {
      const here = inspectRepo(cwd, config, env);
      const said = [alias.body, ...args].join(" ").replace(/[\\'"]/g, "");
      if ((here && here.inScope) || /\b(merge|api|sync|issue|pr)\b/.test(said)) {
        return {
          verdict: "deny",
          reason: formatMergeRefusal(
            `the gh shell alias \`${aliasName}\` (it runs gh outside the guard)`,
            here,
            config,
          ),
        };
      }
      return ALLOW_VERDICT;
    }
    if (seenAliases.has(aliasName) || depth >= MAX_GH_ALIAS_DEPTH) {
      return {
        verdict: "deny",
        reason: formatMergeRefusal(
          `gh alias \`${aliasName}\`: alias expansion ${seenAliases.has(aliasName) ? "detected a cycle" : `exceeded max depth (${MAX_GH_ALIAS_DEPTH})`}`,
          inspectRepo(cwd, config, env),
          config,
        ),
      };
    }
    const nextSeen = new Set(seenAliases);
    nextSeen.add(aliasName);
    return decideGh(alias.expanded, cwd, config, {
      depth: depth + 1,
      seenAliases: nextSeen,
      procFs,
      env,
    });
  }

  const tokens = extractGhCommandTokens(args);
  const words = tokens.map((t) => t.word);
  const queued = isQueueDaemonInAncestry(config.queueRoot, undefined, procFs);

  if (words[0] === "pr" && (words[1] === "create" || words[1] === "new")) {
    if (queued) return ALLOW_VERDICT;
    const { slug, repo } = inspectGhCommandTarget(args, cwd, config, env);
    if (slug && isSlugInScope(slug, config)) {
      return {
        verdict: "deny",
        reason: formatMergeRefusal(`gh pr ${words[1]} on ${slug}`, repo, config),
      };
    }
    return ALLOW_VERDICT;
  }

  if (words[0] === "pr" && words[1] === "edit") {
    if (queued) return ALLOW_VERDICT;
    const { slug, repo, baseBranch } = inspectGhCommandTarget(args, cwd, config, env);
    if (baseBranch && slug && isSlugInScope(slug, config)) {
      const bases = repo ? repo.bases() : FALLBACK_BASES;
      if (bases.includes(baseBranch)) {
        return {
          verdict: "deny",
          reason: formatMergeRefusal(`gh pr edit --base ${baseBranch} on ${slug}`, repo, config),
        };
      }
    }
    return ALLOW_VERDICT;
  }

  if (words[0] === "pr" && words[1] === "merge") {
    if (queued) return ALLOW_VERDICT;
    const target = resolvePrMergeTarget(args, cwd, config, env);
    const here = inspectRepo(cwd, config, env);
    if (target === null) {
      return {
        verdict: "deny",
        reason: formatMergeRefusal(
          "gh pr merge: its PR could not be resolved, so it is refused",
          here,
          config,
        ),
      };
    }
    if (!isSlugInScope(target.owner, config, target.name)) return ALLOW_VERDICT;
    const same = here && here.slug === `${target.owner}/${target.name}` ? here : null;
    return {
      verdict: "deny",
      reason: formatMergeRefusal(`gh pr merge on ${target.owner}/${target.name}`, same, config),
    };
  }

  if (words[0] === "api") {
    const idx = tokens[0]!.index;
    const normalizedArgs = ["api", ...args.slice(0, idx), ...args.slice(idx + 1)];
    return decideGhApiCall(normalizedArgs, cwd, config, queued, env);
  }

  if (words[0] === "repo" && words[1] && words[1] !== "sync") {
    return decideGhRepoAdmin(args, words[1], tokens[1]!.index, cwd, config, env);
  }

  if (words[0] === "repo" && words[1] === "sync") {
    if (queued) return ALLOW_VERDICT;
    const syncIdx = tokens[1]!.index;
    const targetSlug = resolveRepoSyncTarget(args, syncIdx, cwd, config, env);
    if (targetSlug && isSlugInScope(targetSlug, config)) {
      return {
        verdict: "deny",
        reason: formatMergeRefusal(
          `gh repo sync ${targetSlug} (it moves a remote branch)`,
          null,
          config,
        ),
      };
    }
  }

  return ALLOW_VERDICT;
}

export function isManualMergeDrill(
  words: ReadonlyArray<string>,
  cwd: string,
  config: HostGuardsConfig,
): boolean {
  if (words.length === 0) return false;
  const repo = inspectRepo(cwd, config);
  if (!repo || !repo.inScope) return false;
  const declared = repo.declaredValues("merge_drill");
  const drills = declared.length > 0 ? declared : ["scripts/merge-pr.sh"];
  const topReal = safeRealpath(repo.top);

  for (const word of words) {
    if (!word || word.startsWith("-")) continue;
    const candidate = safeRealpath(NodePath.resolve(cwd, word));
    if (!candidate.startsWith(`${topReal}/`)) continue;
    const rel = NodePath.relative(topReal, candidate).replace(/\\/g, "/");
    if (drills.some((d) => rel === d.replace(/^\.\//, ""))) {
      return true;
    }
  }
  return false;
}
