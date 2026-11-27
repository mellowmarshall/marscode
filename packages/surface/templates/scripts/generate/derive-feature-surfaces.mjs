#!/usr/bin/env node
/**
 * derive-feature-surfaces.mjs: Keep feature surface contracts synchronized with code.
 *
 * Scans:
 *   - API route paths, methods, handlers, auth levels, and domain grouping
 *     (Fastify/Express registrations, Next.js App Router route.ts files,
 *     axum routers in Rust and FastAPI routers in Python)
 *   - Client service calls (web & mobile), tool calls (surface_python_callers) and storage keys
 *   - Background worker roles
 *   - The callers outside the repo (surface_callers): then a route no one calls fails
 *
 * Where to look and which calls carry API paths is the repo's surface_* keys in
 * .tree-guard.conf (see feature-surfaces/surfaceConfig.mjs).
 *
 * Emits:
 *   - config/contracts/feature-surfaces.json
 *   - what each of the repo's own generators emits (.tree-guard.conf
 *     surface_generators, run in that order: --check in check mode, else write)
 *
 * Usage:
 *   node scripts/generate/derive-feature-surfaces.mjs          # Updates JSON contract map (default)
 *   node scripts/generate/derive-feature-surfaces.mjs --write  # Updates JSON contract map
 *   node scripts/generate/derive-feature-surfaces.mjs --check  # Fails if contracts drift
 *   node scripts/generate/derive-feature-surfaces.mjs --code-map  # Prints the symbol/import map
 *   ... --root DIR   scan DIR instead of the repo this script sits in
 *   ... --stdout     print the contract instead of writing it
 *
 * A repo whose code declares an API but whose scan finds no route is not a
 * pass: the host's intent check (playbook check intent) reports it UNPROVEN.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findAppRouterRoutes } from "./feature-surfaces/appRouterRoutes.mjs";
import { findAxumRoutes } from "./feature-surfaces/axumRoutes.mjs";
import { findGoRoutes } from "./feature-surfaces/goRoutes.mjs";
import { findPythonRoutes } from "./feature-surfaces/pythonRoutes.mjs";
import { buildCodeMap } from "./feature-surfaces/codeMap.mjs";
import { findRegistrationRoutes } from "./feature-surfaces/registrationRoutes.mjs";
import { readRegisteredRoutes, settleByRegistration } from "./feature-surfaces/registeredRoutes.mjs";
import { AUTH_LEVELS, authLevel } from "./feature-surfaces/routeAuth.mjs";
import { inferDomain, normalizeCallPath } from "./feature-surfaces/routePaths.mjs";
import { createSourceScanner, loadTypeScript } from "./feature-surfaces/sourceScanner.mjs";
import { readCallers } from "./feature-surfaces/surfaceCallers.mjs";
import { buildSurface } from "./feature-surfaces/surfaceMaps.mjs";
import { readSurfaceConfig } from "./feature-surfaces/surfaceConfig.mjs";

const rootArg = process.argv.indexOf("--root");
const ROOT = rootArg > 0 && process.argv[rootArg + 1]
  ? resolve(process.argv[rootArg + 1])
  : resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TARGET_PATH = join(ROOT, "config", "contracts", "feature-surfaces.json");

const SKIPPED_DIRS = ["node_modules", ".git", ".next", "dist", "build"];
// Under an App Router root, dist/ and build/ are URL segments, not output.
const APP_ROUTER_SKIPPED_DIRS = ["node_modules", ".git", ".next"];

function walk(dir, extensions = [".ts", ".tsx", ".js", ".jsx"], skippedDirs = SKIPPED_DIRS) {
  const fullDir = join(ROOT, dir);
  if (!existsSync(fullDir)) return [];
  const results = [];
  function recurse(current) {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (!skippedDirs.includes(entry.name)) {
          recurse(full);
        }
      } else if (
        extensions.some((ext) => entry.name.endsWith(ext)) &&
        !entry.name.endsWith(".test.ts") &&
        !entry.name.endsWith(".test.tsx") &&
        !entry.name.endsWith(".test.js") &&
        !entry.name.endsWith(".spec.ts") &&
        !entry.name.endsWith(".spec.tsx") &&
        !entry.name.endsWith(".spec.js") &&
        !entry.name.endsWith(".d.ts")
      ) {
        results.push(relative(ROOT, full).replace(/\\/g, "/"));
      }
    }
  }
  recurse(fullDir);
  return results.sort();
}

function filesUnder(dirs) {
  const files = new Set();
  for (const d of dirs) {
    for (const f of walk(d)) files.add(f);
  }
  return Array.from(files).sort();
}

// Client calls in each file under dirs whose callee is one of patterns, plus (for
// mobile) the storage keys it touches.
function scanClientCalls(dirs, patterns, scanner, withStorageKeys) {
  const callsByRoute = new Map();
  const methodsByCall = new Map(); // call path -> the methods sent to it ("*": one it could not read)
  const servicesByFile = new Map();
  for (const file of filesUnder(dirs)) {
    const content = readFileSync(join(ROOT, file), "utf8");
    const calls = new Set();
    for (const { text, method } of scanner.callPaths(file, content, patterns)) {
      const call = normalizeCallPath(text);
      if (!call.startsWith("/")) continue;
      calls.add(call);
      if (!methodsByCall.has(call)) methodsByCall.set(call, new Set());
      methodsByCall.get(call).add(method || "*");
      if (!callsByRoute.has(call)) callsByRoute.set(call, []);
      callsByRoute.get(call).push(file);
    }

    const storageKeys = new Set();
    if (withStorageKeys) {
      const storageRegex = /(?:storage|SecureStore)\.(?:getItem|setItem|removeItem|getItemAsync|setItemAsync|deleteItemAsync)\s*\(\s*[`"']([^`"'$]+)[`"']/g;
      for (let sm = storageRegex.exec(content); sm !== null; sm = storageRegex.exec(content)) {
        storageKeys.add(sm[1].trim());
      }
    }

    if (calls.size > 0 || storageKeys.size > 0) {
      const svc = { file, routesCalled: Array.from(calls).sort() };
      if (withStorageKeys) svc.storageKeys = Array.from(storageKeys).sort();
      servicesByFile.set(file, svc);
    }
  }
  return { callsByRoute, servicesByFile, methodsByCall };
}

// Each role name the registry files declare, grouped under the "workers" domain (a role name is
// no route path to infer one from); a declared registry that names none fails the run.
function workerRoles(files, pattern) {
  const roles = [];
  for (const file of files) {
    if (!existsSync(join(ROOT, file))) throw new Error(`surface: surface_worker_files names ${file}, which does not exist`);
    // A commented-out registration is no role.
    const content = readFileSync(join(ROOT, file), "utf8").split("\n").filter((l) => !/^\s*(#|\/\/)/.test(l)).join("\n");
    const names = new Set(Array.from(content.matchAll(pattern), (m) => m[1]));
    const found = Array.from(names, (role) => ({ role, file, domain: "workers" }));
    if (found.length === 0) throw new Error(`surface: surface_worker_role matches no role in ${file}`);
    roles.push(...found);
  }
  return roles;
}

// Most restricted last: a path and method found twice keep the less restricted level.
const AUTH_RANK = [...AUTH_LEVELS].reverse();

function addRoute(routes, found, config) {
  const { path, method, file } = found;
  if (!routes.has(path)) {
    routes.set(path, { path, methods: new Set(), file, domain: found.domain || inferDomain(path, config.apiPrefix), auth: new Map(), tools: new Map(), cut: new Set() });
  }
  const route = routes.get(path);
  route.methods.add(method);
  if (found.cut) route.cut.add(method);
  if (!route.tools.has(method)) route.tools.set(method, new Set());
  for (const caller of found.callers || []) route.tools.get(method).add(caller);
  const level = authLevel(config.auth, found.texts);
  const had = route.auth.get(method);
  if (level && (!had || AUTH_RANK.indexOf(level) < AUTH_RANK.indexOf(had))) route.auth.set(method, level);
}

export function deriveFeatureSurfaces() {
  const config = readSurfaceConfig(ROOT);
  const scanner = createSourceScanner(ROOT, config.parser);
  const routes = new Map();

  // 1. Fastify/Express registrations. App Router files are routes by their place, not
  // by app.get(...); keep them out of this scan and the worker list even when an api
  // dir contains them.
  const appPrefixes = config.appDirs.map((d) => `${d.replace(/\/+$/, "")}/`);
  const apiFiles = filesUnder(config.apiDirs).filter((f) => !appPrefixes.some((p) => f.startsWith(p)));
  for (const r of findRegistrationRoutes({ root: ROOT, files: apiFiles, prefix: config.apiPrefix, unprefixed: config.unprefixed })) {
    addRoute(routes, r, config);
  }

  // 1b. Next.js App Router handlers: the path is the file's place under the app root.
  const appWalk = (d) => walk(d, [".ts", ".tsx", ".js", ".jsx", ".mjs"], APP_ROUTER_SKIPPED_DIRS);
  for (const r of findAppRouterRoutes({ root: ROOT, appDirs: config.appDirs, walk: appWalk, scanner })) {
    for (const method of r.methods) addRoute(routes, { path: r.path, method, file: r.file, texts: [r.text] }, config);
  }

  // 1c. axum routers in Rust sources (tests and build output skipped).
  const rustFiles = new Set();
  for (const d of config.rustDirs) {
    for (const f of walk(d, [".rs"], [...SKIPPED_DIRS, "target", "tests", "benches", "examples"])) {
      if (!/(^|\/|_)tests?\.rs$/.test(f)) rustFiles.add(f);
    }
  }
  for (const r of findAxumRoutes({ root: ROOT, files: Array.from(rustFiles).sort() })) addRoute(routes, r, config);

  // 1d. FastAPI routers in Python sources, only where the repo declares them (tests and virtualenvs skipped).
  const pythonFiles = new Set();
  for (const d of config.pythonDirs) {
    for (const f of walk(d, [".py"], [...SKIPPED_DIRS, ".venv", "venv", "__pycache__", "site-packages", "tests"])) {
      if (!/(^|\/)(test_[^/]*|[^/]*_test|conftest)\.py$/.test(f)) pythonFiles.add(f);
    }
  }
  const python = {
    root: ROOT, files: Array.from(pythonFiles).sort(), apiPrefix: config.apiPrefix,
    prefixExprs: config.pythonPrefixExprs, callerFiles: config.pythonCallerFiles
  };
  for (const r of findPythonRoutes(python)) {
    addRoute(routes, r, config);
  }

  // 1e. Go net/http, ServeMux, and router-chokepoint routes (tests and vendor skipped).
  const goFiles = new Set();
  for (const d of config.goDirs || []) {
    for (const f of walk(d, [".go"], [...SKIPPED_DIRS, "vendor", "testdata", "tests"])) {
      if (!f.endsWith("_test.go")) goFiles.add(f);
    }
  }
  for (const r of findGoRoutes({ root: ROOT, files: Array.from(goFiles).sort(), prefix: config.apiPrefix, unprefixed: config.unprefixed })) {
    addRoute(routes, r, config);
  }

  // 1f. The framework's own registration, when the repo declares it: that is the route list, and
  // the scan above only places each route (registeredRoutes.mjs).
  if (config.registered) {
    const place = (path) => ({ path, methods: new Set(), file: "", domain: inferDomain(path, config.apiPrefix), auth: new Map(), tools: new Map(), cut: new Set() });
    const { unplaced, misread } = settleByRegistration(routes, readRegisteredRoutes(ROOT, config.registered), place, config.auth !== null);
    if (unplaced.length > 0) {
      console.error(`surface: ${unplaced.length} registered route(s) the source scan does not place (listed, with no file): ${unplaced.join(", ")}`);
    }
    if (misread.length > 0) {
      console.error(`surface: ${misread.length} path(s) the source scan could not read whole (a template with a value in it; not listed, the registration has the real routes): ${misread.join(", ")}`);
    }
  }

  // 2. Mobile services (with their storage keys) and 3. web services.
  const mobile = scanClientCalls(config.mobileDirs, config.mobileCalls, scanner, true);
  const web = scanClientCalls(config.webDirs, config.webCalls, scanner, false);

  // 4. Workers: the roles a declared registry names (surface_worker_files + surface_worker_role),
  // else the api files whose name says worker.
  const workers = config.workerFiles.length > 0
    ? workerRoles(config.workerFiles, config.workerRole)
    : apiFiles
      .filter((f) => f.toLowerCase().includes("worker"))
      .map((wf) => ({ role: wf.split("/").pop().replace(/\.(ts|js|mjs)$/, ""), file: wf }));

  return buildSurface({
    routes, mobile, web, workers, paths: { prefix: config.apiPrefix, unprefixed: config.unprefixed },
    declaredCallers: readCallers(ROOT, config.callersFile)
  });
}

/** The repo's own generators, in the declared order; one that fails (a stale copy in check mode) fails the umbrella. */
function runRepoGenerators(check) {
  let generators;
  try {
    generators = readSurfaceConfig(ROOT).generators;
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  for (const rel of generators) {
    const res = spawnSync(process.execPath, [join(ROOT, rel), ...(check ? ["--check"] : [])], { cwd: ROOT, stdio: "inherit" });
    if (res.status !== 0) {
      console.error(`${rel}${check ? " --check" : ""} exited ${res.status ?? res.signal}: regenerate with node ${rel}`);
      process.exit(1);
    }
  }
}

// CLI handler
const isDirectExecution =
  process.argv[1] &&
  (process.argv[1].endsWith("derive-feature-surfaces.mjs") ||
    import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/")));

if (isDirectExecution && process.argv.includes("--code-map")) {
  const ts = loadTypeScript(ROOT);
  if (!ts) {
    console.error('--code-map needs the "typescript" package, resolvable from the repo root.');
    process.exit(1);
  }
  let config;
  try {
    config = readSurfaceConfig(ROOT);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  const files = filesUnder([...config.apiDirs, ...config.appDirs, ...config.webDirs, ...config.mobileDirs]);
  // Exit once the write drains: an exit right after it cuts a piped map short.
  process.stdout.write(`${JSON.stringify(buildCodeMap(ts, ROOT, files), null, 2)}\n`, () => process.exit(0));
}

if (isDirectExecution && !process.argv.includes("--code-map")) {
  const isCheck = process.argv.includes("--check");
  const isStdout = process.argv.includes("--stdout");
  const isWrite = !isStdout && (process.argv.includes("--write") || (!isCheck && !process.argv.includes("--help")));

  if (isCheck || isWrite) runRepoGenerators(isCheck);

  let derived;
  try {
    derived = deriveFeatureSurfaces();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  const outputJson = `${JSON.stringify(derived, null, 2)}\n`;

  if (isStdout) {
    // Exit once the write drains: an exit right after it cuts a piped contract short.
    process.stdout.write(outputJson, () => process.exit(0));
  }

  if (isCheck && !isStdout) {
    if (!existsSync(TARGET_PATH)) {
      console.error(`Feature surface contracts MISSING: ${TARGET_PATH}`);
      console.error("Generate with:\n  node scripts/generate/derive-feature-surfaces.mjs --write\n");
      process.exit(1);
    }
    const current = readFileSync(TARGET_PATH, "utf8");
    if (current !== outputJson) {
      console.error("Feature surface contracts in config/contracts/feature-surfaces.json are STALE against code.\n");
      console.error("Regenerate:\n  pnpm generate:feature-surfaces\n");
      process.exit(1);
    }
    console.log(`feature surface contracts ok: ${derived.meta.totalRoutes} routes across ${derived.meta.totalDomains} domains match code.`);
    process.exit(0);
  }

  if (isWrite) {
    mkdirSync(dirname(TARGET_PATH), { recursive: true });
    writeFileSync(TARGET_PATH, outputJson, "utf8");
    console.log(`Updated feature surface contracts in config/contracts/feature-surfaces.json (${derived.meta.totalRoutes} routes, ${derived.meta.totalDomains} domains).`);
    process.exit(0);
  }
}
