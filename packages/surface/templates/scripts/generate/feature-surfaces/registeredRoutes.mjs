/**
 * The routes the repo's framework registered (private-repo). A source scan reads how routes are
 * written; a route written in a form the scan does not know leaves the list with no failure. The
 * registration is the place every route passes to exist at all, so a repo may declare a command
 * that prints what its framework registered:
 *
 *   surface_registered=<shell command, run at the repo root>
 *
 * It prints JSON: { "routes": [ { "method": "GET", "path": "/v1/items", "auth": "user" }, ... ] }.
 * `auth` is optional; when given it is the route's auth level and the surface_auth_* markers do not
 * decide it.
 *
 * With the command declared, its output is the route list, for every stack the generator scans
 * (the command prints all the routes of the repo's API). The scan only places a route (its file,
 * its callers):
 *   - a registered route the scan does not place stays in the list and is reported;
 *   - a route the scan read whole that the framework did not register fails the run: it is written
 *     and never registered (dead code, or a route file nobody mounts);
 *   - a path the scan could not read whole (a template with a value in it reads as the text before
 *     the value) is not a route: it is left out and reported, and the registration has the real ones;
 *   - where auth levels are in use (the repo declares auth markers, or the command gives a level to
 *     any route), a route with no level from the command or the scan fails the run.
 */
import { spawnSync } from "node:child_process";

import { AUTH_LEVELS } from "./routeAuth.mjs";

/** How long the repo's command may take: it starts an app and prints its routes, in seconds. */
const COMMAND_SECONDS = 120;

const key = (method, path) => `${method} ${path}`;

/** @returns {{method: string, path: string, auth?: string}[]} what `command` printed, checked. */
export function readRegisteredRoutes(root, command) {
  const run = spawnSync(command, { cwd: root, shell: true, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: COMMAND_SECONDS * 1000, stdio: ["ignore", "pipe", "inherit"] });
  if (run.error || run.status !== 0) {
    const why = run.error?.code === "ETIMEDOUT" ? `did not end in ${COMMAND_SECONDS} s` : run.error ? `failed (${run.error.code ?? run.error.message})` : `exited ${run.status ?? run.signal}`;
    throw new Error(`surface: surface_registered (${command}) ${why}: the routes the framework registered are not known`);
  }
  let printed;
  try {
    printed = JSON.parse(run.stdout);
  } catch (err) {
    throw new Error(`surface: surface_registered (${command}) did not print JSON: ${err.message}`);
  }
  const routes = printed?.routes;
  if (!Array.isArray(routes) || routes.length === 0) throw new Error(`surface: surface_registered (${command}) printed no route: {"routes": [{"method", "path"}]} is expected`);
  const seen = new Set();
  for (const route of routes) {
    if (typeof route?.method !== "string" || !/^[A-Z]+$/.test(route.method) || typeof route?.path !== "string" || !route.path.startsWith("/")) {
      throw new Error(`surface: surface_registered printed a route that is not {"method": "GET", "path": "/..."}: ${JSON.stringify(route)}`);
    }
    if (route.auth !== undefined && !AUTH_LEVELS.includes(route.auth)) {
      throw new Error(`surface: surface_registered gives ${key(route.method, route.path)} the auth level "${route.auth}"; the levels are ${AUTH_LEVELS.join(", ")}`);
    }
    if (seen.has(key(route.method, route.path))) throw new Error(`surface: surface_registered printed ${key(route.method, route.path)} twice`);
    seen.add(key(route.method, route.path));
  }
  return routes;
}

/**
 * Make the registration the route list. `routes` is the scan's map (path -> { methods, file, auth,
 * tools, domain, cut }), changed in place; `place(path)` makes the entry of a path the scan did not
 * find; `authDeclared`: the repo declares auth markers. Then, or when the command gives a level to
 * any route, every listed route has a level.
 * @returns {{unplaced: string[], misread: string[]}} as "METHOD /path": the registered routes the
 *   scan did not place, and the paths the scan could not read whole (removed from the map)
 */
export function settleByRegistration(routes, registered, place, authDeclared) {
  const declared = new Set(registered.map((r) => key(r.method, r.path)));
  const misread = [];
  const written = [];
  for (const [path, route] of [...routes]) {
    for (const method of [...route.methods]) {
      if (declared.has(key(method, path))) continue;
      (route.cut.has(method) ? misread : written).push(key(method, path));
      route.methods.delete(method);
      route.auth.delete(method);
      route.tools.delete(method);
    }
    if (route.methods.size === 0) routes.delete(path);
  }
  if (written.length > 0) {
    throw new Error(`surface: ${written.length} route(s) are written in source and the framework did not register them: ${written.sort().join(", ")}. Register the route, or remove it; if surface_registered leaves out a part of the API, print that part too.`);
  }
  const unplaced = [];
  const noLevel = [];
  const levels = authDeclared || registered.some((r) => r.auth);
  for (const { method, path, auth } of registered) {
    if (!routes.has(path)) routes.set(path, place(path));
    const route = routes.get(path);
    if (!route.methods.has(method)) {
      route.methods.add(method);
      unplaced.push(key(method, path));
    }
    if (!route.tools.has(method)) route.tools.set(method, new Set());
    if (auth) route.auth.set(method, auth);
    if (levels && !route.auth.has(method)) noLevel.push(key(method, path));
  }
  if (noLevel.length > 0) {
    throw new Error(`surface: ${noLevel.length} registered route(s) have no auth level from surface_registered or the scan: ${noLevel.sort().join(", ")}. Print "auth" for them in the command.`);
  }
  return { unplaced: unplaced.sort(), misread: misread.sort() };
}
