// @effect-diagnostics nodeBuiltinImport:off - Reads shell scripts at a commit through the playbook git layer; posix path joins only.
/**
 * `playbook ci-files [--rev REV]` (PLAYBOOK §3): the shell scripts REV's .tree-guard.conf
 * `ship_ci`/`ship_merge` steps name, and every repo .sh/.bash script they invoke, followed.
 * Read at REV (the base), so a branch cannot exempt a file by invoking it.
 */
import * as NodePath from "node:path";

import { parseConf, resolveCommit, showFile } from "./git.ts";

const TREE_GUARD = ".tree-guard.conf";
const SHELL = [".sh", ".bash"] as const;
// A .sh/.bash path, after an optional $VAR/, ${VAR...}/ or $(...)/ prefix.
const PATH = String.raw`["']?(?:\$[A-Za-z_][A-Za-z0-9_]*/|\$\{[^}]*\}/|\$\([^)]*\)/)?([A-Za-z0-9_.][A-Za-z0-9_./-]*\.(?:sh|bash))\b`;
const INVOKE = new RegExp(
  String.raw`(?:^|[;&|()` +
    "`" +
    String.raw`{]|\b(?:then|do|else|time|nohup|exec|bash|sh|source))\s*(?:\b(?:bash|sh|source|exec)\s+(?:-[A-Za-z]+\s+)*)?` +
    PATH +
    String.raw`|(?:^|[;&|(` +
    "`" +
    String.raw`{]|\b(?:then|do|else))\s*\.\s+` +
    PATH,
  "g",
);
const CASE_HEAD = /(?:^\s*|\bcase\s+\S+\s+in\s+)[A-Za-z0-9_.*+?[\]|/$-]+\)/g;
const SHEBANG = /^#!.*\b(ba)?sh\b/;
// Python's str.splitlines boundaries.
const LINE_BREAK = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/;

type Show = (path: string) => string | null;

const isShell = (path: string) => SHELL.some((ext) => path.endsWith(ext));

/** A repo path, normalized; null for one that leaves the repo. */
function norm(path: string): string | null {
  const p = NodePath.posix.normalize(path);
  return p.startsWith("..") || p.startsWith("/") ? null : p;
}

function declared(confText: string | null): string[] {
  const conf = parseConf(confText ?? "");
  const out: string[] = [];
  for (const key of ["ship_ci", "ship_merge"]) {
    for (const value of conf[key] ?? []) {
      const words = value.split(/\s+/).filter(Boolean);
      if (words.length > 0 && value !== "pre-push") out.push(words[0]!);
    }
  }
  return out;
}

/** The shell scripts TEXT (a script in directory HERE) invokes that EXISTS accepts. */
function invoked(text: string, here: string, exists: (path: string) => boolean): string[] {
  const out: string[] = [];
  for (const raw of text.split(LINE_BREAK)) {
    if (raw.trimStart().startsWith("#")) continue;
    const line = (raw.split(/\s#/)[0] ?? "").replace(CASE_HEAD, "");
    for (const m of line.matchAll(INVOKE)) {
      const found = m[1] ?? m[2] ?? "";
      const word = found.startsWith("./") ? found.slice(2) : found;
      for (const cand of [word, word.startsWith("/") ? word : NodePath.posix.join(here, word)]) {
        const p = norm(cand);
        if (p && exists(p)) {
          out.push(p);
          break;
        }
      }
    }
  }
  return out;
}

/** The shell scripts ENTRIES name and those they invoke, followed; SHOW gives a path's text or null. */
function reached(entries: ReadonlyArray<string>, show: Show): Set<string> {
  const seen = new Set<string>();
  const todo = entries
    .map((d) => norm(d.startsWith("./") ? d.slice(2) : d))
    .filter((p): p is string => p !== null);
  while (todo.length > 0) {
    const path = todo.pop()!;
    if (seen.has(path)) continue;
    const text = show(path);
    if (text === null || !(isShell(path) || SHEBANG.test(text))) continue;
    seen.add(path);
    const dir = NodePath.posix.dirname(path);
    todo.push(
      ...invoked(
        text,
        dir === "." ? "" : dir,
        (p) => !seen.has(p) && isShell(p) && show(p) !== null,
      ),
    );
  }
  return seen;
}

/** The CI files at REV (the base), as repo paths, sorted; none when REV is not a commit. */
export function ciFiles(root: string, rev: string): string[] {
  const sha = resolveCommit(root, rev);
  if (sha === null) return [];
  const cache = new Map<string, string | null>();
  const show: Show = (path) => {
    if (!cache.has(path)) cache.set(path, showFile(root, sha, path));
    return cache.get(path) ?? null;
  };
  return [...reached(declared(show(TREE_GUARD)), show)].sort();
}
