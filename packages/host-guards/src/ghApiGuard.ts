// @effect-diagnostics nodeBuiltinImport:off - GitHub REST and GraphQL API write guard for `gh api` calls.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { resolveEnvGhRepoSlug } from "./ghArgParse.ts";
import { decideGhGraphqlCall, GH_UNREADABLE_INPUT } from "./ghGraphqlGuard.ts";
import { createsManagedRepo, isEverydayApiWrite, repoAdminRefusal } from "./ghRepoAdmin.ts";
import type { HostGuardsConfig } from "./hostConfig.ts";
import { ALLOW_VERDICT, type GuardVerdict } from "./pushGuard.ts";
import { FALLBACK_BASES, formatMergeRefusal, inspectRepo, isSlugInScope } from "./repoScope.ts";

const API_VALUE_FLAGS = new Set([
  "-X",
  "--method",
  "-f",
  "--raw-field",
  "-F",
  "--field",
  "-H",
  "--header",
  "--input",
  "-q",
  "--jq",
  "-t",
  "--template",
  "--hostname",
  "-p",
  "--preview",
  "--cache",
]);

function readRegularInputFile(filePath: string, cwd: string): string {
  if (filePath === "-") return GH_UNREADABLE_INPUT;
  const abs = NodePath.resolve(cwd, filePath);
  try {
    const st = NodeFS.statSync(abs);
    if (!st.isFile()) return GH_UNREADABLE_INPUT;
    return NodeFS.readFileSync(abs, "utf8");
  } catch {
    return GH_UNREADABLE_INPUT;
  }
}

function parseApiParts(
  args: ReadonlyArray<string>,
  cwd: string,
): {
  readonly endpoint: string;
  readonly method: string;
  readonly fields: Record<string, string>;
  readonly raw: string;
  readonly hasInputFlag: boolean;
} {
  let endpoint = "";
  let method = "";
  const fields: Record<string, string> = {};
  let raw = "";
  let hasInputFlag = false;

  for (let i = 1; i < args.length; i += 1) {
    const a = args[i]!;
    const isLong = a.startsWith("--");
    const eq = isLong ? a.indexOf("=") : -1;
    const name = eq === -1 ? a : a.slice(0, eq);
    const inline = eq === -1 ? "" : a.slice(eq + 1);

    const shortAttached =
      !isLong && a.length > 2 && ["-X", "-f", "-F", "-H"].includes(a.slice(0, 2));
    if (API_VALUE_FLAGS.has(name) || shortAttached) {
      let value: string;
      if (API_VALUE_FLAGS.has(name) && eq === -1) {
        value = i + 1 < args.length ? args[i + 1]! : "";
        i += 1;
      } else {
        value = eq !== -1 ? inline : a.slice(2);
      }
      const flag = API_VALUE_FLAGS.has(name) ? name : a.slice(0, 2);
      if (flag === "-X" || flag === "--method") {
        method = value.toUpperCase();
      } else if (flag === "-f" || flag === "--raw-field" || flag === "-F" || flag === "--field") {
        const veq = value.indexOf("=");
        const k = veq === -1 ? value : value.slice(0, veq);
        let v = veq === -1 ? "" : value.slice(veq + 1);
        if ((flag === "-F" || flag === "--field") && v.startsWith("@")) {
          v = readRegularInputFile(v.slice(1), cwd);
        }
        fields[k] = v;
      } else if (flag === "--input") {
        hasInputFlag = true;
        raw = readRegularInputFile(value, cwd);
      }
      continue;
    }
    if (!a.startsWith("-") && !endpoint) {
      endpoint = a;
    }
  }

  if (!method) {
    method = Object.keys(fields).length > 0 || raw.length > 0 || hasInputFlag ? "POST" : "GET";
  }
  return { endpoint, method, fields, raw, hasInputFlag };
}

export function normalizeApiPath(endpoint: string): string {
  const stripped = endpoint.trim().replace(/^https?:\/\/[^/]+\/(?:api\/v3\/)?/i, "");
  const noQuery = stripped.replace(/^\/+/, "").split("?", 1)[0] ?? "";
  try {
    return decodeURIComponent(noQuery).replace(/\/+$/, "");
  } catch {
    return noQuery.replace(/\/+$/, "");
  }
}

function readJsonStringField(raw: string, key: string): string {
  if (!raw.trim()) return "";
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const val = parsed?.[key];
    return typeof val === "string" ? val : "";
  } catch {
    return "";
  }
}

export function decideGhApiCall(
  args: ReadonlyArray<string>,
  cwd: string,
  config: HostGuardsConfig,
  queued: boolean,
  env: NodeJS.ProcessEnv = process.env,
): GuardVerdict {
  const { endpoint, method, fields, raw, hasInputFlag } = parseApiParts(args, cwd);
  const path = normalizeApiPath(endpoint);
  const here = inspectRepo(cwd, config, env);

  if (path === "graphql") {
    return decideGhGraphqlCall({ endpoint, fields, raw, hasInputFlag }, here, config, queued);
  }

  if (createsManagedRepo(method, path, fields, raw, config)) {
    return repoAdminRefusal(`gh api ${method} ${path}`);
  }
  const repoMatch = /^repos\/([^/]+)\/([^/]+)(?:\/(.*))?$/.exec(path);
  if (!repoMatch || method === "GET") return ALLOW_VERDICT;

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
  // Deny by default: only everyday writes run without the owner, even for the queue.
  if (queued) {
    return isEverydayApiWrite(method, rest, true)
      ? ALLOW_VERDICT
      : repoAdminRefusal(`gh api ${method} ${path}`);
  }

  const target = hereSlug && hereSlug[0] === owner && hereSlug[1] === name ? here : null;
  const bases = target ? target.bases() : FALLBACK_BASES;

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
    if (raw === GH_UNREADABLE_INPUT || fields.base === GH_UNREADABLE_INPUT) {
      return {
        verdict: "deny",
        reason: formatMergeRefusal(
          `gh api ${method} ${path} with unreadable input (cannot verify PR base)`,
          target,
          config,
        ),
      };
    }
    const base = (fields.base || readJsonStringField(raw, "base"))
      .trim()
      .replace(/^refs\/heads\//, "");
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
    const branch = fields.branch || readJsonStringField(raw, "branch");
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
