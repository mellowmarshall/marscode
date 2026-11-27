/**
 * routePaths.mjs: How a client call's path meets a route template.
 *
 * A route template uses :param for one segment and a trailing * for the rest.
 * A call's own :param (a ${...} it could not read) matches only a route's
 * :param, never a fixed segment: `/agents/${id}/card` is no call of
 * `/agents/keys/:kid`. The API prefix is the repo's own (surface_api_prefix,
 * none by default): a call written without it means the prefixed path, unless
 * it starts with one of the unprefixed roots (surface_unprefixed); it never
 * also matches an unprefixed route.
 */

function pathMatchesTemplate(cleanCall, cleanTmpl) {
  if (cleanCall === cleanTmpl) return true;

  const callParts = cleanCall.split("/").filter(Boolean);
  const tmplParts = cleanTmpl.split("/").filter(Boolean);

  // Wildcard routes ending in *
  if (tmplParts[tmplParts.length - 1] === "*") {
    const prefixLen = tmplParts.length - 1;
    if (callParts.length < prefixLen) return false;
    for (let i = 0; i < prefixLen; i++) {
      const cp = callParts[i];
      const tp = tmplParts[i];
      if (tp.startsWith(":")) continue;
      if (cp !== tp) return false;
    }
    return true;
  }

  if (callParts.length !== tmplParts.length) return false;

  for (let i = 0; i < callParts.length; i++) {
    const cp = callParts[i];
    const tp = tmplParts[i];
    if (tp.startsWith(":") || tp === "*") continue;
    if (cp !== tp) return false;
  }
  return true;
}

function clean(path) {
  return path.split("?")[0].replace(/\/+$/, "") || "/";
}

/** Whether `path` sits under one of the roots the prefix never applies to. */
function isUnprefixed(path, unprefixed) {
  return unprefixed.some((root) => path.startsWith(root));
}

/** The route path with the repo's API prefix, when it has one and the path lacks it. */
export function withPrefix(path, prefix, unprefixed) {
  if (!prefix || path === prefix || path.startsWith(`${prefix}/`) || isUnprefixed(path, unprefixed)) return path;
  return prefix + (path.startsWith("/") ? path : `/${path}`);
}

/**
 * @param {string} callPath   the path a client call names
 * @param {string} routeTemplate  a route path from the surface
 * @param {{ prefix?: string, unprefixed?: string[] }} [paths]  the repo's prefix settings
 */
export function routeMatches(callPath, routeTemplate, paths = {}) {
  if (!callPath || !routeTemplate || typeof callPath !== "string" || typeof routeTemplate !== "string") {
    return false;
  }
  const call = withPrefix(clean(callPath), paths.prefix || "", paths.unprefixed || []);
  return pathMatchesTemplate(call, clean(routeTemplate));
}

export function inferDomain(routePath, prefix = "") {
  const parts = routePath.split("/").filter(Boolean);
  const lead = new Set(["v1", "api", ...prefix.split("/").filter(Boolean)]);
  if (parts.length === 0) return "core";
  if (lead.has(parts[0]) && parts.length > 1) return parts[1];
  return parts[0];
}

export function normalizeCallPath(rawArg) {
  const raw = rawArg.trim().replace(/^[`"']|[`"']$/g, "").split("?")[0];
  // A path made only of substitutions (`${base}${path}`, a helper's own fetch) names no route.
  if (/^(\$\{[^}]*\})+$/.test(raw)) return "";
  return raw.replace(/\/\$\{[^}]+\}/g, "/:param").replace(/\$\{[^}]+\}/g, "").replace(/\/+$/, "") || "/";
}
