// @effect-diagnostics nodeBuiltinImport:off - GitHub GraphQL document lexer shared by the gh api graphql guards.
export type GraphqlToken =
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
export function tokenizeGraphqlQuery(src: string): ReadonlyArray<GraphqlToken> {
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
