/**
 * appRouterRoutes.mjs: Next.js App Router route handlers, found from the file system.
 *
 * A handler is a route.(ts|tsx|js|jsx|mjs) file under an app root; its URL is its
 * directory, and its methods are the HTTP method names it exports, whether as
 * `export async function GET`, `export const POST = wrap(...)`, or
 * `export { handler as PUT }` / `export { GET } from "./shared"`.
 *
 * Segments map onto the :param form the rest of the surface uses:
 *   [id] -> :id, [...slug] and [[...slug]] -> *, (group) and @slot vanish.
 * A _private folder, and an intercepting (.)folder, is not routable and is skipped;
 * a %5Ffolder is the escape for a real segment that starts with _.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HTTP_METHODS } from "./sourceScanner.mjs";

const ROUTE_FILE = /^route\.(?:ts|tsx|js|jsx|mjs)$/;

/** URL path for a route file, given its path relative to the app root; null if not routable. */
function appRouterPath(relativeFile) {
  const parts = relativeFile.split("/");
  if (!ROUTE_FILE.test(parts.pop())) return null;
  const segments = [];
  for (const part of parts) {
    if (part.startsWith("_") || /^\(\.{1,3}\)/.test(part)) return null;
    if (/^\(.+\)$/.test(part) || part.startsWith("@")) continue;
    const dynamic = /^\[{1,2}(\.\.\.)?([^\]]+)\]{1,2}$/.exec(part);
    if (dynamic) {
      segments.push(dynamic[1] ? "*" : `:${dynamic[2]}`);
      continue;
    }
    segments.push(part.replace(/^%5F/i, "_"));
  }
  return `/${segments.join("/")}`;
}

/**
 * @param {object} opts
 * @param {string} opts.root      repo root
 * @param {string[]} opts.appDirs app roots relative to the repo root
 * @param {(dir: string) => string[]} opts.walk  repo-relative source files under a dir
 * @param {{ exportedNames(file: string, content: string): Set<string> }} opts.scanner
 * @returns {{ path: string, methods: string[], file: string, text: string }[]}  text: the route file, for its auth level
 */
export function findAppRouterRoutes({ root, appDirs, walk, scanner }) {
  const routes = [];
  for (const appDir of appDirs) {
    const prefix = `${appDir.replace(/\/+$/, "")}/`;
    for (const file of walk(appDir)) {
      const path = appRouterPath(file.slice(prefix.length));
      if (path === null) continue;
      const text = readFileSync(join(root, file), "utf8");
      const exported = scanner.exportedNames(file, text);
      const methods = HTTP_METHODS.filter((m) => exported.has(m));
      if (methods.length === 0) {
        process.stderr.write(`surface: ${file} exports no HTTP method handler; skipped\n`);
        continue;
      }
      routes.push({ path, methods, file, text });
    }
  }
  return routes;
}
