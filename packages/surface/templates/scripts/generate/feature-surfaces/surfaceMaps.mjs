/**
 * surfaceMaps.mjs: The feature surface contract, built from what the scanners found.
 *
 * Routes are keyed by path; each lists its methods, its domain, its handler
 * file, its auth level per method (when the repo declares auth markers), and
 * the client files and tools that call it. Domains group routes, client
 * services and worker roles. A client call that matches no route is an error:
 * a caller of a route that does not exist is a broken seam, not a surface. A
 * repo that declares its outside callers also fails a route no one calls
 * (surfaceCallers.mjs).
 */

import { judgeCallers } from "./surfaceCallers.mjs";
import { inferDomain, routeMatches } from "./routePaths.mjs";

const emptyDomain = () => ({ routes: [], mobileServices: [], webServices: [], workerRoles: [] });

function sortedObject(map) {
  const out = {};
  for (const [k, v] of Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b))) out[k] = v;
  return out;
}

function consumersOf(callsByRoute, routePath, paths) {
  const found = new Set();
  for (const [callPath, files] of callsByRoute.entries()) {
    if (routeMatches(callPath, routePath, paths)) for (const f of files) found.add(f);
  }
  return Array.from(found).sort();
}

function unmatchedCalls(label, servicesByFile, routePaths, paths) {
  const issues = [];
  for (const [file, svc] of servicesByFile.entries()) {
    for (const call of svc.routesCalled) {
      if (!routePaths.some((r) => routeMatches(call, r, paths))) {
        issues.push(`${label} call "${call}" in ${file} does not match any declared API route.`);
      }
    }
  }
  return issues;
}

function addServices(domains, servicesByFile, routesMap, key, paths) {
  for (const [file, svc] of servicesByFile.entries()) {
    const matched = new Set();
    for (const r of svc.routesCalled) {
      for (const [routePath, routeData] of Object.entries(routesMap)) {
        if (routeMatches(r, routePath, paths)) matched.add(routeData.domain);
      }
    }
    if (matched.size === 0) matched.add(inferDomain(svc.routesCalled[0] || "core", paths.prefix));
    for (const d of matched) {
      if (!domains[d]) domains[d] = emptyDomain();
      if (!domains[d][key].some((s) => s.file === file)) domains[d][key].push(svc);
    }
  }
}

/**
 * @param {object} found
 * @param {Map<string, {path: string, methods: Set<string>, file: string, domain: string, auth: Map<string, string>}>} found.routes
 * @param {{callsByRoute: Map, servicesByFile: Map}} found.mobile
 * @param {{callsByRoute: Map, servicesByFile: Map}} found.web
 * @param {{role: string, file: string, domain?: string}[]} found.workers
 * @param {{prefix: string, unprefixed: string[]}} found.paths
 * @param {{file: string, callers: object} | null} [found.declaredCallers]  surface_callers, when declared
 */
export function buildSurface({ routes, mobile, web, workers, paths, declaredCallers = null }) {
  const domains = {};
  const routesMap = {};
  for (const [routePath, info] of Array.from(routes.entries()).sort(([a], [b]) => a.localeCompare(b))) {
    if (!domains[info.domain]) domains[info.domain] = emptyDomain();
    const methods = Array.from(info.methods).sort();
    const mobileConsumers = consumersOf(mobile.callsByRoute, routePath, paths);
    const webConsumers = consumersOf(web.callsByRoute, routePath, paths);
    const toolConsumers = Array.from(new Set(Array.from((info.tools || new Map()).values(), (t) => Array.from(t)).flat())).sort();
    const entry = {
      path: routePath,
      method: methods.join(", "),
      methods,
      domain: info.domain,
      apiFile: info.file
    };
    if (info.auth.size > 0) entry.auth = Object.fromEntries(methods.map((m) => [m, info.auth.get(m)]));
    Object.assign(entry, {
      mobileConsumers,
      webConsumers,
      toolConsumers,
      clientConsumers: Array.from(new Set([...mobileConsumers, ...webConsumers, ...toolConsumers])).sort(),
      workerRoles: []
    });
    routesMap[routePath] = entry;
    domains[info.domain].routes.push({ path: routePath, method: entry.method, methods, file: info.file });
  }

  const routePaths = Object.keys(routesMap);
  const issues = [
    ...unmatchedCalls("Mobile", mobile.servicesByFile, routePaths, paths),
    ...unmatchedCalls("Web", web.servicesByFile, routePaths, paths)
  ];
  if (issues.length > 0) {
    throw new Error(`surface: ${issues.length} client call(s) match no route:\n  ${issues.join("\n  ")}`);
  }
  const toolsOf = (path, method) => Array.from(routes.get(path)?.tools?.get(method) || []);
  // Whether a web or mobile client sends METHOD to PATH ("*": a call whose method could not be read).
  const clientSends = (path, method) => [mobile, web].some(({ methodsByCall = new Map() }) =>
    Array.from(methodsByCall.entries()).some(([call, methods]) =>
      (methods.has(method) || methods.has("*")) && routeMatches(call, path, paths)));
  const uncalled = judgeCallers(declaredCallers, routesMap, toolsOf, clientSends);
  if (uncalled.length > 0) {
    throw new Error(`surface: ${uncalled.length} route caller problem(s):\n  ${uncalled.join("\n  ")}`);
  }

  addServices(domains, mobile.servicesByFile, routesMap, "mobileServices", paths);
  addServices(domains, web.servicesByFile, routesMap, "webServices", paths);
  for (const w of workers) {
    const d = w.domain || inferDomain(w.role, paths.prefix);
    if (!domains[d]) domains[d] = emptyDomain();
    domains[d].workerRoles.push({ role: w.role, file: w.file });
  }

  const sortedDomains = {};
  for (const d of Object.keys(domains).sort()) {
    sortedDomains[d] = {
      routes: domains[d].routes.sort((a, b) => a.path.localeCompare(b.path)),
      mobileServices: domains[d].mobileServices.sort((a, b) => a.file.localeCompare(b.file)),
      webServices: domains[d].webServices.sort((a, b) => a.file.localeCompare(b.file)),
      workerRoles: domains[d].workerRoles.sort((a, b) => a.role.localeCompare(b.role))
    };
  }

  return {
    // Generated files say so in their first lines (the host convention).
    $comment: "GENERATED from the route handlers and client calls by scripts/generate/derive-feature-surfaces.mjs; do not edit, regenerate it.",
    meta: {
      generatedAt: "build-time",
      version: 1,
      totalRoutes: routePaths.length,
      totalDomains: Object.keys(sortedDomains).length,
      totalWorkerRoles: workers.length,
      totalMobileServices: mobile.servicesByFile.size,
      totalWebServices: web.servicesByFile.size
    },
    domains: sortedDomains,
    routes: routesMap,
    mobileServices: sortedObject(mobile.servicesByFile),
    webServices: sortedObject(web.servicesByFile)
  };
}
