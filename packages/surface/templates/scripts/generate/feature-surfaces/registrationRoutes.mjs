/**
 * registrationRoutes.mjs: Fastify/Express routes, registered as app.get("/x", ...).
 *
 * The receiver is one of the usual names (app, fastify, router, v1, *Scope). A
 * path gets the repo's API prefix (surface_api_prefix) unless it has it or sits
 * under an unprefixed root. Each registration keeps its own text, from the
 * call to the next registration in the file, for its auth level.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { withPrefix } from "./routePaths.mjs";

const REGISTRATION =
  /(?:(?:\w+Scope|app|v1|fastify|router))\.(get|post|put|delete|patch|head|options|all)\s*(?:<[^>]+>)?\s*\(\s*["'`]?([^"'`$\s,)]+)["'`]?/g;

/**
 * @param {{ root: string, files: string[], prefix: string, unprefixed: string[] }} opts
 * @returns {{ path: string, method: string, file: string, texts: string[], cut?: true }[]} `cut`: the
 *   path is a template with a value in it (`/items/${kind}`): only the text before the value is read
 */
export function findRegistrationRoutes({ root, files, prefix, unprefixed }) {
  const out = [];
  for (const file of files) {
    const content = readFileSync(join(root, file), "utf8");
    const matches = [...content.matchAll(REGISTRATION)];
    matches.forEach((m, i) => {
      const route = m[2].trim().replace(/^['"`]|['"`]$/g, "");
      if (!route.startsWith("/")) return;
      const end = i + 1 < matches.length ? matches[i + 1].index : content.length;
      out.push({
        path: withPrefix(route, prefix, unprefixed),
        method: m[1].toUpperCase(),
        file,
        texts: [content.slice(m.index, end)],
        ...(content[m.index + m[0].length] === "$" ? { cut: true } : {})
      });
    });
  }
  return out;
}
