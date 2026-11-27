// PLAYBOOK §16 text guard: scans every text a gh (or glab/tea) call would post before it reaches a public repo.
import { displayPath, formatFinding, loadDenylist, scanText } from "@t3tools/hygiene";

import { normalizeApiPath } from "./ghApiGuard.ts";
import {
  expandNonShellGhAliases,
  extractGhCommandTokens,
  extractLeadingGhCommands,
  resolveEnvGhRepoSlug,
  scanGhApiInvocation,
} from "./ghArgParse.ts";
import {
  collectApiTexts,
  collectArgvTexts,
  type CollectedText,
  type TextReadOptions,
} from "./ghTextSources.ts";
import { isPrivateVisibility, resolveRepoVisibility, type RepoVisibility } from "./ghVisibility.ts";
import type { HostGuardsConfig } from "./hostConfig.ts";
import { ALLOW_VERDICT, type GuardVerdict } from "./pushGuard.ts";
import { inspectRepo, parseRepoSlugArg } from "./repoScope.ts";

export interface GhTextGuardOptions extends TextReadOptions {
  readonly env: NodeJS.ProcessEnv;
}

function apiTarget(
  path: string,
  cwd: string,
  config: HostGuardsConfig,
  env: NodeJS.ProcessEnv,
): string | null {
  const match = /^repos\/([^/]+)\/([^/]+)(?:\/|$)/.exec(path);
  if (!match?.[1] || !match[2]) return null;
  const fallback = resolveEnvGhRepoSlug(env) ?? inspectRepo(cwd, config, env)?.slug ?? "";
  const [fallbackOwner = "", fallbackName = ""] = fallback.split("/");
  const owner = /^[{:]owner}?$/.test(match[1]) ? fallbackOwner : match[1];
  const name = /^[{:]repo}?$/.test(match[2]) ? fallbackName : match[2];
  return owner && name ? `${owner}/${name}`.toLowerCase() : null;
}

interface Posted extends CollectedText {
  /** Every repo the call may post to; empty when none is known. */
  readonly slugs: ReadonlyArray<string>;
  /** Repos `gh repo create --private` is creating; they cannot be probed yet. */
  readonly creating?: ReadonlyArray<string>;
}

