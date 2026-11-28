// @effect-diagnostics nodeBuiltinImport:off - Allowlist of everyday GitHub GraphQL mutations; every other mutation field is owner-only.
import { tokenizeGraphqlQuery, type GraphqlToken } from "./ghGraphqlLexer.ts";

/**
 * Issue, PR, comment, label, reaction and review mutations. A node id does not say which repo it
 * belongs to, so the list applies to every `gh api graphql` call, managed or not.
 */
const EVERYDAY_MUTATIONS: ReadonlySet<string> = new Set([
  "createIssue",
  "updateIssue",
  "closeIssue",
  "reopenIssue",
  "addSubIssue",
  "removeSubIssue",
  "reprioritizeSubIssue",
  "addComment",
  "updateIssueComment",
  "deleteIssueComment",
  "minimizeComment",
  "unminimizeComment",
  "addReaction",
  "removeReaction",
  "createLabel",
  "updateLabel",
  "deleteLabel",
  "addLabelsToLabelable",
  "removeLabelsFromLabelable",
  "clearLabelsFromLabelable",
  "addAssigneesToAssignable",
  "removeAssigneesFromAssignable",
  "updatePullRequest",
  "closePullRequest",
  "reopenPullRequest",
  "markPullRequestReadyForReview",
  "convertPullRequestToDraft",
  "requestReviews",
  "addPullRequestReview",
  "addPullRequestReviewComment",
  "addPullRequestReviewThread",
  "addPullRequestReviewThreadReply",
  "submitPullRequestReview",
  "updatePullRequestReview",
  "deletePullRequestReview",
  "dismissPullRequestReview",
  "updatePullRequestReviewComment",
  "deletePullRequestReviewComment",
  "resolveReviewThread",
  "unresolveReviewThread",
]);

type Fields = { readonly fields: ReadonlyArray<string> } | { readonly error: string };

/** Index just past the selection set that opens at `open`, or -1 when it never closes. */
function skipSelectionSet(tokens: ReadonlyArray<GraphqlToken>, open: number): number {
  let depth = 0;
  for (let i = open; i < tokens.length; i += 1) {
    const t = tokens[i]!;
    if (t.kind !== "punct") continue;
    if (t.value === "{") depth += 1;
    if (t.value === "}" && --depth === 0) return i + 1;
  }
  return -1;
}

/** Root fields of the selection set at `open`; a fragment spread cannot be checked. */
function rootFields(
  tokens: ReadonlyArray<GraphqlToken>,
  open: number,
  out: string[],
): string | null {
  let braces = 0;
  let parens = 0;
  for (let i = open; i < tokens.length; i += 1) {
    const t = tokens[i]!;
    if (t.kind === "punct") {
      if (t.value === "{") braces += 1;
      else if (t.value === "}" && --braces === 0) return null;
      else if (t.value === "(") parens += 1;
      else if (t.value === ")") parens -= 1;
      else if (braces === 1 && parens === 0 && t.value === "...") return "fragment spread";
      else if (braces === 1 && parens === 0 && t.value === "@") i += 1;
      continue;
    }
    if (braces !== 1 || parens !== 0 || t.kind !== "name") continue;
    const next = tokens[i + 1];
    if (next?.kind === "punct" && next.value === ":") {
      const field = tokens[i + 2];
      if (field?.kind !== "name") return "unparseable alias";
      out.push(field.value);
      i += 2;
    } else {
      out.push(t.value);
    }
  }
  return "unclosed selection set";
}

/** Every root field of every `mutation` operation in one document. */
function graphqlMutationFields(src: string): Fields {
  const tokens = tokenizeGraphqlQuery(src);
  if (tokens.some((t) => t.kind === "invalid")) return { error: "unparseable GraphQL" };
  const fields: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i]!;
    let opType = "query";
    if (t.kind === "name") {
      if (!["query", "mutation", "subscription", "fragment"].includes(t.value)) {
        return { error: `unexpected ${t.value}` };
      }
      opType = t.value;
    } else if (!(t.kind === "punct" && t.value === "{")) {
      return { error: "unparseable GraphQL" };
    }
    let open = i;
    let parens = 0;
    while (open < tokens.length) {
      const o = tokens[open]!;
      if (o.kind === "punct" && o.value === "(") parens += 1;
      if (o.kind === "punct" && o.value === ")") parens -= 1;
      if (o.kind === "punct" && o.value === "{" && parens === 0) break;
      open += 1;
    }
    if (open >= tokens.length) return { error: "unparseable GraphQL" };
    if (opType === "subscription") return { error: "subscription" };
    if (opType === "mutation") {
      const err = rootFields(tokens, open, fields);
      if (err) return { error: err };
    }
    const end = skipSelectionSet(tokens, open);
    if (end === -1) return { error: "unclosed selection set" };
    i = end;
  }
  return { fields };
}

/** The first mutation field outside the everyday list (or why the document can't be read), else null. */
export function findUnlistedMutation(
  fields: Readonly<Record<string, string>>,
  parsedInput: unknown,
): string | null {
  const sources: unknown[] = [];
  if (Object.hasOwn(fields, "query")) sources.push(fields.query);
  if (parsedInput && typeof parsedInput === "object" && !Array.isArray(parsedInput)) {
    const obj = parsedInput as Record<string, unknown>;
    if (Object.hasOwn(obj, "query")) sources.push(obj.query);
  }
  for (const src of sources) {
    if (typeof src !== "string") return "non-string query";
    const parsed = graphqlMutationFields(src);
    if ("error" in parsed) return `(${parsed.error})`;
    const unlisted = parsed.fields.find((f) => f !== "__typename" && !EVERYDAY_MUTATIONS.has(f));
    if (unlisted !== undefined) return unlisted;
  }
  return null;
}
