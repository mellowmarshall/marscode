// Canonical renderer imports for design value positions.
// A package-looking name alone is not proof: local packages, dependency aliases
// and resolver overrides retain the ordinary design checks.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { jsonc } from "./pb_design_aliases.mjs";

const DEP_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
const RENDERERS = new Set(["three", "@react-three/fiber"]);
const RESOLVER_CONFIG = /(^|\/)(tsconfig[^/]*\.json|(vite|vitest|webpack|next|metro|babel)\.config\.[cm]?[jt]s|\.babelrc)$/;
const quoted = (value) => `["'\`]${value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}["'\`]`;

function gitEnv() {
  const env = { ...process.env, GIT_NO_REPLACE_OBJECTS: "1", GIT_GRAFT_FILE: "/dev/null" };
  for (const name of Object.keys(env)) {
    if (/^GIT_(DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|REPLACE_REF_BASE|CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+)$/.test(name)) delete env[name];
  }
  return env;
}

function gitListedFiles(root) {
  return execFileSync("git", ["-C", root, "-c", "core.quotePath=false", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    env: gitEnv(),
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  })
    .split("\0")
    .filter((rel) => rel && existsSync(path.join(root, rel)));
}

export function ensureDesignContext(settings) {
  const root = settings.root ?? settings.aliasTarget?.root ?? null;
  if (root && !settings.root) settings.root = root;
  if (settings.contentValues === undefined) {
    let scopes = [];
    if (root && existsSync(path.join(root, "playbook.json"))) {
      try {
        scopes = JSON.parse(readFileSync(path.join(root, "playbook.json"), "utf8"))?.contracts?.design?.content_values?.source ?? [];
      } catch {
        scopes = [];
      }
    }
    settings.contentValues = Array.isArray(scopes) ? scopes : [];
  }
  if (root && (!settings.sourceFiles || !settings.rendererPackage)) {
    const listed = gitListedFiles(root);
    settings.sourceFiles ??= new Set(listed);
    settings.rendererPackage ??= rendererPackageResolver(root, listed);
  }
}

export function rendererPackageResolver(root, listed) {
  const known = new Set(listed), contents = new Map(), owners = new Set();
  const read = (rel) => {
    if (!contents.has(rel)) {
      try { contents.set(rel, readFileSync(path.join(root, rel), "utf8")); }
      catch { contents.set(rel, null); }
    }
    return contents.get(rel);
  };
  const packages = new Map();
  for (const rel of listed.filter((file) => /(^|\/)package\.json$/.test(file))) {
    const pkg = jsonc(read(rel) ?? "");
    if (typeof pkg?.name === "string") owners.add(pkg.name);
    packages.set(rel, pkg);
  }
  const dirsOf = (rel) => {
    const dirs = [];
    for (let dir = path.posix.dirname(rel); ; dir = path.posix.dirname(dir)) {
      dirs.push(dir);
      if (dir === ".") return dirs;
    }
  };
  const join = (dir, file) => dir === "." ? file : `${dir}/${file}`;
  const scopes = new Map();
  const scope = (rel) => {
    const dirs = dirsOf(rel), key = dirs[0];
    if (scopes.has(key)) return scopes.get(key);
    const manifests = dirs.map((dir) => join(dir, "package.json")).filter((file) => known.has(file));
    const deps = new Set(), declared = new Set();
    for (const file of manifests) {
      const pkg = packages.get(file);
      if (!pkg) { for (const name of RENDERERS) declared.add(name); continue; }
      for (const name of RENDERERS) {
        if (declared.has(name)) continue;
        const versions = DEP_FIELDS.filter((field) => Object.hasOwn(pkg[field] ?? {}, name)).map((field) => pkg[field][name]);
        if (!versions.length) continue;
        // A child's explicit local/aliased dependency must prevent fallback to
        // a canonical root dependency. Ambiguous declarations retain checks.
        declared.add(name);
        if (versions.every((version) => typeof version === "string" && version.trim() && !/[:/\\]/.test(version))) deps.add(name);
      }
    }
    const configs = listed.filter((file) => RESOLVER_CONFIG.test(file) && dirs.includes(path.posix.dirname(file)));
    const bodies = [], bases = [], seen = new Set(), active = new Set();
    let doubt = false;
    const config = (file) => {
      if (active.has(file)) { doubt = true; return; }
      if (seen.has(file)) return;
      seen.add(file);
      active.add(file);
      const text = read(file);
      if (text === null) { doubt = true; return; }
      bodies.push(text);
      if (!/tsconfig[^/]*\.json$/.test(file)) { active.delete(file); return; }
      const data = jsonc(text);
      if (!data) { doubt = true; return; }
      const base = data.compilerOptions?.baseUrl;
      if (base !== undefined) {
        if (typeof base !== "string" || path.posix.isAbsolute(base)) doubt = true;
        else {
          const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), base));
          if (target === ".." || target.startsWith("../") || base.includes("\\")) doubt = true;
          else bases.push(target);
        }
      }
      if (data.extends !== undefined) {
        const parent = data.extends;
        if (typeof parent !== "string" || !parent.startsWith(".")) { doubt = true; return; }
        let target = path.posix.normalize(path.posix.join(path.posix.dirname(file), parent));
        if (!target.endsWith(".json")) target += ".json";
        if (target.startsWith("../") || !known.has(target)) { doubt = true; return; }
        config(target);
      }
      active.delete(file);
    };
    for (const file of configs) if (!seen.has(file)) config(file);
    const result = { deps, doubt, bodies: bodies.join("\n"), bases };
    scopes.set(key, result);
    return result;
  };
  return (rel, spec) => {
    if (!RENDERERS.has(spec) || owners.has(spec)) return false;
    const { deps, doubt, bodies, bases } = scope(rel);
    if (doubt || !deps.has(spec)) return false;
    for (const base of bases) {
      const at = join(base, spec);
      if (listed.some((file) => file === at || file.startsWith(`${at}/`) || file.startsWith(`${at}.`))) return false;
    }
    const names = [spec, `${spec}/*`, ...(spec.startsWith("@") ? [`${spec.split("/")[0]}/*`] : [])];
    const keys = names.map(quoted).join("|");
    // Includes tsconfig paths and conventional bundler aliases; ambiguous
    // dynamic resolver configuration remains an ordinary reviewed check input.
    return !new RegExp(`(?:${keys})\\s*:|find\\s*:\\s*(?:${keys})`).test(bodies);
  };
}