const GITHUB_URL_RE = /github\.com[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/gi;

/** `-R`, `GH_REPO`, every github.com URL, `repo` positionals, and the current repo. */
function candidateSlugs(
  args: ReadonlyArray<string>,
  isRepoCmd: boolean,
  noRepoTarget: boolean,
  cwd: string,
  config: HostGuardsConfig,
  env: NodeJS.ProcessEnv,
): string[] {
  // Gists and projects post to no repo, so no repo's visibility can make them private.
  if (noRepoTarget) return [];
  const out = new Set<string>();
  const add = (slug: string | null) => {
    if (slug) out.add(slug.toLowerCase().replace(/\.git$/, ""));
  };
  args.forEach((a, i) => {
    if (a === "-R" || a === "--repo") add(parseRepoSlugArg(args[i + 1] ?? ""));
    else if (a.startsWith("--repo=")) add(parseRepoSlugArg(a.slice(7)));
    else if (/^-R./.test(a)) add(parseRepoSlugArg(a.slice(2).replace(/^=/, "")));
    for (const m of a.matchAll(GITHUB_URL_RE)) add(`${m[1]}/${m[2]}`);
    if (isRepoCmd && !a.startsWith("-") && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(a)) add(a);
  });
  add(resolveEnvGhRepoSlug(env));
  const here = inspectRepo(cwd, config, env);
  if (here && here.slug !== "?") add(here.slug);
  return [...out];
}

/** The repos a text-writing gh call may post to and what it posts; `null` when it posts none. */
function postedTexts(
  args: ReadonlyArray<string>,
  cwd: string,
  config: HostGuardsConfig,
  options: GhTextGuardOptions,
): Posted | null {
  const cmd = extractLeadingGhCommands(args)[0] ?? "";
  if (cmd === "api") {
    const api = scanGhApiInvocation(args);
    if (!api || api.method === "GET") return null;
    const path = normalizeApiPath(api.endpoint);
    const slug = path.startsWith("repos/") ? apiTarget(path, cwd, config, options.env) : null;
    return { slugs: slug ? [slug] : [], ...collectApiTexts(args, api.apiIdx, cwd, options) };
  }
  const words = extractGhCommandTokens(args);
  const collected = collectArgvTexts(args, words, cwd, options);
  if (!collected) return null;
  const slugs = candidateSlugs(
    args,
    cmd === "repo",
    cmd === "gist" || cmd === "project",
    cwd,
    config,
    options.env,
  );
  const sub = words[1]?.word ?? "";
  if (cmd !== "repo" || sub !== "create") return { slugs, ...collected };
  if (!args.includes("--private") || args.includes("--public") || args.includes("--internal")) {
    return { slugs, ...collected };
  }
  const creating = args.filter((a, i) => i > words[1]!.index && slugs.includes(a.toLowerCase()));
  return { slugs: slugs.filter((s) => !creating.includes(s)), creating, ...collected };
}

/** Text a forge CLI without a visibility probe (`glab`, `tea`) sends; always treated as public. */
export function decideForgeText(
  tool: string,
  args: ReadonlyArray<string>,
  cwd: string,
  options: GhTextGuardOptions,
): GuardVerdict {
  const words = args.flatMap((word, index) =>
    word.startsWith("-") ? [] : [{ index, word: word.toLowerCase() }],
  );
  const collected = collectArgvTexts(args, words, cwd, options);
  if (!collected) return ALLOW_VERDICT;
  return judgePosted(tool, { slugs: [], ...collected }, "unknown", options, "");
}

/**
 * PLAYBOOK §16 text guard for `gh`. Text bound for a public repo (or one whose visibility is
 * unknown) is scanned with the generic rules and the host-local denylist, which is mandatory
 * there. A refusal names class ids and locations only, never the matched text.
 */
export function decideGhText(
  args: ReadonlyArray<string>,
  cwd: string,
  config: HostGuardsConfig,
  options: GhTextGuardOptions,
): GuardVerdict {
  const effective = expandNonShellGhAliases(args, cwd, config) ?? args;
  const posted = postedTexts(effective, cwd, config, options);
  if (!posted || isEmptyPost(posted)) return ALLOW_VERDICT;
  if (posted.slugs.length === 0 && posted.creating !== undefined) return ALLOW_VERDICT;
  // Any public or unknown candidate makes the whole call public.
  const visibilities = posted.slugs.map((slug) => resolveRepoVisibility(slug, config, options.env));
  if (visibilities.length > 0 && visibilities.every(isPrivateVisibility)) return ALLOW_VERDICT;
  const visibility = visibilities.includes("public") ? "public" : "unknown";
  // Name only the public candidates: a private one's name must not reach the refusal text.
  const where = posted.slugs.filter((_, i) => visibilities[i] === "public").join(", ");
  return judgePosted("gh", posted, visibility, options, where);
}

const isEmptyPost = (posted: Posted) =>
  !posted.editor &&
  posted.unreadable.length === 0 &&
  posted.texts.every((entry) => !entry.text.trim());

function judgePosted(
  tool: string,
  posted: Posted,
  visibility: RepoVisibility,
  options: GhTextGuardOptions,
  publicTargets: string,
): GuardVerdict {
  if (isEmptyPost(posted)) return ALLOW_VERDICT;
  const where = publicTargets || "the target repo";
  const scope = visibility === "public" ? "public" : "of unknown visibility, so treated as public";
  const head = `host guard text-guard: refusing ${tool} text for ${where} (${scope})`;
  if (posted.editor) {
    return {
      verdict: "deny",
      reason: `${head}: editor mode hides the text from the guard. Pass the text with flags or a file (PLAYBOOK §16).`,
    };
  }
  if (posted.unreadable.length > 0) {
    return {
      verdict: "deny",
      reason: `${head}: the guard cannot read ${posted.unreadable.join(", ")}. Write the text to a regular file first (PLAYBOOK §16).`,
    };
  }
  const denylist = loadDenylist(options.env);
  if (denylist.kind !== "loaded") {
    return {
      verdict: "deny",
      reason: `${head}: the private denylist at ${displayPath(denylist.path, options.env)} is ${denylist.kind}; it is required before text posts to a public repo (PLAYBOOK §16.3/§16.5).`,
    };
  }
  const findings = posted.texts.flatMap(({ source, text }) =>
    scanText(text, { source, surface: "github-text", denylist: denylist.rules }),
  );
  if (findings.length === 0) return ALLOW_VERDICT;
  return {
    verdict: "deny",
    reason: [
      `${head}: ${findings.length} PLAYBOOK §16 finding(s):`,
      ...findings.map((finding) => `  ${formatFinding(finding)}`),
      "Rewrite the text with neutral placeholders (PLAYBOOK §16).",
    ].join("\n"),
  };
}
