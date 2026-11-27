// @effect-diagnostics nodeBuiltinImport:off - Fail-closed GitHub GraphQL mutation guard for `gh api graphql`.
import type { HostGuardsConfig } from "./hostConfig.ts";
import { ALLOW_VERDICT, type GuardVerdict } from "./pushGuard.ts";
import { FALLBACK_BASES, formatMergeRefusal, type RepoInfo } from "./repoScope.ts";

export const GH_UNREADABLE_INPUT = "__GH_UNREADABLE_INPUT__";

const GRAPHQL_WRITES: ReadonlyArray<string> = [
  "createPullRequest",
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

function normalizeBranchRef(raw: string): string {
  return raw.trim().replace(/^refs\/heads\//, "");
}

function isSafePlainNonBaseBranch(raw: string, bases: ReadonlyArray<string>): boolean {
  const trimmed = raw.trim();
  if (
    !trimmed ||
    trimmed.includes("\\") ||
    trimmed.includes("{") ||
    trimmed.includes("}") ||
    /\s/.test(trimmed)
  ) {
    return false;
  }
  for (let i = 0; i < trimmed.length; i += 1) {
    const code = trimmed.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return false;
  }
  const branch = normalizeBranchRef(trimmed);
  return branch.length > 0 && !bases.includes(branch);
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

function collectObjectEntriesByKey(value: unknown, targetKey: string, out: unknown[]): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectObjectEntriesByKey(item, targetKey, out);
    return;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === targetKey) {
      out.push(v);
    } else {
      collectObjectEntriesByKey(v, targetKey, out);
    }
  }
}

type GraphqlToken =
  | { readonly kind: "name"; readonly value: string }
  | { readonly kind: "punct"; readonly value: string }
  | { readonly kind: "string"; readonly raw: string }
  | { readonly kind: "block-string" }
  | { readonly kind: "other"; readonly value: string }
  | { readonly kind: "invalid" };

function readQuotedGraphqlString(
  src: string,
  openQuoteIndex: number,
): { readonly raw: string; readonly end: number } | null {
  let raw = "";
  for (let i = openQuoteIndex + 1; i < src.length; i += 1) {
    const ch = src[i]!;
    if (ch === "\\") {
      raw += ch;
      if (i + 1 < src.length) {
        raw += src[i + 1]!;
        i += 1;
      }
      continue;
    }
    if (ch === '"') return { raw, end: i + 1 };
    if (ch === "\n" || ch === "\r") return null;
    raw += ch;
  }
  return null;
}

function readBlockGraphqlStringEnd(src: string, openIndex: number): number | null {
  for (let i = openIndex + 3; i < src.length; i += 1) {
    if (src[i] === "\\" && src.startsWith('"""', i + 1)) {
      i += 3;
      continue;
    }
    if (src.startsWith('"""', i)) return i + 3;
  }
  return null;
}

const GRAPHQL_PUNCTS = new Set([":", "$", "=", "(", ")", "{", "}", "[", "]", "!", "@", "&", "|"]);

/**
 * Lexes a GraphQL document while stripping insignificant whitespace, commas, BOM, and `#` comments
 * per the GraphQL lexical grammar so `baseRefName,:"main"` and `baseRefName#c\n:"main"` normalize
 * identically to `baseRefName:"main"`.
 */
function tokenizeGraphqlQuery(src: string): ReadonlyArray<GraphqlToken> {
  const tokens: GraphqlToken[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "," || ch === "\uFEFF") {
      i += 1;
      continue;
    }
    if (ch === "#") {
      while (i < src.length && src[i] !== "\n" && src[i] !== "\r") i += 1;
      continue;
    }
    if (src.startsWith('"""', i)) {
      const end = readBlockGraphqlStringEnd(src, i);
      if (end === null) {
        tokens.push({ kind: "invalid" });
        return tokens;
      }
      tokens.push({ kind: "block-string" });
      i = end;
      continue;
    }
    if (ch === '"') {
      const quoted = readQuotedGraphqlString(src, i);
      if (quoted === null) {
        tokens.push({ kind: "invalid" });
        return tokens;
      }
      tokens.push({ kind: "string", raw: quoted.raw });
      i = quoted.end;
      continue;
    }
    if (src.startsWith("...", i)) {
      tokens.push({ kind: "punct", value: "..." });
      i += 3;
      continue;
    }
    if (GRAPHQL_PUNCTS.has(ch)) {
      tokens.push({ kind: "punct", value: ch });
      i += 1;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let end = i + 1;
      while (end < src.length && /[A-Za-z0-9_]/.test(src[end]!)) end += 1;
      tokens.push({ kind: "name", value: src.slice(i, end) });
      i = end;
      continue;
    }
    let end = i + 1;
    while (end < src.length && !/[\s,"\uFEFF#]/.test(src[end]!) && !GRAPHQL_PUNCTS.has(src[end]!)) {
      end += 1;
    }
    tokens.push({ kind: "other", value: src.slice(i, end) });
    i = end;
  }
  return tokens;
}

