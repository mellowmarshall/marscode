/**
 * routeAuth.mjs: The auth level of each route method: public, user, admin or service.
 *
 * The repo names what marks each level in its code, one regular expression per
 * level in .tree-guard.conf (surface_auth_admin, surface_auth_service,
 * surface_auth_user, surface_auth_public), and the level a route with no marker
 * has (surface_auth_default, public unless set). The text a route is judged
 * by is what decides it in its stack: an axum handler fn and the layers over
 * it, a Fastify/Express registration, an App Router route file.
 *
 * Levels are tried most restricted first (admin, service, user, public), so a
 * handler that takes both a user and an admin check is admin. With no marker
 * declared the surface records no auth at all, so the host's intent check
 * (playbook check intent) never sees a level it was not told how to read.
 */

export const AUTH_LEVELS = ["admin", "service", "user", "public"];

/** @param {Record<string, string>} conf the .tree-guard.conf keys */
export function readAuthConfig(conf) {
  const markers = {};
  for (const level of AUTH_LEVELS) {
    const source = conf[`surface_auth_${level}`];
    if (!source) continue;
    try {
      markers[level] = new RegExp(source);
    } catch (err) {
      throw new Error(`surface: surface_auth_${level} is not a regular expression: ${err.message}`);
    }
  }
  const fallback = conf.surface_auth_default || "public";
  if (!AUTH_LEVELS.includes(fallback)) {
    throw new Error(`surface: surface_auth_default must be one of ${AUTH_LEVELS.join(", ")}, not "${fallback}"`);
  }
  return Object.keys(markers).length > 0 ? { markers, fallback } : null;
}

/** The level for a route judged by `texts`, or null when the repo declares no markers. */
export function authLevel(auth, texts) {
  if (!auth) return null;
  for (const level of AUTH_LEVELS) {
    const re = auth.markers[level];
    if (re && texts.some((t) => re.test(t))) return level;
  }
  return auth.fallback;
}
