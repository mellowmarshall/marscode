/**
 * surfaceConfig.mjs: The repo's own declaration of where its routes and client calls are.
 *
 * Read from the surface_* keys of .tree-guard.conf, the file the surface CLI already
 * reads surface_contract from. Every key is optional; a missing key keeps the default.
 *
 *   surface_api_dirs=apps/api/src,src     Fastify/Express sources (app.get('/x', ...))
 *   surface_app_dirs=app,src/app          Next.js App Router roots (their route.ts files)
 *   surface_web_dirs=app,components,lib   web client sources
 *   surface_mobile_dirs=mobile/src        mobile client sources
 *   surface_web_calls=fetch,apiFetch      functions whose argument is an API path
 *   surface_mobile_calls=request,apiFetchWithSession:2
 *   surface_parser=auto                   auto | typescript | regex
 *   surface_rust_dirs=backend             axum sources (.route("/x", get(h)))
 *   surface_python_dirs=backend/app       FastAPI sources (@router.get("/x")); none by default
 *   surface_python_prefix=settings.api_prefix  Python expressions that stand for surface_api_prefix
 *   surface_python_callers=backend/app/routes/mcp.py  Python files whose functions call route handlers
 *                                         (an MCP server's tools): each is a client of those routes
 *   surface_worker_files=backend/app/workers/scheduler.py  the worker registry files (default: the
 *                                         api files whose name says worker)
 *   surface_worker_role=ScheduledJob\(\s*name="([\w.-]+)"  in those files, the role name (group 1)
 *   surface_callers=config/contracts/route-callers.json  the callers outside the repo; declaring it
 *                                         makes a route with no caller fail (surfaceCallers.mjs)
 *   surface_api_prefix=/v1                prefix of Fastify/Express paths (none by default)
 *   surface_unprefixed=/health,/ws        roots the prefix never applies to
 *   surface_auth_admin=<regex>            auth markers, one per level (routeAuth.mjs)
 *   surface_generators=packages/tokens/generate.mjs  the repo's own node generators the umbrella runs
 *   surface_registered=node scripts/registered-routes.mjs  prints the routes the framework registered;
 *                                         declaring it makes that output the route list (registeredRoutes.mjs)
 *                                         before the surface, in this order (--check in check mode);
 *                                         each names its outputs in an `emits: [...]` line
 *
 * A call pattern is a function name, or a dotted chain (api.get), with an optional
 * :N naming the 1-based argument that holds the path (default 1). A bare name also
 * matches it called as a method (client.request(...)).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readAuthConfig } from "./routeAuth.mjs";

const DEFAULT_SURFACE_CONFIG = Object.freeze({
  apiDirs: ["apps/api/src", "src/routes", "apps/api", "src"],
  appDirs: ["app", "src/app", "apps/web/app", "apps/web/src/app"],
  webDirs: ["apps/web/lib", "apps/web/app", "apps/web/components", "web/src", "web/app", "web/lib"],
  mobileDirs: ["apps/mobile/src", "apps/mobile/app", "apps/mobile/components", "mobile/src", "mobile/app"],
  webCalls: ["apiFetch"],
  mobileCalls: ["apiFetch", "apiFetchWithSession:2"],
  rustDirs: ["src", "backend", "crates", "server"],
  goDirs: ["src", "cmd", "internal", "pkg"],
  pythonDirs: [],
  pythonPrefixExprs: [],
  pythonCallerFiles: [],
  workerFiles: [],
  workerRole: null,
  callersFile: null,
  generators: [],
  apiPrefix: "",
  unprefixed: ["/uploads", "/ws", "/ready", "/health", "/metrics"],
  parser: "auto"
});

const LIST_KEYS = {
  surface_api_dirs: "apiDirs",
  surface_app_dirs: "appDirs",
  surface_web_dirs: "webDirs",
  surface_mobile_dirs: "mobileDirs",
  surface_web_calls: "webCalls",
  surface_mobile_calls: "mobileCalls",
  surface_rust_dirs: "rustDirs",
  surface_go_dirs: "goDirs",
  surface_python_dirs: "pythonDirs",
  surface_python_prefix: "pythonPrefixExprs",
  surface_python_callers: "pythonCallerFiles",
  surface_worker_files: "workerFiles",
  surface_unprefixed: "unprefixed",
  surface_generators: "generators"
};

const PARSERS = ["auto", "typescript", "regex"];
const CALL_PATTERN = /^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)(?::([1-9]))?$/;

function parseCallPattern(spec) {
  const m = CALL_PATTERN.exec(spec);
  if (!m) {
    throw new Error(`surface: bad call pattern "${spec}" (expected name, a.b.name, or name:N)`);
  }
  return { spec, callee: m[1], argIndex: m[2] ? Number(m[2]) : 1 };
}

function readConfLines(root) {
  const confPath = join(root, ".tree-guard.conf");
  if (!existsSync(confPath)) return {};
  const conf = {};
  for (const line of readFileSync(confPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const idx = trimmed.indexOf("=");
    conf[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  }
  return conf;
}

export function readSurfaceConfig(root) {
  const conf = readConfLines(root);
  const config = { ...DEFAULT_SURFACE_CONFIG };
  for (const [key, field] of Object.entries(LIST_KEYS)) {
    if (!(key in conf)) continue;
    config[field] = conf[key].split(",").map((s) => s.trim()).filter(Boolean);
  }
  if ("surface_parser" in conf) {
    if (!PARSERS.includes(conf.surface_parser)) {
      throw new Error(`surface: surface_parser must be one of ${PARSERS.join(", ")}, not "${conf.surface_parser}"`);
    }
    config.parser = conf.surface_parser;
  }
  if ("surface_api_prefix" in conf) {
    const prefix = conf.surface_api_prefix.replace(/\/+$/, "");
    if (prefix && !/^\/[\w./-]+$/.test(prefix)) {
      throw new Error(`surface: surface_api_prefix must be a path like /v1, not "${conf.surface_api_prefix}"`);
    }
    config.apiPrefix = prefix;
  }
  if ("surface_worker_role" in conf) {
    let re;
    try {
      re = new RegExp(conf.surface_worker_role, "g");
    } catch (err) {
      throw new Error(`surface: surface_worker_role is not a regular expression: ${err.message}`);
    }
    if (new RegExp(`${re.source}|`).exec("").length < 2) {
      throw new Error("surface: surface_worker_role needs a capture group: the role name");
    }
    config.workerRole = re;
  }
  if ((config.workerFiles.length > 0) !== Boolean(config.workerRole)) {
    throw new Error("surface: surface_worker_files and surface_worker_role are declared together, or neither");
  }
  if (conf.surface_callers) config.callersFile = conf.surface_callers;
  if (conf.surface_registered) config.registered = conf.surface_registered;
  config.auth = readAuthConfig(conf);
  config.webCalls = config.webCalls.map(parseCallPattern);
  config.mobileCalls = config.mobileCalls.map(parseCallPattern);
  return config;
}