function hasVariableDefault(tokens: ReadonlyArray<GraphqlToken>, varName: string): boolean {
  for (let i = 0; i + 2 < tokens.length; i += 1) {
    const t0 = tokens[i]!;
    const t1 = tokens[i + 1]!;
    const t2 = tokens[i + 2]!;
    if (
      t0.kind === "punct" &&
      t0.value === "$" &&
      t1.kind === "name" &&
      t1.value === varName &&
      t2.kind === "punct" &&
      t2.value === ":"
    ) {
      let j = i + 3;
      while (j < tokens.length) {
        const tj = tokens[j]!;
        if (
          tj.kind === "name" ||
          (tj.kind === "punct" && (tj.value === "[" || tj.value === "]" || tj.value === "!"))
        ) {
          j += 1;
          continue;
        }
        if (tj.kind === "punct" && tj.value === "=") return true;
        break;
      }
    }
  }
  return false;
}

function resolveTopLevelGraphqlVariable(
  varName: string,
  fields: Readonly<Record<string, string>>,
  parsedInput: unknown,
): ReadonlyArray<unknown> {
  const resolved: unknown[] = [];
  if (varName !== "query" && Object.hasOwn(fields, varName)) {
    resolved.push(fields[varName]);
  }
  if (parsedInput && typeof parsedInput === "object" && !Array.isArray(parsedInput)) {
    const obj = parsedInput as Record<string, unknown>;
    const vars = obj.variables;
    if (vars && typeof vars === "object" && !Array.isArray(vars)) {
      const varsObj = vars as Record<string, unknown>;
      if (Object.hasOwn(varsObj, varName)) {
        resolved.push(varsObj[varName]);
      }
    } else if (varName !== "query" && varName !== "variables" && Object.hasOwn(obj, varName)) {
      resolved.push(obj[varName]);
    }
  }
  return resolved;
}

function keyTargetsName(key: string, target: string): boolean {
  return key === target || key.endsWith(`[${target}]`) || key.includes(`[${target}][`);
}

function hasBaseRefNameAssignment(tokens: ReadonlyArray<GraphqlToken>): boolean {
  for (let i = 0; i + 1 < tokens.length; i += 1) {
    const t0 = tokens[i]!;
    const t1 = tokens[i + 1]!;
    if (
      t0.kind === "name" &&
      t0.value === "baseRefName" &&
      t1.kind === "punct" &&
      t1.value === ":"
    ) {
      return true;
    }
  }
  return false;
}

