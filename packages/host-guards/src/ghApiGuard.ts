// @effect-diagnostics nodeBuiltinImport:off - GitHub REST and GraphQL API write guard for `gh api` calls.
import { parseApiParts, readBodyField, type GhApiBody } from "./ghApiArgs.ts";
import { resolveEnvGhRepoSlug } from "./ghArgParse.ts";
import { decideGhGraphqlCall } from "./ghGraphqlGuard.ts";
import {
  checkGitRefsCreate,
  createsManagedRepo,
  isEverydayApiWrite,
  nestedRepoAdminWrite,
  repoAdminRefusal,
} from "./ghRepoAdmin.ts";
import type { HostGuardsConfig } from "./hostConfig.ts";
import { ALLOW_VERDICT, type GuardVerdict } from "./pushGuard.ts";
import {
  FALLBACK_BASES,
  formatMergeRefusal,
  inspectRepo,
  isSlugInScope,
  type RepoInfo,
} from "./repoScope.ts";

export function normalizeApiPath(endpoint: string): string {
  const stripped = endpoint.trim().replace(/^https?:\/\/[^/]+\/(?:api\/v3\/)?/i, "");
  const noQuery = stripped.replace(/^\/+/, "").split("?", 1)[0] ?? "";
  try {
    return decodeURIComponent(noQuery).replace(/\/+$/, "");
  } catch {
    return noQuery.replace(/\/+$/, "");
  }
}

export function decideGhApiCall(
  args: ReadonlyArray<string>,
  cwd: string,
  config: HostGuardsConfig,
  queued: boolean,
  env: NodeJS.ProcessEnv = process.env,
): GuardVerdict {
  const { endpoint, method, fields, raw, hasInputFlag, unknownFlag } = parseApiParts(args, cwd);
  const path = normalizeApiPath(endpoint);
  const here = inspectRepo(cwd, config, env);

  if (unknownFlag !== null) {
    return {
      verdict: "deny",
      reason: `host repo guard: refusing gh api with ${unknownFlag}: the method cannot be verified.`,
    };
  }
  if (path === "graphql") {
    return decideGhGraphqlCall({ endpoint, fields, raw, hasInputFlag }, here, config, queued);
  }

  const body: GhApiBody = { fields, raw, hasInputFlag };
  if (createsManagedRepo(method, path, body, config)) {
    return repoAdminRefusal(`gh api ${method} ${path}`);
  }
  if (method === "GET") return ALLOW_VERDICT;
  if (nestedRepoAdminWrite(path, config)) return repoAdminRefusal(`gh api ${method} ${path}`);
  // `repositories/<id>/...` names a repo GitHub resolves by id; offline it counts as managed.
  const idMatch = /^repositories\/(\d+)(?:\/(.*))?$/i.exec(path);
  if (idMatch) {
    return decideManagedRepoWrite({
      method,
      path,
      rest: (idMatch[2] ?? "").replace(/\/+$/, ""),
      body,
      target: null,
      config,
      queued,
    });
  }
  const repoMatch = /^repos\/([^/]+)\/([^/]+)(?:\/(.*))?$/i.exec(path);
  if (!repoMatch) return ALLOW_VERDICT;

  let owner = repoMatch[1]!.toLowerCase();
  let name = repoMatch[2]!.toLowerCase();
  const rest = (repoMatch[3] ?? "").replace(/\/+$/, "");
  const envSlug = resolveEnvGhRepoSlug(env);
  const envParts = envSlug ? envSlug.split("/") : null;
  const hereSlug = here && here.inScope ? here.slug.split("/") : null;
  const fallbackSlug = envParts ?? hereSlug;

  if (owner === "{owner}" || owner === ":owner") {
    if (!fallbackSlug?.[0]) {
      return {
        verdict: "deny",
        reason: formatMergeRefusal(`gh api ${method} ${path} (unresolved {owner})`, here, config),
      };
    }
    owner = fallbackSlug[0];
  }
  if (name === "{repo}" || name === ":repo") {
    if (!fallbackSlug?.[1]) {
      return {
        verdict: "deny",
        reason: formatMergeRefusal(`gh api ${method} ${path} (unresolved {repo})`, here, config),
      };
    }
    name = fallbackSlug[1];
  }

  if (!isSlugInScope(owner, config, name)) return ALLOW_VERDICT;
  const target = hereSlug && hereSlug[0] === owner && hereSlug[1] === name ? here : null;
  return decideManagedRepoWrite({ method, path, rest, body, target, config, queued });
}

