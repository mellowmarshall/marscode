/**
 * The tracked CI tool catalog (`infra/ci-host/ci-hosts.json`): the one toolchain and guards
 * installer every eligible CI host must hold. The host list is host-local and never committed;
 * a hosts-only manifest gets its `toolchain` and `guards` from this catalog, so a tool is
 * added in git for the whole fleet, never on one machine.
 */
import catalogJson from "../../../infra/ci-host/ci-hosts.json" with { type: "json" };

export const TOOL_CATALOG_SOURCE = "infra/ci-host/ci-hosts.json";

export interface ToolCatalogMerge {
  readonly raw: unknown;
  readonly catalogApplied: boolean;
  readonly warnings: ReadonlyArray<string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** The tracked catalog as committed (bundled into every ship-queue build). */
export function trackedToolCatalog(): unknown {
  return catalogJson;
}

/**
 * Applies the tracked catalog to a parsed host-local manifest. A manifest that declares no
 * `toolchain` takes `toolchain` and `guards` from the catalog. A legacy manifest that still
 * carries its own `toolchain` is returned unchanged with a warning, so its hosts drift from
 * the fleet catalog visibly rather than silently.
 */
export function applyToolCatalog(
  manifest: unknown,
  catalog: unknown = trackedToolCatalog(),
): ToolCatalogMerge {
  if (!isRecord(manifest) || !isRecord(catalog)) {
    return { raw: manifest, catalogApplied: false, warnings: [] };
  }
  if (manifest.toolchain !== undefined) {
    return {
      raw: manifest,
      catalogApplied: false,
      warnings: [
        `the host-local manifest declares its own toolchain, so the tracked catalog (${TOOL_CATALOG_SOURCE}) is not applied; keep only "hosts" in the host-local file`,
      ],
    };
  }
  if (manifest.guards !== undefined) {
    return {
      raw: manifest,
      catalogApplied: false,
      warnings: [
        `the host-local manifest declares guards without a toolchain; keep only "hosts" in the host-local file (${TOOL_CATALOG_SOURCE} holds both)`,
      ],
    };
  }
  const merged: Record<string, unknown> = {
    ...manifest,
    toolchain: catalog.toolchain,
    ...(catalog.guards !== undefined ? { guards: catalog.guards } : {}),
  };
  if (merged.note === undefined && typeof catalog.note === "string") merged.note = catalog.note;
  return { raw: merged, catalogApplied: true, warnings: [] };
}
