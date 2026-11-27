// @effect-diagnostics nodeBuiltinImport:off - headless CLI library on node:* builtins only.
/**
 * `surface init`: write the generator templates into the repo (kept unless --force),
 * derive the first contract with the package's own generator (`--root`, no repo code),
 * and add the generate script and the Contract Intent guidance.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { DEFAULT_CONTRACT } from "./surfaceLocate.ts";

const GENERATOR = NodePath.join("scripts", "generate", "derive-feature-surfaces.mjs");
export const GENERATE_SCRIPT = "node scripts/generate/derive-feature-surfaces.mjs --write";
const MODULES_DIR = NodePath.join("scripts", "generate", "feature-surfaces");
export const AGENTS_BLURB =
  "\n**Feature surfaces & contract intent:** Query routes and consumers with `surface <api|client> <filter>`. " +
  "When a change adds, removes, or modifies a route (its auth level included), the PR body must declare it; " +
  "`surface check` refuses undeclared changes:\n" +
  "```\n## Contract Intent\n- <ADD|REMOVE|MODIFY> surface <METHOD> <path> (<why>)\n```\n" +
  "Regenerate contracts with the repo's `pnpm generate`.\n";

/** The package's templates: SURFACE_TEMPLATES, else `templates/` beside `src/`. */
export function templatesDir(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  const dir =
    env.SURFACE_TEMPLATES || NodeURL.fileURLToPath(new URL("../templates", import.meta.url));
  try {
    return NodeFS.statSync(dir).isDirectory() ? dir : null;
  } catch {
    return null;
  }
}

/** Every .mjs and .py template, relative to the templates dir (and the repo). */
export function templateFiles(dir: string): string[] {
  const found: string[] = [];
  const walk = (rel: string) => {
    for (const entry of NodeFS.readdirSync(NodePath.join(dir, rel), { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "__pycache__") continue;
      const child = NodePath.join(rel, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (/\.(mjs|py)$/.test(entry.name)) found.push(child);
    }
  };
  walk("");
  return found.sort();
}

function lexists(p: string): boolean {
  try {
    NodeFS.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function isSymlink(p: string): boolean {
  try {
    return NodeFS.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function removeRetired(repoRoot: string, expected: Set<string>, log: (s: string) => void): void {
  const modDir = NodePath.join(repoRoot, MODULES_DIR);
  if (!NodeFS.existsSync(modDir) || isSymlink(modDir)) return;
  const walk = (dir: string) => {
    const items = NodeFS.readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    );
    for (const entry of items) {
      const full = NodePath.join(dir, entry.name);
      const rel = NodePath.relative(repoRoot, full);
      if (entry.isSymbolicLink()) {
        NodeFS.unlinkSync(full);
        log(`  [remove] ${rel} (retired template)`);
      } else if (entry.isDirectory()) {
        if (!entry.name.startsWith(".") && entry.name !== "__pycache__") walk(full);
      } else if (!expected.has(rel)) {
        NodeFS.rmSync(full);
        log(`  [remove] ${rel} (retired template)`);
      }
    }
  };
  walk(modDir);
}

export function writeTemplates(
  repoRoot: string,
  dir: string,
  force: boolean,
  log: (s: string) => void,
): void {
  const expected = new Set(templateFiles(dir));
  for (const rel of [...expected].sort()) {
    const path = NodePath.join(repoRoot, rel);
    if (lexists(path) && !force) {
      log(`  [keep] ${rel} (already exists)`);
      continue;
    }
    // A symlinked parent or file would write outside the repo: replace it with a real one.
    const parts = rel.split(NodePath.sep);
    for (let i = 1; i < parts.length; i += 1) {
      const parent = NodePath.join(repoRoot, ...parts.slice(0, i));
      if (isSymlink(parent)) NodeFS.unlinkSync(parent);
    }
    NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
    if (isSymlink(path)) NodeFS.unlinkSync(path);
    NodeFS.writeFileSync(path, NodeFS.readFileSync(NodePath.join(dir, rel), "utf8"));
    NodeFS.chmodSync(path, 0o755);
    log(`  [create] ${rel}`);
  }
  if (force) removeRetired(repoRoot, expected, log);
}

function deriveContract(repoRoot: string, dir: string, log: (s: string) => void): boolean {
  if (NodeFS.existsSync(NodePath.join(repoRoot, DEFAULT_CONTRACT))) {
    log(`  [keep] ${DEFAULT_CONTRACT} (already exists; the repo's generate command refreshes it)`);
    return true;
  }
  log(
    "\nDeriving the first feature surface contract (the package's generator, --root this repo)...",
  );
  const res = NodeChildProcess.spawnSync(
    process.execPath,
    [NodePath.join(dir, GENERATOR), "--root", repoRoot, "--write"],
    { cwd: repoRoot, encoding: "utf8" },
  );
  if (res.stdout) log(res.stdout.trimEnd());
  if (res.stderr) log(res.stderr.trimEnd());
  return res.status === 0;
}

function addPackageScript(repoRoot: string, log: (s: string) => void): void {
  const pkgPath = NodePath.join(repoRoot, "package.json");
  if (!NodeFS.existsSync(pkgPath)) return;
  try {
    const pkg = JSON.parse(NodeFS.readFileSync(pkgPath, "utf8")) as {
      scripts?: Record<string, string>;
    };
    pkg.scripts ??= {};
    if (pkg.scripts["generate:feature-surfaces"] === GENERATE_SCRIPT) return;
    pkg.scripts["generate:feature-surfaces"] = GENERATE_SCRIPT;
    NodeFS.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
    log("  [update] package.json (generate:feature-surfaces)");
  } catch (error) {
    log(`  [warning] could not update package.json: ${(error as Error).message}`);
  }
}

function addAgentsGuidance(repoRoot: string, log: (s: string) => void): void {
  const path = NodePath.join(repoRoot, "AGENTS.md");
  if (!NodeFS.existsSync(path)) return;
  let content = NodeFS.readFileSync(path, "utf8");
  if (content.includes("Contract Intent")) return;
  const marker = "## Local Overrides";
  const at = content.indexOf(marker);
  if (at >= 0) {
    const idx = at + marker.length;
    content = `${content.slice(0, idx)}\n${AGENTS_BLURB}${content.slice(idx)}`;
  } else {
    content += `\n${marker}\n${AGENTS_BLURB}`;
  }
  NodeFS.writeFileSync(path, content);
  log("  [update] AGENTS.md (Contract Intent guidance)");
}

export interface InitOutput {
  readonly out: (s: string) => void;
  readonly err: (s: string) => void;
}

export function initSurface(
  repoRoot: string,
  force: boolean,
  io: InitOutput,
  dir = templatesDir(),
): number {
  const log = (s: string) => io.out(`${s}\n`);
  log(`=== Initializing Feature Surfaces in ${repoRoot} ===`);
  if (!dir) {
    io.err(
      "surface: templates not found; set SURFACE_TEMPLATES to the package's templates directory\n",
    );
    return 1;
  }
  writeTemplates(repoRoot, dir, force, log);
  if (!deriveContract(repoRoot, dir, log)) {
    io.err("surface: initial derivation failed\n");
    return 1;
  }
  addPackageScript(repoRoot, log);
  addAgentsGuidance(repoRoot, log);
  log("\n[SUCCESS] Feature surfaces initialized.");
  log(
    "Next: add `node scripts/generate/derive-feature-surfaces.mjs` to the repo's generate umbrella, and " +
      "declare the file as intent.contracts.surface in playbook.json.",
  );
  log("Explore seams with: surface");
  return 0;
}
