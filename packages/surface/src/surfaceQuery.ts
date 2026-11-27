/**
 * Queries over a generated feature surface: routes by path, domain, handler
 * file or auth level (and callers), client services by file or called path,
 * the domains with their counts, and the dashboard totals.
 */

/** One route of the surface file. `auth` is a level, or {METHOD: level}. */
export interface SurfaceRoute {
  readonly method?: string;
  readonly methods?: ReadonlyArray<string>;
  readonly path?: string;
  readonly domain?: string;
  readonly apiFile?: string;
  readonly auth?: string | Readonly<Record<string, string>>;
  readonly clientConsumers?: ReadonlyArray<string>;
  readonly externalCallers?: ReadonlyArray<string>;
  readonly [field: string]: unknown;
}

export interface SurfaceService {
  readonly file: string;
  readonly routesCalled?: ReadonlyArray<string>;
  readonly [field: string]: unknown;
}

export interface SurfaceDomain {
  readonly routes?: ReadonlyArray<unknown>;
  readonly workerRoles?: ReadonlyArray<unknown>;
  readonly mobileServices?: ReadonlyArray<unknown>;
  readonly webServices?: ReadonlyArray<unknown>;
}

export interface FeatureSurface {
  readonly meta?: Readonly<Record<string, unknown>>;
  readonly routes?: Readonly<Record<string, SurfaceRoute>>;
  readonly domains?: Readonly<Record<string, SurfaceDomain>>;
  readonly mobileServices?: Readonly<Record<string, SurfaceService>>;
  readonly webServices?: Readonly<Record<string, SurfaceService>>;
}

function byKey<T>(record: Readonly<Record<string, T>> | undefined): Array<[string, T]> {
  return Object.entries(record ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** "user", or "GET public, POST admin" when the methods differ. */
export function authText(route: SurfaceRoute): string {
  const auth = route.auth;
  if (auth && typeof auth === "object") {
    const levels = [...new Set(Object.values(auth))].sort();
    if (levels.length === 1) return levels[0] ?? "";
    return Object.keys(auth)
      .sort()
      .map((m) => `${m} ${auth[m]}`)
      .join(", ");
  }
  return auth ?? "";
}

/** How many route methods have each auth level. */
export function authCounts(routes: Readonly<Record<string, SurfaceRoute>>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const r of Object.values(routes)) {
    const auth = r.auth;
    const levels = auth && typeof auth === "object" ? Object.values(auth) : auth ? [auth] : [];
    for (const level of levels) counts[level] = (counts[level] ?? 0) + 1;
  }
  return counts;
}

export function routeMatchesQuery(
  path: string,
  route: SurfaceRoute,
  q: string,
  withCallers: boolean,
): boolean {
  const fields: unknown[] = [path, route.domain ?? "", route.apiFile ?? "", authText(route)];
  if (withCallers) fields.push(...(route.clientConsumers ?? []), ...(route.externalCallers ?? []));
  return fields.some((f) => String(f).toLowerCase().includes(q));
}

/** Routes whose path, domain, handler file or auth (and, unless api-only, callers) contain `q`. */
export function matchRoutes(surface: FeatureSurface, q: string, apiOnly: boolean): SurfaceRoute[] {
  return byKey(surface.routes)
    .filter(([p, info]) => routeMatchesQuery(p, info, q, !apiOnly))
    .map(([, info]) => info);
}

export interface ClientServiceMatch extends SurfaceService {
  readonly kind: "mobile" | "web";
}

/** Client services whose file or called path contains `q`. */
export function clientServices(surface: FeatureSurface, q: string): ClientServiceMatch[] {
  const out: ClientServiceMatch[] = [];
  for (const kind of ["mobile", "web"] as const) {
    for (const [file, svc] of byKey(
      kind === "mobile" ? surface.mobileServices : surface.webServices,
    )) {
      const calls = svc.routesCalled ?? [];
      if (!q || file.toLowerCase().includes(q) || calls.some((c) => c.toLowerCase().includes(q))) {
        out.push({ kind, ...svc });
      }
    }
  }
  return out;
}

export interface DomainRow {
  readonly domain: string;
  readonly routesCount: number;
  readonly workersCount: number;
  readonly mobileServicesCount: number;
  readonly webServicesCount: number;
}

export function domainRows(surface: FeatureSurface): DomainRow[] {
  return byKey(surface.domains).map(([domain, d]) => ({
    domain,
    routesCount: d.routes?.length ?? 0,
    workersCount: d.workerRoles?.length ?? 0,
    mobileServicesCount: d.mobileServices?.length ?? 0,
    webServicesCount: d.webServices?.length ?? 0,
  }));
}

export interface SurfaceTotals {
  readonly totalRoutes: number;
  readonly totalDomains: number;
  readonly totalWorkerRoles: number;
  readonly totalMobileServices: number;
  readonly totalWebServices: number;
}

function metaNumber(
  meta: Readonly<Record<string, unknown>>,
  key: string,
  fallback: number,
): number {
  const v = meta[key];
  return typeof v === "number" ? v : fallback;
}

export function surfaceTotals(surface: FeatureSurface): SurfaceTotals {
  const meta = surface.meta ?? {};
  return {
    totalRoutes: metaNumber(meta, "totalRoutes", Object.keys(surface.routes ?? {}).length),
    totalDomains: metaNumber(meta, "totalDomains", Object.keys(surface.domains ?? {}).length),
    totalWorkerRoles: metaNumber(meta, "totalWorkerRoles", 0),
    totalMobileServices: metaNumber(
      meta,
      "totalMobileServices",
      Object.keys(surface.mobileServices ?? {}).length,
    ),
    totalWebServices: metaNumber(
      meta,
      "totalWebServices",
      Object.keys(surface.webServices ?? {}).length,
    ),
  };
}
