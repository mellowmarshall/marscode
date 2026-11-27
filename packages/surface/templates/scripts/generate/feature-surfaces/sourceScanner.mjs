/**
 * sourceScanner.mjs: Reads API paths and exported handler names out of TS/JS sources.
 *
 * The scanner parses with the repo's own `typescript` package, so comments, strings
 * and nested template expressions cannot fool it. Which scanner runs is fixed by what
 * the repo commits, never by what one machine has installed, so the contract cannot
 * flap between a laptop and CI: surface_parser=typescript or =regex picks one, and
 * the default (auto) uses typescript exactly when the root package.json depends on it.
 * A chosen typescript that does not resolve is an error, not a quiet fallback.
 *
 * Both scanners return a call's path argument as its source text with every template
 * substitution kept as ${...}, so the caller normalizes either result the same way,
 * and the HTTP method the call sends: the TypeScript scanner reads a literal `method`
 * in an object literal right after the path (none, or no such argument, is GET); a
 * method it cannot read, and every regex-scanned call, is null (any method).
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

export const HTTP_METHODS = ["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"];

export function loadTypeScript(root) {
  try {
    return createRequire(join(root, "package.json"))("typescript");
  } catch {
    return null;
  }
}

function declaresTypeScript(root) {
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    return Boolean(pkg.dependencies?.typescript || pkg.devDependencies?.typescript);
  } catch {
    return false;
  }
}

export function createSourceScanner(root, mode) {
  if (mode === "regex" || (mode === "auto" && !declaresTypeScript(root))) return regexScanner();
  const ts = loadTypeScript(root);
  if (ts) return astScanner(ts);
  const why = mode === "typescript" ? "surface_parser=typescript" : "package.json depends on typescript";
  throw new Error(`surface: ${why}, but "typescript" does not resolve from ${root}; install dependencies or set surface_parser=regex`);
}

// --- TypeScript compiler API -------------------------------------------------

export function parseSource(ts, file, content) {
  const kind = file.endsWith("x") ? ts.ScriptKind.TSX : file.endsWith(".js") || file.endsWith(".mjs") ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  return ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, kind);
}

function calleeChain(ts, expr) {
  if (ts.isIdentifier(expr)) return [expr.text];
  if (ts.isPropertyAccessExpression(expr)) {
    const left = calleeChain(ts, expr.expression);
    return left ? [...left, expr.name.text] : [expr.name.text];
  }
  return null;
}

function calleeMatches(chain, callee) {
  const want = callee.split(".");
  if (want.length > chain.length) return false;
  // A bare name matches a method call too; a dotted pattern names the whole chain.
  if (want.length === 1) return chain[chain.length - 1] === want[0];
  return want.length === chain.length && want.every((part, i) => chain[i] === part);
}

function literalText(ts, node) {
  while (
    ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) ||
    ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression?.(node)
  ) {
    node = node.expression;
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return node.head.text + node.templateSpans.map((span) => `\${_}${span.literal.text}`).join("");
  }
  return null;
}

// A named export: `export default function GET` is the default export, not GET.
function hasExportModifier(ts, node) {
  const kinds = (ts.getModifiers?.(node) ?? node.modifiers ?? []).map((m) => m.kind);
  return kinds.includes(ts.SyntaxKind.ExportKeyword) && !kinds.includes(ts.SyntaxKind.DefaultKeyword);
}

function bindingNames(ts, name, names) {
  if (ts.isIdentifier(name)) names.add(name.text);
  else for (const el of name.elements) if (!ts.isOmittedExpression(el)) bindingNames(ts, el.name, names);
}

// The method of fetch-style options right after the path: absent is GET; anything not a
// plain object literal with a literal (or no) method is unknown (null).
function callMethod(ts, init) {
  if (!init) return "GET";
  if (!ts.isObjectLiteralExpression(init)) return null;
  let method = "GET";
  for (const prop of init.properties) {
    if (ts.isSpreadAssignment(prop)) return null;
    const name = prop.name && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) ? prop.name.text : null;
    if (name !== "method") continue;
    const text = ts.isPropertyAssignment(prop) ? literalText(ts, prop.initializer) : null;
    if (text === null || /\$\{_\}/.test(text)) return null;
    method = text.toUpperCase();
  }
  return method;
}

function astScanner(ts) {
  return {
    kind: "typescript",
    callPaths(file, content, patterns) {
      const found = [];
      const visit = (node) => {
        if (ts.isCallExpression(node)) {
          const chain = calleeChain(ts, node.expression);
          if (chain) {
            for (const p of patterns) {
              if (!calleeMatches(chain, p.callee)) continue;
              const arg = node.arguments[p.argIndex - 1];
              const text = arg ? literalText(ts, arg) : null;
              if (text !== null) found.push({ text, method: callMethod(ts, node.arguments[p.argIndex]) });
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(parseSource(ts, file, content));
      return found;
    },
    exportedNames(file, content) {
      const names = new Set();
      for (const stmt of parseSource(ts, file, content).statements) {
        if (ts.isFunctionDeclaration(stmt) && stmt.name && hasExportModifier(ts, stmt)) {
          names.add(stmt.name.text);
        } else if (ts.isVariableStatement(stmt) && hasExportModifier(ts, stmt)) {
          for (const decl of stmt.declarationList.declarations) bindingNames(ts, decl.name, names);
        } else if (ts.isExportDeclaration(stmt) && !stmt.isTypeOnly && stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
          for (const el of stmt.exportClause.elements) {
            if (!el.isTypeOnly) names.add(el.name.text);
          }
        }
      }
      return names;
    }
  };
}

// --- Regular-expression fallback ---------------------------------------------

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function callRegex(pattern) {
  // Matches name(...) and obj.name(...) but not othername(...); stops at the path argument.
  const skipArgs = "[^,]+,\\s*".repeat(pattern.argIndex - 1);
  return new RegExp(`(?<![\\w$])${escapeRegex(pattern.callee)}(?:<(?:[^<>]|<[^<>]*>)*>)?\\s*\\(\\s*${skipArgs}(?=[\`"'])`, "g");
}

// The string or template literal starting at content[start], each ${...} kept as ${_}.
function readLiteral(content, start) {
  const quote = content[start];
  let text = "";
  for (let i = start + 1; i < content.length; i++) {
    const ch = content[i];
    if (ch === "\\") {
      text += content[++i] ?? "";
    } else if (ch === quote) {
      // Only a whole argument is a path: "/users/" + id is not one.
      return /^\s*(?:[,)!]|as\b|satisfies\b)/.test(content.slice(i + 1, i + 20)) ? text : null;
    } else if (quote === "`" && ch === "$" && content[i + 1] === "{") {
      let depth = 1;
      for (i += 2; i < content.length && depth > 0; i++) {
        if (content[i] === "{") depth++;
        else if (content[i] === "}") depth--;
      }
      i--;
      text += `\${_}`;
    } else if (quote !== "`" && ch === "\n") {
      return null;
    } else {
      text += ch;
    }
  }
  return null;
}

function regexScanner() {
  return {
    kind: "regex",
    callPaths(_file, content, patterns) {
      const found = [];
      for (const p of patterns) {
        for (const m of content.matchAll(callRegex(p))) {
          const text = readLiteral(content, m.index + m[0].length);
          if (text !== null) found.push({ text, method: null });
        }
      }
      return found;
    },
    exportedNames(_file, content) {
      const names = new Set();
      for (const m of content.matchAll(/export\s+(?:async\s+)?function\s*\*?\s*([\w$]+)/g)) names.add(m[1]);
      for (const m of content.matchAll(/export\s+(?:const|let|var)\s+([\w$]+)/g)) names.add(m[1]);
      for (const m of content.matchAll(/export\s+(?:const|let|var)\s*\{([^}]*)\}\s*=/g)) {
        for (const part of m[1].split(",")) {
          const local = part.split(":").pop().split("=")[0].trim();
          if (local) names.add(local);
        }
      }
      for (const m of content.matchAll(/export\s*\{([^}]*)\}/g)) {
        for (const part of m[1].split(",")) {
          const words = part.trim().split(/\s+/).filter((w) => w !== "type");
          if (words.length > 0 && words[0]) names.add(words[words.length - 1]);
        }
      }
      return names;
    }
  };
}