function findGraphqlBaseRetarget(
  text: string,
  fields: Readonly<Record<string, string>>,
  parsedInput: unknown,
  bases: ReadonlyArray<string>,
): string | null {
  if (!/\bupdatePullRequest\b/.test(text)) return null;
  const fieldKeys = Object.keys(fields);
  const touchesBase =
    /\bbaseRefName\b/.test(text) || fieldKeys.some((k) => keyTargetsName(k, "baseRefName"));
  if (!touchesBase) return null;

  const parsedFields: Array<unknown> = [];
  for (const [k, val] of Object.entries(fields)) {
    const trimmed = val.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        parsedFields.push(JSON.parse(trimmed));
      } catch {
        if (k !== "query" && /\bbaseRefName\b/.test(trimmed)) {
          return "unparseable baseRefName field";
        }
      }
    }
  }

  for (const [k, v] of Object.entries(fields)) {
    if (!keyTargetsName(k, "baseRefName")) continue;
    if (!isSafePlainNonBaseBranch(v, bases)) return v.trim() || k;
  }

  const structuredValues: unknown[] = [];
  collectObjectEntriesByKey(parsedInput, "baseRefName", structuredValues);
  for (const parsed of parsedFields) {
    collectObjectEntriesByKey(parsed, "baseRefName", structuredValues);
  }
  for (const val of structuredValues) {
    if (typeof val !== "string" || !isSafePlainNonBaseBranch(val, bases)) {
      return typeof val === "string" ? val.trim() || "baseRefName" : "non-string baseRefName";
    }
  }

  const querySources: string[] = [];
  if (typeof fields.query === "string") querySources.push(fields.query);
  if (
    parsedInput &&
    typeof parsedInput === "object" &&
    !Array.isArray(parsedInput) &&
    typeof (parsedInput as Record<string, unknown>).query === "string"
  ) {
    querySources.push((parsedInput as Record<string, unknown>).query as string);
  }
  for (const [k, v] of Object.entries(fields)) {
    if (
      k !== "query" &&
      /\bbaseRefName\b/.test(v) &&
      hasBaseRefNameAssignment(tokenizeGraphqlQuery(v))
    ) {
      querySources.push(v);
    }
  }

  for (const src of querySources) {
    const tokens = tokenizeGraphqlQuery(src);
    if (tokens.some((t) => t.kind === "invalid")) {
      return "unparseable GraphQL query";
    }
    for (let i = 0; i + 1 < tokens.length; i += 1) {
      const t0 = tokens[i]!;
      const t1 = tokens[i + 1]!;
      if (
        !(
          t0.kind === "name" &&
          t0.value === "baseRefName" &&
          t1.kind === "punct" &&
          t1.value === ":"
        )
      ) {
        continue;
      }
      const valTok = tokens[i + 2];
      if (!valTok) return "missing baseRefName";
      if (valTok.kind === "block-string") return "block-string baseRefName";
      if (valTok.kind === "string") {
        if (!isSafePlainNonBaseBranch(valTok.raw, bases)) {
          return valTok.raw || "baseRefName";
        }
        continue;
      }
      if (valTok.kind === "punct" && valTok.value === "$") {
        const varTok = tokens[i + 3];
        if (!varTok || varTok.kind !== "name") return "unparseable variable";
        const varName = varTok.value;
        if (hasVariableDefault(tokens, varName)) {
          return `default value on $${varName}`;
        }
        const resolved = resolveTopLevelGraphqlVariable(varName, fields, parsedInput);
        if (resolved.length === 0) return `$${varName}`;
        for (const val of resolved) {
          if (typeof val !== "string" || !isSafePlainNonBaseBranch(val, bases)) {
            return typeof val === "string" ? val.trim() || `$${varName}` : `$${varName}`;
          }
        }
        continue;
      }
      return "unverified baseRefName";
    }
  }

  return null;
}

export function decideGhGraphqlCall(
  input: {
    readonly endpoint: string;
    readonly fields: Readonly<Record<string, string>>;
    readonly raw: string;
    readonly hasInputFlag: boolean;
  },
  here: RepoInfo | null,
  config: HostGuardsConfig,
  queued: boolean,
): GuardVerdict {
  if (queued) return ALLOW_VERDICT;
  const { endpoint, fields, raw, hasInputFlag } = input;
  const hasUnreadableField = Object.values(fields).some((v) => v === GH_UNREADABLE_INPUT);
  if (raw === GH_UNREADABLE_INPUT || hasUnreadableField) {
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
  let parsedInput: unknown = null;
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
      parsedInput = parsed;
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

  const bases = here && here.inScope ? here.bases() : FALLBACK_BASES;
  const retargeted = findGraphqlBaseRetarget(text, fields, parsedInput, bases);
  if (retargeted !== null) {
    return {
      verdict: "deny",
      reason: formatMergeRefusal(
        `a GraphQL updatePullRequest mutation retargeting baseRefName to ${retargeted}`,
        here,
        config,
      ),
    };
  }
  return ALLOW_VERDICT;
}
