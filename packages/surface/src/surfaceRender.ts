/** Text views of a feature surface: the dashboard, matched routes and services, and the domains. */
import {
  authCounts,
  authText,
  type ClientServiceMatch,
  type DomainRow,
  domainRows,
  type FeatureSurface,
  type SurfaceRoute,
  surfaceTotals,
} from "./surfaceQuery.ts";

const RULE = "=======================================================";
const LINE = "-------------------------------------------------------";

function counts(c: Readonly<Record<string, number>>): string {
  return Object.keys(c)
    .sort()
    .map((k) => `${k} ${c[k]}`)
    .join(", ");
}

export function renderRoutes(matched: ReadonlyArray<SurfaceRoute>): string {
  const lines = ["", `MATCHED ROUTES (${matched.length}):`];
  for (const r of matched) {
    lines.push(`  ${(r.method ?? "").padEnd(10)} ${r.path ?? ""}`);
    lines.push(`    Domain:       ${r.domain ?? ""}`);
    lines.push(`    Handler File: ${r.apiFile ?? ""}`);
    if (r.auth) lines.push(`    Auth:         ${authText(r)}`);
    if (r.clientConsumers?.length) lines.push(`    Client Calls: ${r.clientConsumers.join(", ")}`);
    if (r.externalCallers?.length) lines.push(`    Outside:      ${r.externalCallers.join(", ")}`);
  }
  lines.push("");
  return lines.join("\n");
}

export function renderClientServices(found: ReadonlyArray<ClientServiceMatch>): string {
  const lines = ["", `MATCHED CLIENT SERVICES (${found.length}):`];
  for (const svc of found) {
    lines.push(`  ${svc.kind.padEnd(7)} ${svc.file}`);
    for (const call of svc.routesCalled ?? []) lines.push(`    calls ${call}`);
  }
  lines.push("");
  return lines.join("\n");
}

export function renderDomains(rows: ReadonlyArray<DomainRow>): string {
  const lines = ["", "=== Feature Surface Domains ===", ""];
  for (const r of rows) {
    lines.push(
      `  ${r.domain.padEnd(25)} (routes: ${String(r.routesCount).padStart(3)}, ` +
        `workers: ${String(r.workersCount).padStart(2)}, mobile: ${String(r.mobileServicesCount).padStart(2)}, ` +
        `web: ${String(r.webServicesCount).padStart(2)})`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

export function renderDashboard(surface: FeatureSurface): string {
  const t = surfaceTotals(surface);
  const lines = [
    "",
    RULE,
    "           FEATURE SURFACE EXPLORER DASHBOARD          ",
    RULE,
    `  Domains:          ${t.totalDomains}`,
    `  Routes:           ${t.totalRoutes}`,
    `  Worker Roles:     ${t.totalWorkerRoles}`,
    `  Mobile Services:  ${t.totalMobileServices}`,
    `  Web/Ops Services: ${t.totalWebServices}`,
  ];
  const auth = authCounts(surface.routes ?? {});
  if (Object.keys(auth).length > 0) lines.push(`  Auth (methods):   ${counts(auth)}`);
  lines.push(LINE, "Top Domains:");
  const top = [...domainRows(surface)].sort((a, b) => b.routesCount - a.routesCount).slice(0, 8);
  for (const d of top) {
    lines.push(
      `  - ${d.domain.padEnd(20)} routes: ${String(d.routesCount).padStart(3)} | ` +
        `workers: ${String(d.workersCount).padStart(2)} | mobile: ${String(d.mobileServicesCount).padStart(2)} | ` +
        `web: ${String(d.webServicesCount).padStart(2)}`,
    );
  }
  lines.push(
    "",
    "Usage:",
    "  surface <query>        Search routes, callers, workers, domains",
    "  surface api <filter>   Routes only; surface client <filter> for callers",
    "  surface --list         List all domains with breakdown",
    "  surface diff           Contract changes against the base branch",
    "  surface check          Judge the PR body's ## Contract Intent",
    RULE,
    "",
  );
  return lines.join("\n");
}

/** The JSON form of the dashboard. */
export function dashboardJson(surface: FeatureSurface): Record<string, unknown> {
  return {
    meta: surface.meta ?? {},
    domains: Object.keys(surface.domains ?? {}),
    ...surfaceTotals(surface),
    auth: authCounts(surface.routes ?? {}),
  };
}