/** A write to a managed repo: deny by default, with base-branch checks on the everyday writes. */
function decideManagedRepoWrite(input: {
  readonly method: string;
  readonly path: string;
  readonly rest: string;
  readonly body: GhApiBody;
  readonly target: RepoInfo | null;
  readonly config: HostGuardsConfig;
  readonly queued: boolean;
}): GuardVerdict {
  const { method, path, rest, body, target, config, queued } = input;
  const bases = target ? target.bases() : FALLBACK_BASES;
  if (method === "POST" && rest === "git/refs") {
    const refused = checkGitRefsCreate(body, bases);
    if (refused) {
      return {
        verdict: "deny",
        reason: formatMergeRefusal(`gh api ${method} ${path} (${refused})`, target, config),
      };
    }
  }
  // Deny by default: only everyday writes run without the owner, even for the queue.
  if (queued) {
    return isEverydayApiWrite(method, rest, true)
      ? ALLOW_VERDICT
      : repoAdminRefusal(`gh api ${method} ${path}`);
  }

  if (method === "POST" && rest === "pulls") {
    return {
      verdict: "deny",
      reason: formatMergeRefusal(
        `gh api ${method} ${path} (creating a pull request)`,
        target,
        config,
      ),
    };
  }

  if (/^pulls\/\d+\/merge$/.test(rest) || rest === "merges" || rest === "merge-upstream") {
    return {
      verdict: "deny",
      reason: formatMergeRefusal(`gh api ${method} ${path}`, target, config),
    };
  }

  const hasTemplatePlaceholder = (value: string): boolean =>
    value.includes("{") || value.includes("}");

  const refMatch =
    /^git\/refs\/heads\/(.+)$/.exec(rest) ??
    /^branches\/([^/]+)\/(?:protection(?:\/.*)?|rename)$/.exec(rest);
  if (refMatch?.[1] && (bases.includes(refMatch[1]) || hasTemplatePlaceholder(refMatch[1]))) {
    return {
      verdict: "deny",
      reason: formatMergeRefusal(`gh api ${method} ${path} (the base branch)`, target, config),
    };
  }

  if (method === "PATCH" && /^pulls\/\d+$/.test(rest)) {
    const rawBase = readBodyField(body, "base");
    if (rawBase === null) {
      return {
        verdict: "deny",
        reason: formatMergeRefusal(
          `gh api ${method} ${path} with unreadable input (cannot verify PR base)`,
          target,
          config,
        ),
      };
    }
    const base = rawBase.trim().replace(/^refs\/heads\//, "");
    if (base && (bases.includes(base) || hasTemplatePlaceholder(base))) {
      return {
        verdict: "deny",
        reason: formatMergeRefusal(
          `gh api ${method} ${path} (retargeting PR base to ${base})`,
          target,
          config,
        ),
      };
    }
  }

  if (rest.startsWith("contents/") && (method === "PUT" || method === "DELETE")) {
    const branch = readBodyField(body, "branch");
    if (!branch || bases.includes(branch) || hasTemplatePlaceholder(branch)) {
      return {
        verdict: "deny",
        reason: formatMergeRefusal(
          `gh api ${method} ${path} (a commit on the base branch)`,
          target,
          config,
        ),
      };
    }
  }
  return isEverydayApiWrite(method, rest, false)
    ? ALLOW_VERDICT
    : repoAdminRefusal(`gh api ${method} ${path}`);
}
