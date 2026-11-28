// @effect-diagnostics nodeBuiltinImport:off - Git-checkout and /data checks for cleanup rule paths, on canonical paths.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

/** Build output a checkout regenerates; the only rule targets allowed inside one. */
const BUILD_OUTPUT_NAMES = new Set([
  "target",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
  "out",
  "coverage",
  "__pycache__",
  ".venv",
]);
const TMP_CACHE_NAMES = new Set(["tmp", "temp", ".tmp", "cache", "caches", ".cache"]);

function hasGitEntry(dir: string): boolean {
  try {
    return NodeFS.existsSync(NodePath.join(dir, ".git"));
  } catch {
    return false;
  }
}

/** The nearest directory at or above `canonicalPath` that holds a `.git` entry. */
export function gitCheckoutAt(canonicalPath: string): string | null {
  let cursor = canonicalPath;
  while (true) {
    if (hasGitEntry(cursor)) return cursor;
    const parent = NodePath.dirname(cursor);
    if (parent === cursor) return null;
    cursor = parent;
  }
}

/** Refuses git metadata, and anything inside a checkout except its build output. */
export function gitRuleRefusal(canonicalPath: string): string | null {
  if (canonicalPath.split("/").includes(".git")) {
    return `Refusing cleanup rule inside git metadata: ${canonicalPath}`;
  }
  const checkout = gitCheckoutAt(canonicalPath);
  if (checkout === null) return null;
  if (checkout === canonicalPath) {
    return `Refusing active git checkout/worktree root: ${canonicalPath}`;
  }
  if (BUILD_OUTPUT_NAMES.has(NodePath.basename(canonicalPath))) return null;
  return `Refusing cleanup rule inside git checkout ${checkout}; only build output (${[...BUILD_OUTPUT_NAMES].join(", ")}) may be targeted there: ${canonicalPath}`;
}

/** Agent proposals under /data must name build output, tmp, or cache; a user's own rule need not. */
export function dataProposalRefusal(canonicalPath: string): string | null {
  if (!canonicalPath.startsWith("/data/")) return null;
  const parts = canonicalPath.split("/").slice(2);
  if (BUILD_OUTPUT_NAMES.has(parts.at(-1) ?? "")) return null;
  if (parts.some((part) => TMP_CACHE_NAMES.has(part))) return null;
  return `Refusing proposed rule under /data that is not build output, tmp, or cache: ${canonicalPath}`;
}
