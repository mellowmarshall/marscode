// @effect-diagnostics nodeBuiltinImport:off - Pure wire-type definitions shared by T3 native fleet collectors.
/**
 * Wire types compatible with DevDeck `/api/snapshot`, `/api/nodes`, SSE panels,
 * and `ship-queue/sq_route.py` (`SHIP_QUEUE_NODES`).
 */

export const NODE_HIST_LEN = 300;

export interface FleetMemInfo {
  readonly used: number;
  readonly total: number;
}

export interface FleetDiskInfo {
  readonly mount: string;
  readonly label: string;
  readonly used: number;
  readonly total: number;
}

export interface FleetGpuInfo {
  readonly busy_pct?: number | undefined;
  readonly busy_hist?: ReadonlyArray<number> | undefined;
  readonly vram_used: number;
  readonly vram_total: number;
}

export interface FleetHostTelemetry {
  readonly name: string;
  readonly uptime_s: number;
  readonly load1?: number | undefined;
  readonly cpus: number;
  readonly cpu_pct?: number | undefined;
  readonly cpu_hist: ReadonlyArray<number>;
  readonly mem: FleetMemInfo;
  readonly disks: ReadonlyArray<FleetDiskInfo>;
  readonly gpu?: FleetGpuInfo | undefined;
  readonly ts: string;
}

export interface FleetServerPort {
  readonly port: number;
  readonly to?: number | undefined;
  readonly proto?: string | undefined;
  readonly url?: string | undefined;
}

export interface FleetServerItem {
  readonly id: string;
  readonly project?: string | undefined;
  readonly service?: string | undefined;
  readonly kind: string;
  readonly framework?: string | undefined;
  readonly url?: string | undefined;
  readonly proxy_url?: string | undefined;
  readonly port?: number | undefined;
  readonly ports?: ReadonlyArray<FleetServerPort> | undefined;
  readonly state: string;
  readonly reason?: string | undefined;
  readonly managed?: boolean | undefined;
  readonly pid?: number | undefined;
  readonly container?: string | undefined;
  readonly image?: string | undefined;
  readonly dev_key?: string | undefined;
  readonly cwd?: string | undefined;
  readonly mem_bytes?: number | undefined;
  readonly cpu_pct?: number | undefined;
  readonly uptime_s?: number | undefined;
  readonly can_start?: boolean | undefined;
  readonly can_stop?: boolean | undefined;
}

export interface FleetSessionItem {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly project?: string | undefined;
  readonly age_s?: number | undefined;
  readonly mem_bytes?: number | undefined;
  readonly cpu_pct?: number | undefined;
  readonly high?: boolean | undefined;
  readonly runaway?: boolean | undefined;
  readonly orphaned?: boolean | undefined;
  readonly close_allowed: boolean;
  readonly close_blocked_reason?: string | undefined;
  readonly managed?: string | undefined;
  readonly command?: string | undefined;
  readonly pid?: number | undefined;
  readonly cwd?: string | undefined;
}

export interface FleetNodeState {
  readonly host: FleetHostTelemetry;
  readonly servers?: ReadonlyArray<FleetServerItem> | undefined;
  readonly sessions?: ReadonlyArray<FleetSessionItem> | undefined;
  readonly status: "up" | "offline" | "degraded";
  readonly is_local?: boolean | undefined;
  readonly ssh?: string | undefined;
  readonly note?: string | undefined;
  readonly power?: "ac" | "battery" | undefined;
  readonly power_saver?: boolean | undefined;
  readonly error?: string | undefined;
  readonly members?: ReadonlyArray<string> | undefined;
  readonly updated_at: string;
}

export interface FleetHostsReport {
  readonly schema: number;
  readonly at: string;
  readonly manifest?: string | undefined;
  readonly hosts: ReadonlyArray<Record<string, unknown>>;
  readonly settings?: ReadonlyArray<unknown> | undefined;
}

export interface FleetHostsPanel {
  readonly report: FleetHostsReport | null;
  readonly running?: string | undefined;
  readonly error?: string | undefined;
}

export interface FleetAction {
  readonly id: string;
  readonly kind: string;
  readonly target: string;
  readonly state: "running" | "ok" | "failed";
  readonly message: string;
  readonly at: string;
}

export interface FleetSnapshot {
  readonly host: FleetHostTelemetry;
  readonly servers: ReadonlyArray<FleetServerItem>;
  readonly sessions: ReadonlyArray<FleetSessionItem>;
  readonly nodes: Readonly<Record<string, FleetNodeState>>;
  readonly hosts: FleetHostsPanel;
  readonly alerts: { readonly items: ReadonlyArray<never> };
  readonly worktrees: null;
  readonly usage: null;
}

export interface CiHostManifestEntry {
  readonly name: string;
  readonly ssh: string | null;
  readonly note?: string | undefined;
  readonly data_root?: string | undefined;
  readonly on?: string | undefined;
  readonly role?: string | undefined;
}

export type FleetPowerState = {
  readonly power?: "ac" | "battery" | undefined;
  readonly powerSaver?: boolean | undefined;
};
