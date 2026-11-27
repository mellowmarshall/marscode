// Converts `@t3tools/ship-queue/toolDrift` reports into Fleet Console alert items and extracts probe maps from persisted host reports.
import type { ToolDriftReport } from "@t3tools/ship-queue/toolDrift";

import type { FleetAlertItem, FleetHostsReport } from "./FleetTypes.ts";

const CI_TOOLCHAIN_SOURCE = "CI toolchain";

/** Converts a structured CI host tool-drift report into Fleet Console alert items. */
export function buildToolDriftAlerts(report: ToolDriftReport): ReadonlyArray<FleetAlertItem> {
  const items: FleetAlertItem[] = [];

  for (const repo of report.repos) {
    if (repo.zeroSatisfyingHosts) {
      items.push({
        source: CI_TOOLCHAIN_SOURCE,
        name: `${repo.repo} (no eligible host)`,
        state: "firing",
        since: report.at,
        detail: `0 eligible hosts satisfy ${repo.requiredTools.join(", ")}; missing on ${repo.driftedSameArchHosts.join(", ")}`,
      });
    } else if (repo.strandedOnSingleHost) {
      items.push({
        source: CI_TOOLCHAIN_SOURCE,
        name: `${repo.repo} (single-host stranding)`,
        state: "firing",
        since: report.at,
        detail: `only ${repo.strandedHost ?? "one host"} satisfies ${repo.requiredTools.join(", ")}; drifted same-arch hosts: ${repo.driftedSameArchHosts.join(", ")}`,
      });
    }
  }

  for (const host of report.hosts) {
    const specs = host.missing.map((m) => m.spec).join(", ");
    const rootNote =
      host.rootRequiredTools.length > 0
        ? ` (needs owner root approval: ${host.rootRequiredTools.join(", ")})`
        : "";
    items.push({
      source: CI_TOOLCHAIN_SOURCE,
      name: `tool drift: ${host.host}`,
      state: "firing",
      since: report.at,
      detail: `missing ${specs}${rootNote}`,
    });
  }

  if (items.length === 0) {
    return [
      {
        source: CI_TOOLCHAIN_SOURCE,
        name: "CI host toolchain",
        state: "ok",
        since: report.at,
        detail: `${report.requiredToolsUnion.length} required tools aligned across eligible hosts`,
      },
    ];
  }

  return items;
}

/**
 * Extracts a best-effort probe map from a persisted `hosts-check.json` report for hosts whose
 * `<queueRoot>/hosts/<host>.probe` file is absent.
 */
export function probesFromHostsReport(
  report: FleetHostsReport | null,
): Readonly<Record<string, Readonly<Record<string, string>> | null>> {
  const out: Record<string, Readonly<Record<string, string>> | null> = {};
  if (!report) return out;

  for (const rawHost of report.hosts) {
    const name = typeof rawHost.name === "string" ? rawHost.name.trim() : "";
    if (!name) continue;
    if (rawHost.reached !== true) {
      out[name] = null;
      continue;
    }
    const probe: Record<string, string> = {};
    if (typeof rawHost.platform === "string" && rawHost.platform.trim()) {
      probe.__os = rawHost.platform.trim();
    }
    if (typeof rawHost.arch === "string" && rawHost.arch.trim()) {
      probe.__arch = rawHost.arch.trim();
    }
    if (Array.isArray(rawHost.tools)) {
      for (const rawTool of rawHost.tools) {
        if (!rawTool || typeof rawTool !== "object") continue;
        const t = rawTool as Record<string, unknown>;
        const toolName = typeof t.name === "string" ? t.name.trim() : "";
        if (!toolName) continue;
        const version =
          typeof t.version === "string" && t.version.trim() ? t.version.trim() : "missing";
        probe[toolName] = version;
      }
    }
    out[name] = Object.keys(probe).length > 0 ? probe : null;
  }
  return out;
}
