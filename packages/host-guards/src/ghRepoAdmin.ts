// @effect-diagnostics nodeBuiltinImport:off - Deny-by-default repo administration in managed orgs: a short allowlist of gh repo subcommands and gh api write paths.
import { GH_UNREADABLE_INPUT } from "./ghGraphqlGuard.ts";
import { resolveEnvGhRepoSlug } from "./ghArgParse.ts";
import type { HostGuardsConfig } from "./hostConfig.ts";
import { ALLOW_VERDICT, type GuardVerdict } from "./pushGuard.ts";
import { inspectRepo, isSlugInScope, parseRepoSlugArg } from "./repoScope.ts";

/** `gh repo` subcommands that change nothing remote. `sync` has its own guard. */
const GH_REPO_READ_SUBS: ReadonlySet<string> = new Set([
  "view",
  "list",
  "clone",
  "set-default",
  "sync",
]);

/** Everyday `gh api` writes under `repos/<managed>/<repo>/`; every other write is owner-only. */
const GH_API_EVERYDAY_WRITES: ReadonlyArray<{
  readonly methods: ReadonlySet<string>;
  readonly path: RegExp;
}> = [
  { methods: new Set(["POST"]), path: /^issues$/ },
  { methods: new Set(["PATCH"]), path: /^issues\/\d+$/ },
  { methods: new Set(["POST"]), path: /^issues\/\d+\/comments$/ },
  { methods: new Set(["PATCH", "DELETE"]), path: /^issues\/comments\/\d+$/ },
  { methods: new Set(["POST", "PUT", "DELETE"]), path: /^issues\/\d+\/labels(?:\/[^/]+)?$/ },
  { methods: new Set(["POST", "DELETE"]), path: /^issues\/\d+\/assignees$/ },
  { methods: new Set(["POST"]), path: /^pulls$/ },
  { methods: new Set(["PATCH"]), path: /^pulls\/\d+$/ },
  { methods: new Set(["POST"]), path: /^pulls\/\d+\/comments(?:\/\d+\/replies)?$/ },
  { methods: new Set(["PATCH", "DELETE"]), path: /^pulls\/comments\/\d+$/ },
  { methods: new Set(["POST"]), path: /^pulls\/\d+\/reviews$/ },
  {
    methods: new Set(["PUT", "POST", "DELETE"]),
    path: /^pulls\/\d+\/reviews\/\d+(?:\/events|\/dismissals)?$/,
  },
  { methods: new Set(["POST", "DELETE"]), path: /^pulls\/\d+\/requested_reviewers$/ },
  { methods: new Set(["POST"]), path: /^labels$/ },
  { methods: new Set(["PATCH", "DELETE"]), path: /^labels\/[^/]+$/ },
  { methods: new Set(["POST"]), path: /^statuses\/[0-9a-f]{7,64}$/i },
  { methods: new Set(["POST"]), path: /^check-runs$/ },
  { methods: new Set(["PATCH"]), path: /^check-runs\/\d+$/ },
  { methods: new Set(["POST"]), path: /^git\/refs$/ },
  { methods: new Set(["PATCH", "DELETE"]), path: /^git\/refs\/heads\/.+$/ },
];

/** What the queue daemon itself writes when it lands a job. */
const QUEUE_WRITES: ReadonlyArray<RegExp> = [/^pulls\/\d+\/merge$/];

export function repoAdminRefusal(what: string): GuardVerdict {
  return {
    verdict: "deny",
    reason: `host repo guard: repo settings change: owner approval required (${what}).`,
  };
}

export function isEverydayApiWrite(method: string, rest: string, queued: boolean): boolean {
  if (GH_API_EVERYDAY_WRITES.some((w) => w.methods.has(method) && w.path.test(rest))) return true;
  return queued && QUEUE_WRITES.some((p) => p.test(rest));
}

function bodyField(
  fields: Readonly<Record<string, string>>,
  raw: string,
  key: string,
): string | null {
  if (fields[key] === GH_UNREADABLE_INPUT || raw === GH_UNREADABLE_INPUT) return null;
  if (fields[key] !== undefined) return fields[key];
  if (!raw.trim()) return "";
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const value = parsed?.[key];
    return typeof value === "string" ? value : "";
  } catch {
    return null;
  }
}

/**
 * `gh api` writes that create a repo in a managed org whatever repo they start from: user repos
 * (the account's owner is unknown offline), any write under `orgs/<managed>/`, forks with an
 * `organization`, and template generation. A body it cannot read counts as managed.
 */
export function createsManagedRepo(
  method: string,
  path: string,
  fields: Readonly<Record<string, string>>,
  raw: string,
  config: HostGuardsConfig,
): boolean {
  if (method === "GET") return false;
  const managed = (org: string | null) =>
    org === null || config.orgs.includes(org.trim().toLowerCase());
  if (path === "user/repos") return true;
  const org = /^orgs\/([^/]+)(?:\/|$)/.exec(path);
  if (org) return managed(org[1] ?? null);
  const action = /^repos\/[^/]+\/[^/]+\/(forks|generate)$/.exec(path);
  if (action?.[1] === "forks") {
    const target = bodyField(fields, raw, "organization");
    return target === null || (target !== "" && managed(target));
  }
  if (action?.[1] === "generate") {
    const owner = bodyField(fields, raw, "owner");
    return owner === null || owner === "" || managed(owner);
  }
  return false;
}

/**
 * `gh repo` in a managed org: only `GH_REPO_READ_SUBS` run without the owner. The target is every
 * repo the call could mean (`-R` in any form, `GH_REPO`, any slug-shaped word, the cwd repo, and
 * `--org`), so a flag value can never hide the real one.
 */
export function decideGhRepoAdmin(
  args: ReadonlyArray<string>,
  words: ReadonlyArray<string>,
  subIndex: number,
  cwd: string,
  config: HostGuardsConfig,
  env: NodeJS.ProcessEnv,
): GuardVerdict {
  const sub = words[1] ?? "";
  if (!sub || GH_REPO_READ_SUBS.has(sub)) return ALLOW_VERDICT;
  const what = `gh repo ${words.slice(1, 3).join(" ")}`;
  const candidates: string[] = [];
  let named = false;
  for (let i = subIndex + 1; i < args.length; i += 1) {
    const a = args[i]!;
    const value = /^-R./.test(a)
      ? a.slice(2).replace(/^=/, "")
      : /^--(?:repo|org)=/.test(a)
        ? a.slice(a.indexOf("=") + 1)
        : a;
    if (a === "--org" || a.startsWith("--org=")) {
      const org = a === "--org" ? (args[i + 1] ?? "") : value;
      if (config.orgs.includes(org.trim().toLowerCase()))
        return repoAdminRefusal(`${what} --org ${org}`);
    }
    const slug = parseRepoSlugArg(value);
    if (slug) {
      candidates.push(slug);
      named = true;
    }
  }
  const envSlug = resolveEnvGhRepoSlug(env);
  if (envSlug) candidates.push(envSlug);
  const here = inspectRepo(cwd, config, env);
  if (here && here.inScope) candidates.push(here.slug);
  if ((sub === "create" || sub === "new") && !named) return repoAdminRefusal(what);
  const managed = candidates.find((slug) => isSlugInScope(slug, config));
  return managed ? repoAdminRefusal(`${what} ${managed}`) : ALLOW_VERDICT;
}
