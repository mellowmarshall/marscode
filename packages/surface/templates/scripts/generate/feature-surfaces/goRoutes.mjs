/**
 * goRoutes.mjs: Go net/http, ServeMux, chi, gin, echo, and router-chokepoint routes (surface_go_dirs).
 *
 * Extracts:
 *   - Router chokepoints: r.HandleFunc("GET", "/api/snapshot", "daemon", "devdeck/internal/daemon/http.go", ...)
 *   - Go 1.22+ ServeMux method+path patterns: mux.HandleFunc("GET /api/snapshot", ...)
 *   - Standard net/http registrations: http.HandleFunc("/ping", ...), mux.Handle("/maps/", ...)
 *   - Method helpers (chi/gin/echo/fiber): r.Get("/x", ...), r.POST("/x", ...)
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { withPrefix } from "./routePaths.mjs";

const CHOKEPOINT_CALL =
  /\b\w+\.(?:HandleFunc|Handle)\s*\(\s*"(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)"\s*,\s*"([^"]+)"\s*,\s*"([^"]+)"\s*,\s*"([^"]+)"/g;
const MUX_CALL =
  /\b(?:\w+)\.(?:HandleFunc|Handle)\s*\(\s*"(?:(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+)?(\/[^"]*)"/g;
const METHOD_CALL =
  /\b(?:\w+)\.(Get|Post|Put|Delete|Patch|Head|Options|GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s*\(\s*"(\/[^"]*)"/g;

function stripGoComments(source) {
  return source.replace(
    /("(?:\\.|[^"\\])*"|`[^`]*`|'(?:\\.|[^'\\])*')|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
    (_m, lit) => (lit ? lit : " ")
  );
}

function goPath(path) {
  const cleaned = path.replace(/\{\$\}$/, "");
  return cleaned
    .replace(/\{[^}.]*\.\.\.\}|\{\*[^}]*\}|(^|\/)\*[^/]*/g, (m, lead) => (m.startsWith("{") ? "*" : `${lead}*`))
    .replace(/\{([^}:]+)(?::[^}]*)?\}/g, ":$1") || "/";
}

/**
 * @param {{ root: string, files: string[], prefix: string, unprefixed: string[] }} opts
 * @returns {{ path: string, method: string, file: string, domain?: string, texts: string[] }[]}
 */
export function findGoRoutes({ root, files, prefix, unprefixed }) {
  const out = [];
  for (const file of files) {
    const content = stripGoComments(readFileSync(join(root, file), "utf8"));
    const seenAt = new Set();
    for (const m of content.matchAll(CHOKEPOINT_CALL)) {
      seenAt.add(m.index);
      out.push({
        path: withPrefix(goPath(m[2].trim()), prefix, unprefixed),
        method: m[1].toUpperCase(),
        domain: m[3].trim(),
        file: m[4].trim() || file,
        texts: [m[0]]
      });
    }
    for (const m of content.matchAll(MUX_CALL)) {
      if (seenAt.has(m.index)) continue;
      const method = (m[1] || "GET").toUpperCase();
      const route = m[2].trim();
      if (!route.startsWith("/")) continue;
      out.push({
        path: withPrefix(goPath(route), prefix, unprefixed),
        method,
        file,
        texts: [m[0]]
      });
    }
    for (const m of content.matchAll(METHOD_CALL)) {
      const route = m[2].trim();
      if (!route.startsWith("/")) continue;
      out.push({
        path: withPrefix(goPath(route), prefix, unprefixed),
        method: m[1].toUpperCase(),
        file,
        texts: [m[0]]
      });
    }
  }
  return out;
}
