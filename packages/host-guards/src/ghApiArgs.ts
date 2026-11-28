// @effect-diagnostics nodeBuiltinImport:off - `gh api` argv parser that reads flags the way gh's pflag does (exact long names, bundled short flags).
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export const GH_UNREADABLE_INPUT = "__GH_UNREADABLE_INPUT__";

/** Long flags of `gh api` that take a value; pflag has no prefix matching, so names are exact. */
const LONG_VALUE_FLAGS = new Set([
  "method",
  "raw-field",
  "field",
  "header",
  "input",
  "jq",
  "template",
  "hostname",
  "preview",
  "cache",
]);
const LONG_BOOL_FLAGS = new Set([
  "include",
  "paginate",
  "slurp",
  "silent",
  "verbose",
  "allow-escape-sequences",
  "help",
]);
const SHORT_TO_LONG: Readonly<Record<string, string>> = {
  X: "method",
  f: "raw-field",
  F: "field",
  H: "header",
  q: "jq",
  t: "template",
  p: "preview",
  i: "include",
  h: "help",
};

export interface GhApiParts {
  readonly endpoint: string;
  readonly method: string;
  readonly fields: Record<string, string>;
  readonly raw: string;
  readonly hasInputFlag: boolean;
  /** A flag gh would not map to exactly one known flag, or a method-override header; refused. */
  readonly unknownFlag: string | null;
}

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

/**
 * Splits one argv word into flag/value pairs. A short bundle (`-iXDELETE`, `-iX=DELETE`) runs
 * booleans until the first value flag, which takes the rest of the word or the next word.
 */
function splitFlagWord(word: string): {
  readonly pairs: ReadonlyArray<{ readonly name: string; readonly value: string | null }>;
  readonly needsNext: string | null;
  readonly unknown: boolean;
} {
  if (word.startsWith("--")) {
    const eq = word.indexOf("=");
    const name = eq === -1 ? word.slice(2) : word.slice(2, eq);
    if (LONG_VALUE_FLAGS.has(name)) {
      return eq === -1
        ? { pairs: [], needsNext: name, unknown: false }
        : { pairs: [{ name, value: word.slice(eq + 1) }], needsNext: null, unknown: false };
    }
    if (LONG_BOOL_FLAGS.has(name)) {
      return { pairs: [{ name, value: null }], needsNext: null, unknown: false };
    }
    return { pairs: [], needsNext: null, unknown: true };
  }
  const pairs: Array<{ readonly name: string; readonly value: string | null }> = [];
  for (let i = 1; i < word.length; i += 1) {
    const name = SHORT_TO_LONG[word[i]!];
    if (!name) return { pairs, needsNext: null, unknown: true };
    if (!LONG_VALUE_FLAGS.has(name)) {
      pairs.push({ name, value: null });
      continue;
    }
    const tail = word.slice(i + 1);
    if (!tail) return { pairs, needsNext: name, unknown: false };
    pairs.push({ name, value: tail.startsWith("=") ? tail.slice(1) : tail });
    return { pairs, needsNext: null, unknown: false };
  }
  return { pairs, needsNext: null, unknown: false };
}

export function parseApiParts(args: ReadonlyArray<string>, cwd: string): GhApiParts {
  let endpoint = "";
  let method = "";
  const fields: Record<string, string> = {};
  let raw = "";
  let hasInputFlag = false;
  let unknownFlag: string | null = null;
  let ended = false;

  const apply = (name: string, value: string) => {
    if (name === "method") {
      method = value.toUpperCase();
    } else if (name === "raw-field" || name === "field") {
      const veq = value.indexOf("=");
      const k = veq === -1 ? value : value.slice(0, veq);
      let v = veq === -1 ? "" : value.slice(veq + 1);
      if (name === "field" && v.startsWith("@")) v = readRegularInputFile(v.slice(1), cwd);
      fields[k] = v;
    } else if (name === "header" && /^\s*x-http-method(?:-override)?\s*:/i.test(value)) {
      unknownFlag ??= `-H ${value}`;
    } else if (name === "input") {
      hasInputFlag = true;
      raw = readRegularInputFile(value, cwd);
    }
  };

  for (let i = 1; i < args.length; i += 1) {
    const a = args[i]!;
    if (ended || !a.startsWith("-") || a === "-") {
      if (!endpoint) endpoint = a;
      continue;
    }
    if (a === "--") {
      ended = true;
      continue;
    }
    const split = splitFlagWord(a);
    if (split.unknown) unknownFlag ??= a;
    for (const pair of split.pairs) {
      if (pair.value !== null) apply(pair.name, pair.value);
    }
    if (split.needsNext) {
      apply(split.needsNext, i + 1 < args.length ? args[i + 1]! : "");
      i += 1;
    }
  }

  if (!method) {
    method = Object.keys(fields).length > 0 || raw.length > 0 || hasInputFlag ? "POST" : "GET";
  }
  return { endpoint, method, fields, raw, hasInputFlag, unknownFlag };
}
