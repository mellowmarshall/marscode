// @effect-diagnostics nodeBuiltinImport:off - GitHub REST and GraphQL API write guard for `gh api` calls.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { HostGuardsConfig } from "./hostConfig.ts";
import { ALLOW_VERDICT, type GuardVerdict } from "./pushGuard.ts";
import { FALLBACK_BASES, formatMergeRefusal, inspectRepo, isSlugInScope } from "./repoScope.ts";

const GRAPHQL_WRITES: ReadonlyArray<string> = [
  "mergePullRequest",
  "enablePullRequestAutoMerge",
  "enqueuePullRequest",
  "mergeBranch",
  "updateRef",
  "updateRefs",
  "deleteRef",
  "createCommitOnBranch",
  "updateRepository",
  "createRepositoryRuleset",
  "updateRepositoryRuleset",
  "deleteRepositoryRuleset",
  "updateBranchProtectionRule",
  "deleteBranchProtectionRule",
];

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
  if (filePath === "-") return "__GH_UNREADABLE_INPUT__";
  const abs = NodePath.resolve(cwd, filePath);
  try {
    const st = NodeFS.statSync(abs);
    if (!st.isFile()) return "__GH_UNREADABLE_INPUT__";
    return NodeFS.readFileSync(abs, "utf8");
  } catch {
    return "__GH_UNREADABLE_INPUT__";
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

function normalizeApiPath(endpoint: string): string {
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

function collectDecodedStrings(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectDecodedStrings(item, out);
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out.push(k);
      collectDecodedStrings(v, out);
    }
  }
}

function decodeMaybeJsonField(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[") || trimmed.startsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const parts: string[] = [];
      collectDecodedStrings(parsed, parts);
      return parts.join(" ");
    } catch {
      // fall through to raw string
    }
  }
  return raw;
}

export function decideGhApiCall(
  args: ReadonlyArray<string>,
  cwd: string,
  config: HostGuardsConfig,
  queued: boolean,
): GuardVerdict {
  const { endpoint, method, fields, raw, hasInputFlag } = parseApiParts(args, cwd);
  const path = normalizeApiPath(endpoint);
  const here = inspectRepo(cwd, config);

  if (path === "graphql") {
    if (queued) return ALLOW_VERDICT;
    const hasUnreadableField = Object.values(fields).some((v) => v === "__GH_UNREADABLE_INPUT__");
    if (raw === "__GH_UNREADABLE_INPUT__" || hasUnreadableField) {
      return {
        verdict: "deny",
        reason: formatMergeRefusal(
          "gh api graphql with unreadable stdin/FIFO/@file input (cannot verify mutation safety)",
          here,
          config,
        ),
      };
    }

    const decodedParts: string[] = [endpoint];
    for (const [k, v] of Object.entries(fields)) {
      decodedParts.push(k, decodeMaybeJsonField(v));
    }
    if (raw.trim()) {
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          return {
            verdict: "deny",
            reason: formatMergeRefusal(
              "gh api graphql --input must be a valid JSON object",
              here,
              config,
            ),
          };
        }
        collectDecodedStrings(parsed, decodedParts);
      } catch {
        return {
          verdict: "deny",
          reason: formatMergeRefusal(
            "gh api graphql --input contains invalid JSON (cannot verify mutation safety)",
            here,
            config,
          ),
        };
      }
    }

    const text = decodedParts.join(" ");
    const matchedMutation = GRAPHQL_WRITES.find((mut) => new RegExp(`\\b${mut}\\b`).test(text));
    if (matchedMutation || (!text.trim() && hasInputFlag)) {
      return {
        verdict: "deny",
        reason: formatMergeRefusal(
          `a GraphQL mutation (${matchedMutation ?? "unreadable input"}) that merges or moves a branch`,
          here,
          config,
        ),
      };
    }
    return ALLOW_VERDICT;
  }

  const repoMatch = /^repos\/([^/]+)\/([^/]+)(?:\/(.*))?$/.exec(path);
  if (!repoMatch || method === "GET") return ALLOW_VERDICT;

  let owner = repoMatch[1]!.toLowerCase();
  let name = repoMatch[2]!.toLowerCase();
  const rest = (repoMatch[3] ?? "").replace(/\/+$/, "");
  const hereSlug = here && here.inScope ? here.slug.split("/") : null;

  if (owner === "{owner}" || owner === ":owner") {
    if (!hereSlug?.[0]) {
      return {
        verdict: "deny",
        reason: formatMergeRefusal(`gh api ${method} ${path} (unresolved {owner})`, here, config),
      };
    }
    owner = hereSlug[0];
  }
  if (name === "{repo}" || name === ":repo") {
    if (!hereSlug?.[1]) {
      return {
        verdict: "deny",
        reason: formatMergeRefusal(`gh api ${method} ${path} (unresolved {repo})`, here, config),
      };
    }
    name = hereSlug[1];
  }

  if (!isSlugInScope(owner, config, name)) return ALLOW_VERDICT;
  if (queued) return ALLOW_VERDICT;

  const target = hereSlug && hereSlug[0] === owner && hereSlug[1] === name ? here : null;
  const bases = target ? target.bases() : FALLBACK_BASES;

  if (
    /^pulls\/\d+\/merge$/.test(rest) ||
    rest === "merges" ||
    rest === "merge-upstream" ||
    rest === "" ||
    /^rulesets(?:\/.*)?$/.test(rest)
  ) {
    return {
      verdict: "deny",
      reason: formatMergeRefusal(`gh api ${method} ${path}`, target, config),
    };
  }

  const refMatch =
    /^git\/refs\/heads\/(.+)$/.exec(rest) ??
    /^branches\/([^/]+)\/(?:protection(?:\/.*)?|rename)$/.exec(rest);
  if (refMatch?.[1] && bases.includes(refMatch[1])) {
    return {
      verdict: "deny",
      reason: formatMergeRefusal(`gh api ${method} ${path} (the base branch)`, target, config),
    };
  }

  if (rest.startsWith("contents/") && (method === "PUT" || method === "DELETE")) {
    const branch = fields.branch || readJsonStringField(raw, "branch");
    if (!branch || bases.includes(branch)) {
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
  return ALLOW_VERDICT;
}
