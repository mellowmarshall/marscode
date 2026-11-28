// The repo's own import aliases,
// for the design rules (PLAYBOOK §10).
//
// An import through a tsconfig path alias (`@/components/SideNav` with
// `"paths": { "@/*": ["./src/*"] }`) is the app's own code, not a third-party
// package: a component it names is no host element, and the UI package that
// imports app code through it reaches app code. This is a minimal read:
// `compilerOptions.paths` of the nearest tsconfig.json above the file, and of
// the tsconfig.app.json beside it; no module resolution. A config whose
// `baseUrl` is not its own folder ("." or "./"), or whose `extends` chain is
// not relative repo files without a `baseUrl` of another folder, has no
// aliases: TypeScript would resolve its paths elsewhere. Three checks, failing closed: an alias is the repo's own code
// only when its key is not a bare `*` and EACH of its targets is a relative
// path inside the repo (no `..`, not absolute, no `node_modules` anywhere);
// its key does not name a dependency of a package.json at or above it (a key like
// `@radix-ui/*` shadows a real package); and the target it resolves to exists
// (a file, the stem of a .ts/.tsx/.js/.jsx/.mjs file, or a directory with an
// index). Otherwise the import is a package, as with no tsconfig or no paths.
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const CONFIGS = ["tsconfig.json", "tsconfig.app.json"];
const EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs"];
const DEP_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

/** JSON with // and block comments and trailing commas, as pb_fleet_cloudflare.jsonc reads it; null when unreadable. */
export function jsonc(text) {
  let out = "";
  let quoted = false;
  let comma = -1; // the index in OUT of the last comma outside a string, while only whitespace follows it
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      out += ch;
      if (ch === "\\") out += text[++i] ?? "";
      else if (ch === '"') quoted = false;
    } else if (ch === '"') {
      quoted = true;
      comma = -1;
      out += ch;
    } else if (text.startsWith("//", i)) {
      while (i + 1 < text.length && text[i + 1] !== "\n") i += 1;
    } else if (text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 1;
    } else if ((ch === "}" || ch === "]") && comma >= 0) {
      out = `${out.slice(0, comma)} ${out.slice(comma + 1)}${ch}`;
      comma = -1;
    } else {
      if (ch === ",") comma = out.length;
      else if (!/\s/.test(ch)) comma = -1;
      out += ch;
    }
  }
  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
}

/** A paths target that stays inside the repo: relative, no "..", no node_modules. */
const isLocalTarget = (target) =>
  typeof target === "string" && !path.posix.isAbsolute(target) && !/^[A-Za-z]:|^\\/.test(target) &&
  !target.split(/[\\/]/).some((part) => part === ".." || part === "node_modules");

/** A key that names a dependency: the exact key, or a `head*` whose head is a dependency's prefix or lies under one. */
const namesDependency = (head, tail, deps) =>
  deps.some((dep) => (tail === null ? head === dep || head.startsWith(`${dep}/`) : dep.startsWith(head) || head.startsWith(`${dep}/`)));

/** `(rel, spec) => target | null`: the repo path (a file or its stem) an aliased import names, or null for a package. */
export function aliasResolver(root) {
  const byDir = new Map();
  const depsByDir = new Map();
  /** The dependency names of every package.json at or above `dir` (repo-relative), up to the repo root. */
  const depsOf = (dir) => {
    if (depsByDir.has(dir)) return depsByDir.get(dir);
    const file = path.join(root, dir, "package.json");
    const pkg = existsSync(file) ? jsonc(readFileSync(file, "utf8")) : null;
    const own = DEP_FIELDS.flatMap((field) => (pkg?.[field] && typeof pkg[field] === "object" ? Object.keys(pkg[field]) : []));
    const found = [...own, ...(dir === "." ? [] : depsOf(path.posix.dirname(dir)))];
    depsByDir.set(dir, found);
    return found;
  };
  /** A config whose paths TypeScript reads from its own folder: baseUrl "." (or none), and an `extends` chain of relative repo files with no baseUrl. */
  const ownBase = (config, dir, depth = 0) => {
    const options = config?.compilerOptions ?? {};
    if (depth > 0 ? "baseUrl" in options : "baseUrl" in options && !/^\.\/?$/.test(options.baseUrl)) return false;
    if (config?.extends === undefined) return true;
    if (typeof config.extends !== "string" || !config.extends.startsWith(".") || depth >= 5) return false;
    let rel = path.posix.normalize(path.posix.join(dir, config.extends));
    if (!rel.endsWith(".json")) rel += ".json";
    if (rel.startsWith("..") || !isFile(rel)) return false;
    return ownBase(jsonc(readFileSync(path.join(root, rel), "utf8")), path.posix.dirname(rel), depth + 1);
  };
  const isFile = (rel) => {
    try {
      return statSync(path.join(root, rel)).isFile();
    } catch {
      return false;
    }
  };
  const exists = (rel) => isFile(rel) || EXTS.some((ext) => isFile(rel + ext) || isFile(`${rel}/index${ext}`));
  const readDir = (dir) => {
    const rules = [];
    let present = false;
    for (const name of CONFIGS) {
      const file = path.join(root, dir, name);
      if (!existsSync(file)) continue;
      present = true;
      const config = jsonc(readFileSync(file, "utf8"));
      if (!ownBase(config, dir)) continue;
      const paths = config?.compilerOptions?.paths;
      for (const [key, targets] of Object.entries(paths && typeof paths === "object" ? paths : {})) {
        const parts = key.split("*");
        if (key === "*" || parts.length > 2 || !Array.isArray(targets) || !targets.length || !targets.every(isLocalTarget)) continue;
        const tail = parts.length === 2 ? parts[1] : null;
        if (namesDependency(parts[0], tail, depsOf(dir))) continue;
        rules.push({ head: parts[0], tail, target: targets[0], dir });
      }
    }
    return present ? rules : undefined;
  };
  const nearest = (dir) => {
    if (byDir.has(dir)) return byDir.get(dir);
    const own = readDir(dir);
    const found = own !== undefined ? own : dir === "." ? [] : nearest(path.posix.dirname(dir));
    byDir.set(dir, found);
    return found;
  };
  const resolve = (rel, spec) => {
    if (typeof spec !== "string" || spec.startsWith(".")) return null;
    for (const { head, tail, target, dir } of nearest(path.posix.dirname(rel))) {
      const matches = tail === null ? spec === head : spec.startsWith(head) && spec.endsWith(tail) && spec.length >= head.length + tail.length;
      if (!matches) continue;
      const star = tail === null ? "" : spec.slice(head.length, spec.length - tail.length);
      const resolved = path.posix.normalize(path.posix.join(dir, target.replace("*", star)));
      const inRepo = !resolved.startsWith("..") && !resolved.split("/").includes("node_modules");
      return inRepo && exists(resolved) ? resolved : null;
    }
    return null;
  };
  resolve.root = root;
  return resolve;
}
