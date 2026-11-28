// @effect-diagnostics nodeBuiltinImport:off - Repo administration (settings, rename, create, delete, transfer) is owner-only in managed orgs.
import type { HostGuardsConfig } from "./hostConfig.ts";
import { ALLOW_VERDICT, type GuardVerdict } from "./pushGuard.ts";
import { inspectRepo, isSlugInScope } from "./repoScope.ts";

const REPO_ADMIN_SUBS = new Set([
  "create",
  "new",
  "edit",
  "rename",
  "delete",
  "archive",
  "unarchive",
]);
const SLUG_RE = /^(?:https:\/\/github\.com\/)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;

export function repoAdminRefusal(what: string): GuardVerdict {
  return {
    verdict: "deny",
    reason: `host repo guard: repo settings change: owner approval required (${what}).`,
  };
}

/** `gh api` REST calls that change a managed repo's settings or existence. */
export function isRepoAdminApiCall(method: string, rest: string): boolean {
  if (method === "GET") return false;
  return rest === "" || (method === "POST" && rest === "transfer");
}

function slugArg(args: ReadonlyArray<string>, subIndex: number): string | null {
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    if ((a === "-R" || a === "--repo") && i + 1 < args.length) return args[i + 1]!;
    if (a.startsWith("--repo=")) return a.slice("--repo=".length);
  }
  for (const a of args.slice(subIndex + 1)) {
    if (a === "--") break;
    if (!a.startsWith("-") && SLUG_RE.test(a.trim())) return a.trim();
  }
  return null;
}

/**
 * `gh repo create|edit|rename|delete|archive` on a managed repo. A bare `create <name>` cannot
 * name its owner offline, so it is treated as managed (fail closed).
 */
export function decideGhRepoAdmin(
  args: ReadonlyArray<string>,
  sub: string,
  subIndex: number,
  cwd: string,
  config: HostGuardsConfig,
  env: NodeJS.ProcessEnv,
): GuardVerdict {
  if (!REPO_ADMIN_SUBS.has(sub)) return ALLOW_VERDICT;
  const explicit = slugArg(args, subIndex);
  const match = explicit ? SLUG_RE.exec(explicit) : null;
  if (match?.[1] && match[2]) {
    return isSlugInScope(match[1], config, match[2])
      ? repoAdminRefusal(`gh repo ${sub} ${match[1]}/${match[2]}`)
      : ALLOW_VERDICT;
  }
  if (sub === "create" || sub === "new") return repoAdminRefusal(`gh repo ${sub}`);
  const here = inspectRepo(cwd, config, env);
  return here && here.inScope ? repoAdminRefusal(`gh repo ${sub} ${here.slug}`) : ALLOW_VERDICT;
}
