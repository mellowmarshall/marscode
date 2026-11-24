// @effect-diagnostics nodeBuiltinImport:off - Reads the latest local reaper disk scan JSON snapshot.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

export interface ReaperHostScanMount {
  readonly mount: string;
  readonly used_pct: number;
  readonly avail_bytes?: number;
  readonly total_bytes?: number;
}

export interface ReaperHostScan {
  readonly host?: string;
  readonly scanned_at?: string;
  readonly mounts: ReadonlyArray<ReaperHostScanMount>;
  readonly [key: string]: unknown;
}

function defaultReaperScanPath(homeDir: string = NodeOS.homedir()): string {
  return NodePath.join(homeDir, ".local", "state", "agent-tmp-reap", "last-scan.json");
}

export function readLastReaperScanSync(
  scanPath: string = defaultReaperScanPath(),
): ReaperHostScan | null {
  try {
    if (!NodeFS.existsSync(scanPath)) return null;
    const raw = JSON.parse(NodeFS.readFileSync(scanPath, "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const obj = raw as Record<string, unknown>;
    const mountsRaw = Array.isArray(obj.mounts) ? obj.mounts : [];
    const mounts: ReaperHostScanMount[] = [];
    for (const item of mountsRaw) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const m = item as Record<string, unknown>;
      const mount = typeof m.mount === "string" ? m.mount : "";
      const usedPct = typeof m.used_pct === "number" ? m.used_pct : Number(m.used_pct ?? NaN);
      if (!mount || !Number.isFinite(usedPct)) continue;
      mounts.push({
        mount,
        used_pct: usedPct,
        ...(typeof m.avail_bytes === "number" && Number.isFinite(m.avail_bytes)
          ? { avail_bytes: m.avail_bytes }
          : {}),
        ...(typeof m.total_bytes === "number" && Number.isFinite(m.total_bytes)
          ? { total_bytes: m.total_bytes }
          : {}),
      });
    }
    return {
      ...obj,
      ...(typeof obj.host === "string" ? { host: obj.host } : {}),
      ...(typeof obj.scanned_at === "string" ? { scanned_at: obj.scanned_at } : {}),
      mounts,
    };
  } catch {
    return null;
  }
}
