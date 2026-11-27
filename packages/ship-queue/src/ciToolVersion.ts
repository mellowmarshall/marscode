// Toolchain version range evaluation, tool check state, and host lack computation.
import type { CiHostsManifest, CiToolEntry } from "./ciHosts.ts";

const TERM_RE_SRC = "(>=|<=|>|<|=)?[0-9]+(\\.[0-9]+)*";
export const VERSION_RANGE_RE = new RegExp(`^(\\*|${TERM_RE_SRC}( +${TERM_RE_SRC})*)$`);
const VERSION_NUM_RE = /^[0-9]+(\.[0-9]+)*$/;
const VERSION_TERM_RE = /^(>=|<=|>|<|=)?(.*)$/;

export type ToolCheckState =
  | "ok"
  | "missing"
  | "needs-root"
  | "optional"
  | "not-for-host"
  | "unknown";

function versionParts(v: string): number[] {
  return v.split(".").map((n) => Number.parseInt(n, 10));
}

export function compareVersions(a: string, b: string): number {
  const ka = versionParts(a);
  const kb = versionParts(b);
  const len = Math.max(ka.length, kb.length);
  for (let i = 0; i < len; i += 1) {
    const va = ka[i] ?? 0;
    const vb = kb[i] ?? 0;
    if (va !== vb) return va > vb ? 1 : -1;
  }
  return 0;
}

export function versionMatchesRange(version: string, range: string): boolean {
  if (range === "*") return version !== "missing";
  if (!VERSION_NUM_RE.test(version)) return false;
  for (const term of range.split(/\s+/)) {
    if (!term) continue;
    const match = VERSION_TERM_RE.exec(term);
    if (!match) return false;
    const op = match[1];
    const target = match[2] ?? "";
    const cmp = compareVersions(version, target);
    if (!op) {
      const targetParts = versionParts(target);
      const actualParts = versionParts(version);
      for (let i = 0; i < targetParts.length; i += 1) {
        if ((actualParts[i] ?? 0) !== targetParts[i]) return false;
      }
      continue;
    }
    if (
      (op === ">=" && cmp < 0) ||
      (op === ">" && cmp <= 0) ||
      (op === "<=" && cmp > 0) ||
      (op === "<" && cmp >= 0) ||
      (op === "=" && cmp !== 0)
    ) {
      return false;
    }
  }
  return true;
}

export function isToolOutOfScope(tool: CiToolEntry, hostOs: string | undefined): boolean {
  return Boolean(hostOs && tool.os && tool.os.length > 0 && !tool.os.includes(hostOs));
}

export function evaluateToolState(
  name: string,
  toolchain: Readonly<Record<string, CiToolEntry>>,
  probe: Readonly<Record<string, string>>,
): ToolCheckState {
  const tool = toolchain[name];
  if (!tool) return "unknown";
  if (isToolOutOfScope(tool, probe.__os)) return "not-for-host";
  const value = probe[name];
  if (value === undefined) return "unknown";
  if (versionMatchesRange(value, tool.version)) return "ok";
  if (tool.optional) return "optional";
  if (tool.install) return "missing";
  const waits = (tool.needs ?? []).some((depName) => {
    const dep = toolchain[depName];
    return Boolean(dep?.install && !versionMatchesRange(probe[depName] ?? "missing", dep.version));
  });
  return waits ? "missing" : "needs-root";
}

export function parseToolSpec(
  spec: string,
  toolchain: Readonly<Record<string, CiToolEntry>>,
):
  | { readonly ok: true; readonly name: string; readonly range: string }
  | { readonly ok: false; readonly error: string } {
  const atIdx = spec.indexOf("@");
  const name = atIdx >= 0 ? spec.slice(0, atIdx) : spec;
  const range = atIdx >= 0 ? spec.slice(atIdx + 1) : "";
  const entry = toolchain[name];
  if (!entry) {
    const known = Object.keys(toolchain).toSorted().join(" ");
    return { ok: false, error: `${name} is not a tool the CI hosts declare (${known})` };
  }
  if (range && !VERSION_RANGE_RE.test(range)) {
    return {
      ok: false,
      error: `${JSON.stringify(range)} is not a version range (>=V, <V, =V, V or *)`,
    };
  }
  return { ok: true, name, range: range || entry.version };
}

export function computeHostLacks(
  manifest: CiHostsManifest,
  probe: Readonly<Record<string, string>>,
  mode: "base" | "all",
  extraSpecs: ReadonlyArray<string> = [],
): ReadonlyArray<string> {
  const want = new Map<string, string>();
  for (const [name, tool] of Object.entries(manifest.toolchain)) {
    if (mode === "all" ? !tool.optional : Boolean(tool.base)) {
      want.set(name, tool.version);
    }
  }
  const lacks: string[] = [];
  const asked = new Set<string>();
  for (const rawSpec of extraSpecs) {
    const parsed = parseToolSpec(rawSpec, manifest.toolchain);
    if (!parsed.ok) {
      lacks.push(`${rawSpec} (not in the manifest: ${parsed.error})`);
      continue;
    }
    asked.add(parsed.name);
    const prev = want.get(parsed.name);
    if (prev && prev !== parsed.range) {
      const merged = `${prev} ${parsed.range}`
        .split(/\s+/)
        .filter((t) => t && t !== "*")
        .join(" ");
      want.set(parsed.name, merged || "*");
    } else {
      want.set(parsed.name, parsed.range);
    }
  }
  const hostOs = probe.__os;
  for (const [name, range] of want) {
    const tool = manifest.toolchain[name];
    if (!tool) continue;
    if (isToolOutOfScope(tool, hostOs)) {
      if (asked.has(name)) lacks.push(`${name}@${range} (not on ${hostOs})`);
      continue;
    }
    const have = probe[name] ?? "missing";
    if (!versionMatchesRange(have, range)) {
      lacks.push(`${name}@${range} (has ${have})`);
    }
  }
  return lacks;
}
