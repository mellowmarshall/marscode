/**
 * surfaceCallers.mjs: The callers outside the repo, and the rule that every route has a caller.
 *
 * A repo that declares surface_callers=<file> names, in that JSON file, who calls
 * the routes no client in the repo calls: a payment provider's webhooks, the
 * platform's health checks, outside agents, and the routes no one calls yet (an
 * entry whose `issue` owns that debt):
 *
 *   { "callers": { "<name>": { "why": "...", "routes": ["POST /v1/webhooks/stripe"],
 *                              "needsTool": true, "issue": "#6" } } }
 *
 * Then, and only then, the generator fails when:
 *   - a route method has no caller: no tool calls that method, no web or mobile
 *     client sends that method to its path (a client call whose method the scanner
 *     cannot read, and every call the regex scanner reads, counts for every method
 *     of the path; sourceScanner.mjs), and no declared caller lists it;
 *   - a declared caller lists a route method the surface lacks (a stale entry);
 *   - a caller with needsTool lists a route method that no tool
 *     (surface_python_callers) calls: the MCP parity rule, for routes outside
 *     agents call;
 *   - an entry has no why, its routes are no list (an empty list keeps a needsTool
 *     caller ready for the routes to come), its issue is not "#N", or it has a
 *     field other than why, routes, needsTool and issue (a typo never turns a
 *     rule off).
 * Keys are exact (`METHOD path`, as the surface lists them): a new route is never
 * covered by an entry written before it.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const FIELDS = ["why", "routes", "needsTool", "issue"];

export function readCallers(root, file) {
  if (!file) return null;
  const full = join(root, file);
  if (!existsSync(full)) throw new Error(`surface: surface_callers names ${file}, which does not exist`);
  let data;
  try {
    data = JSON.parse(readFileSync(full, "utf8"));
  } catch (err) {
    throw new Error(`surface: ${file} is not JSON: ${err.message}`);
  }
  if (!data || typeof data.callers !== "object" || Array.isArray(data.callers)) {
    throw new Error(`surface: ${file} has no "callers" object`);
  }
  return { file, callers: data.callers };
}

/** {"METHOD path": [caller name]} for the declared callers, and the problems of their entries. */
function declaredRoutes(declared, routesMap) {
  const byRoute = new Map();
  const issues = [];
  for (const [name, entry] of Object.entries(declared.callers)) {
    if (!entry || typeof entry.why !== "string" || !entry.why.trim()) issues.push(`caller ${name} in ${declared.file} has no why`);
    const unknown = Object.keys(entry || {}).filter((k) => !FIELDS.includes(k));
    if (unknown.length > 0) issues.push(`caller ${name} in ${declared.file} has unknown field(s) ${unknown.join(", ")} (fields: ${FIELDS.join(", ")})`);
    if (entry && "issue" in entry && !/^#\d+$/.test(String(entry.issue))) issues.push(`caller ${name} in ${declared.file}: issue must be "#N"`);
    if (entry && "needsTool" in entry && typeof entry.needsTool !== "boolean") issues.push(`caller ${name} in ${declared.file}: needsTool must be true or false`);
    if (!Array.isArray(entry?.routes)) {
      issues.push(`caller ${name} in ${declared.file} has no routes list`);
      continue;
    }
    for (const key of entry.routes) {
      const [method, path] = String(key).split(" ");
      if (!routesMap[path]?.methods.includes(method)) {
        issues.push(`caller ${name} in ${declared.file} lists ${key}, which is no route of the surface: remove it`);
        continue;
      }
      if (!byRoute.has(key)) byRoute.set(key, []);
      byRoute.get(key).push(name);
    }
  }
  return { byRoute, issues };
}

/**
 * Adds each route's externalCallers and returns the problems of the every-route-has-a-caller and
 * MCP parity rules, when the repo declares its callers (none otherwise). toolsOf(path, method) is
 * the tools that call that method; clientSends(path, method) whether a web or mobile client sends it.
 */
export function judgeCallers(declared, routesMap, toolsOf = () => [], clientSends = () => true) {
  if (!declared) return [];
  const { byRoute, issues } = declaredRoutes(declared, routesMap);
  for (const [path, route] of Object.entries(routesMap)) {
    const names = new Set();
    for (const method of route.methods) {
      const key = `${method} ${path}`;
      for (const n of byRoute.get(key) || []) names.add(n);
      const called = toolsOf(path, method).length > 0 || clientSends(path, method);
      if (!called && !byRoute.has(key)) {
        issues.push(`${key} (${route.apiFile}) has no caller: no client in the repo calls it and ${declared.file} names none`);
      }
      for (const n of byRoute.get(key) || []) {
        if (declared.callers[n].needsTool && toolsOf(path, method).length === 0) {
          issues.push(`${key} is called by ${n}, which needs a tool for each of its routes, and no tool calls it`);
        }
      }
    }
    route.externalCallers = Array.from(names).sort();
  }
  return issues;
}
