/**
 * Wire types for DevDeck `/api/snapshot` + SSE panels, Playbook declaration, and merged fleet hosts.
 */
import type { SVGProps } from "react";
import { msg } from "gt-react";

import { m } from "~/i18n/messages";

export interface DevdeckMemInfo {
  readonly used?: number;
  readonly total?: number;
}

export interface DevdeckDiskInfo {
  readonly mount?: string;
  readonly label?: string;
  readonly used?: number;
  readonly total?: number;
}

export interface DevdeckGpuInfo {
  readonly busy_pct?: number;
  readonly busy_hist?: ReadonlyArray<number>;
  readonly vram_used?: number;
  readonly vram_total?: number;
}

export interface DevdeckHostTelemetry {
  readonly name?: string;
  readonly uptime_s?: number;
  readonly load1?: number;
  readonly cpus?: number;
  readonly cpu_pct?: number;
  readonly cpu_hist?: ReadonlyArray<number>;
  readonly mem?: DevdeckMemInfo;
  readonly disks?: ReadonlyArray<DevdeckDiskInfo>;
  readonly gpu?: DevdeckGpuInfo;
  readonly ts?: string;
}

export interface DevdeckServerPort {
  readonly port?: number;
  readonly to?: number;
  readonly proto?: string;
  readonly url?: string;
}

export interface DevdeckServerItem {
  readonly id?: string;
  readonly project?: string;
  readonly service?: string;
  readonly kind?: string;
  readonly framework?: string;
  readonly url?: string;
  readonly proxy_url?: string;
  readonly port?: number;
  readonly ports?: ReadonlyArray<DevdeckServerPort>;
  readonly state?: string;
  readonly reason?: string;
  readonly managed?: boolean;
  readonly pid?: number;
  readonly container?: string;
  readonly container_source?: string;
  readonly image?: string;
  readonly dev_key?: string;
  readonly cwd?: string;
  readonly mem_bytes?: number;
  readonly cpu_pct?: number;
  readonly uptime_s?: number;
  readonly can_start?: boolean;
  readonly can_stop?: boolean;
  readonly guest?: string;
}

export interface DevdeckWorktreeItem {
  readonly path?: string;
  readonly branch?: string;
  readonly dirty?: boolean;
  readonly ahead?: number;
  readonly stale?: boolean;
  readonly merged?: boolean;
  readonly last_commit_at?: string;
}

export interface DevdeckWorktreeRepo {
  readonly repo?: string;
  readonly root?: string;
  readonly items?: ReadonlyArray<DevdeckWorktreeItem>;
}

export interface DevdeckWorktreesPanel {
  readonly total?: number;
  readonly dirty?: number;
  readonly stale?: number;
  readonly merged?: number;
  readonly stuck?: number;
  readonly repos?: ReadonlyArray<DevdeckWorktreeRepo>;
}

export interface DevdeckSessionItem {
  readonly id?: string;
  readonly guest?: string;
  readonly kind?: string;
  readonly name?: string;
  readonly project?: string;
  readonly branch?: string;
  readonly endpoint?: string;
  readonly device?: string;
  readonly age_s?: number;
  readonly idle_s?: number;
  readonly mem_bytes?: number;
  readonly cpu_pct?: number;
  readonly load?: number;
  readonly high?: boolean;
  readonly runaway?: boolean;
  readonly descendants?: number;
  readonly orphaned?: boolean;
  readonly idle?: boolean;
  readonly need?: string;
  readonly close_allowed?: boolean;
  readonly close_blocked_reason?: string;
  readonly owner?: string;
  readonly owner_state?: string;
  readonly owner_session_id?: string;
  readonly launch_owner?: string;
  readonly managed?: string;
  readonly service_unit?: string;
  readonly keep_running?: boolean;
  readonly workload_id?: string;
  readonly command?: string;
  readonly scope?: string;
  readonly pid?: number;
  readonly cwd?: string;
  readonly lease_id?: string;
}

export interface DevdeckAlertItem {
  readonly source?: string;
  readonly name?: string;
  readonly state?: string;
  readonly since?: string;
  readonly detail?: string;
  readonly url?: string;
}

export interface DevdeckAlertsPanel {
  readonly items?: ReadonlyArray<DevdeckAlertItem>;
}

export interface DevdeckNodeState {
  readonly host?: string | DevdeckHostTelemetry;
  readonly servers?: ReadonlyArray<DevdeckServerItem>;
  readonly sessions?: ReadonlyArray<DevdeckSessionItem>;
  readonly alerts?: DevdeckAlertsPanel | ReadonlyArray<DevdeckAlertItem>;
  readonly worktrees?: DevdeckWorktreesPanel | null;
  readonly status?: string;
  readonly is_local?: boolean;
  readonly ssh?: string;
  readonly note?: string;
  readonly saving?: boolean;
  readonly power_saver?: boolean;
  readonly power?: string;
  readonly away?: boolean;
  readonly error?: string;
  readonly members?: ReadonlyArray<string>;
  readonly part_status?: Readonly<Record<string, string>>;
  readonly uncollected?: ReadonlyArray<string>;
  readonly updated_at?: string;
}

export interface DevdeckToolProbe {
  readonly name: string;
  readonly range?: string;
  readonly version?: string;
  readonly state?: string;
  readonly install?: string;
}

export type DevdeckDriftEntry =
  | string
  | {
      readonly text?: string | null;
      readonly state?: string | null;
    };

export interface DevdeckHostProbeReport {
  readonly name: string;
  readonly ssh?: string | null;
  readonly reached?: boolean;
  readonly probed_at?: string | null;
  readonly platform?: string;
  readonly tools?: ReadonlyArray<DevdeckToolProbe>;
  readonly drift?: ReadonlyArray<DevdeckDriftEntry>;
  readonly notes?: ReadonlyArray<DevdeckDriftEntry>;
  readonly ci_off?: boolean;
  readonly ci_off_at?: string | null;
  readonly ci_off_by?: string | null;
  readonly ci_off_reason?: string | null;
  readonly ci_off_version?: string | null;
  readonly no_grant?: boolean | ReadonlyArray<unknown>;
  readonly grant_error?: string | null;
}

export interface DevdeckHostsPanel {
  readonly report?: {
    readonly at?: string;
    readonly hosts?: ReadonlyArray<DevdeckHostProbeReport>;
  } | null;
  readonly running?: string;
  readonly error?: string;
}

export interface DevdeckShipCiTurn {
  readonly repo?: string;
  readonly holder?: string;
  readonly waiting?: ReadonlyArray<string> | number;
}

export interface DevdeckShipHostCheck {
  readonly name: string;
  readonly where?: string;
  readonly state?: string;
  readonly drift?: ReadonlyArray<DevdeckDriftEntry>;
  readonly notes?: ReadonlyArray<DevdeckDriftEntry>;
}

export interface DevdeckShipDepEntry {
  readonly repo?: string;
  readonly report?: string;
  readonly status?: string;
  readonly scanned?: number;
  readonly pending?: number;
  readonly waiting?: number;
  readonly held?: number;
  readonly failed?: number;
  readonly attempt?: string;
  readonly decision?: string;
  readonly active?: boolean;
  readonly holding?: boolean;
}

export interface DevdeckShipJobSummary {
  readonly id?: string;
  readonly repo?: string;
  readonly branch?: string;
  readonly title?: string;
  readonly state?: string;
  readonly stage?: string;
  readonly pr?: string;
  readonly reason?: string;
  readonly cleared?: string;
  readonly host?: string;
  readonly started_at?: string;
  readonly updated_at?: string;
  readonly finished_at?: string;
  readonly duration_s?: number;
}

export interface DevdeckShipPanel {
  readonly daemon_up?: boolean;
  readonly jobs?: ReadonlyArray<DevdeckShipJobSummary>;
  readonly ci?: ReadonlyArray<DevdeckShipCiTurn>;
  readonly hosts?: {
    readonly at?: string;
    readonly exit?: number;
    readonly hosts?: ReadonlyArray<DevdeckShipHostCheck>;
    readonly notes?: ReadonlyArray<string>;
    readonly stale?: boolean;
  } | null;
  readonly deps?: ReadonlyArray<DevdeckShipDepEntry>;
}

export interface FleetHostProblem {
  readonly kind: "offline" | "needs-root" | "sync-error";
  readonly tone: "bad" | "warn";
  readonly label: string;
  readonly details: ReadonlyArray<string>;
}

export interface MergedFleetHost {
  readonly id: string;
  readonly shortName: string;
  readonly probeHostName: string | null;
  readonly isLocal: boolean;
  readonly hasDevdeckNode: boolean;
  readonly status: "online" | "offline" | "degraded";
  readonly problem: FleetHostProblem | null;
  readonly platform: string;
  readonly ssh: string | null;
  readonly note: string | null;
  readonly telemetry: DevdeckHostTelemetry | null;
  readonly power: string | null;
  readonly powerSaver: boolean;
  readonly members: ReadonlyArray<string>;
  readonly probe: DevdeckHostProbeReport | null;
  readonly ciOff: boolean;
  readonly ciOffReason: string | null;
  readonly drift: ReadonlyArray<string>;
  readonly notes: ReadonlyArray<string>;
  readonly servers: ReadonlyArray<DevdeckServerItem>;
  readonly sessions: ReadonlyArray<DevdeckSessionItem>;
  readonly alerts: ReadonlyArray<DevdeckAlertItem>;
  readonly worktrees: DevdeckWorktreesPanel | null;
  readonly error: string | null;
}

export interface DeclaredContractSummary {
  readonly name: string;
  readonly gate: string;
  readonly evidencePath: string | null;
  readonly exceptionCount: number;
  readonly status: "enforced" | "waived";
  readonly waivedReason: string | null;
}

export interface PlaybookRuleSection {
  readonly section: number;
  readonly title: string;
  readonly status: "enforced" | "waived" | "not-declared";
  readonly detail: string | null;
}

export interface NormalizedWaiver {
  readonly repo: string;
  readonly scope: "guards" | "playbook";
  readonly key: string;
  readonly reason: string;
  readonly date: string | null;
  readonly issueRef: string | null;
}

export interface PlaybookDeclarationPayload {
  readonly repoDir: string;
  readonly repoName: string;
  readonly hasPlaybookJson: boolean;
  readonly guardsExempt: NormalizedWaiver | null;
  readonly contracts: ReadonlyArray<DeclaredContractSummary>;
  readonly rules: ReadonlyArray<PlaybookRuleSection>;
  readonly playbookMdPath: string | null;
}

export type IconSvgProps = SVGProps<SVGSVGElement>;

function asTelemetry(host: string | DevdeckHostTelemetry | undefined): DevdeckHostTelemetry | null {
  if (!host || typeof host === "string") return null;
  return host;
}

function normalizeAlertList(
  raw: DevdeckAlertsPanel | ReadonlyArray<DevdeckAlertItem> | undefined,
): ReadonlyArray<DevdeckAlertItem> {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  return Array.isArray((raw as DevdeckAlertsPanel).items)
    ? ((raw as DevdeckAlertsPanel).items ?? [])
    : [];
}

export interface AggregatedFleetAlert {
  readonly key: string;
  readonly hostShort: string;
  readonly alert: DevdeckAlertItem;
}

function alertPriority(state: string | undefined): number {
  const s = (state ?? "").toLowerCase();
  if (s === "firing" || s === "alert" || s === "error" || s === "down") return 0;
  if (s === "silent" || s === "muted" || s === "warn" || s === "pending") return 1;
  return 2;
}

export function isAlertFiring(state: string | undefined): boolean {
  return alertPriority(state) === 0;
}

function resolveAlertHostShort(
  alert: DevdeckAlertItem,
  fallbackShort: string,
  hosts: ReadonlyArray<MergedFleetHost>,
): string {
  const name = (alert.name ?? "").trim();
  const colonIdx = name.indexOf(":");
  if (colonIdx > 0) {
    const prefix = name.slice(0, colonIdx).toLowerCase();
    for (const h of hosts) {
      if (
        h.id.toLowerCase() === prefix ||
        h.shortName.toLowerCase() === prefix ||
        h.probeHostName?.toLowerCase() === prefix ||
        h.members.some((member) => member.toLowerCase() === prefix)
      ) {
        return h.shortName;
      }
    }
  }
  return fallbackShort;
}

/**
 * Deduplicates alerts across local and remote DevDeck hosts while preserving distinct
 * same-name alerts (such as multiple port collisions with different `detail` strings)
 * and attributing host-prefixed alerts (e.g. `host-b:/`) to the owning host.
 */
export function aggregateFleetAlerts(
  hosts: ReadonlyArray<MergedFleetHost>,
): ReadonlyArray<AggregatedFleetAlert> {
  const seen = new Map<string, number>();
  const out: AggregatedFleetAlert[] = [];
  // Process remote hosts first so remote-owned alerts keep their true host when mirrored locally.
  const ordered = [...hosts.filter((h) => !h.isLocal), ...hosts.filter((h) => h.isLocal)];
  for (const host of ordered) {
    for (const alert of host.alerts) {
      const dedupeKey = [
        (alert.source ?? "").trim(),
        (alert.name ?? "").trim(),
        (alert.state ?? "").trim().toLowerCase(),
        (alert.detail ?? "").trim(),
      ].join("\0");
      if (seen.has(dedupeKey)) continue;
      seen.set(dedupeKey, out.length);
      out.push({
        key: dedupeKey,
        hostShort: resolveAlertHostShort(alert, host.shortName, hosts),
        alert,
      });
    }
  }
  return out;
}

function extractDriftText(item: unknown): string {
  if (typeof item === "string") return item.trim();
  if (item && typeof item === "object") {
    const obj = item as { readonly text?: unknown; readonly message?: unknown };
    if (typeof obj.text === "string") return obj.text.trim();
    if (typeof obj.message === "string") return obj.message.trim();
  }
  return "";
}

function dedupeStrings(items: ReadonlyArray<unknown>): ReadonlyArray<string> {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const trimmed = extractDriftText(item);
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

const SYNC_FAILURE_RE =
  /(?<![A-Za-z0-9-])(failed|errors?|unreachable|needs-admin|permission denied|timed out|exited [1-9]\d*|refused|corrupt)(?![A-Za-z0-9-])/i;

function extractDriftState(item: DevdeckDriftEntry): string {
  if (typeof item === "string") return "";
  return (item.state ?? "").trim().toLowerCase();
}

function classifyHostProblem(input: {
  readonly isOffline: boolean;
  readonly error: string | null;
  readonly probe: DevdeckHostProbeReport | null;
  readonly driftEntries: ReadonlyArray<DevdeckDriftEntry>;
}): FleetHostProblem | null {
  if (input.isOffline) {
    const details = dedupeStrings([
      ...(input.error ? [input.error] : []),
      ...(input.probe?.reached === false ? [m(msg("Host unreachable during last probe"))] : []),
    ]);
    return {
      kind: "offline",
      tone: "bad",
      label: m(msg("Offline")),
      details: details.length > 0 ? details : [m(msg("Machine is currently unreachable"))],
    };
  }

  const syncErrorLines: string[] = [];
  const needsRootDriftLines: string[] = [];
  for (const entry of input.driftEntries) {
    const text = extractDriftText(entry);
    if (!text) continue;
    const state = extractDriftState(entry);
    if (state === "error" || state === "failed" || state === "unreachable") {
      syncErrorLines.push(text);
    } else if (state === "needs-root" || state === "needs-admin") {
      needsRootDriftLines.push(text);
    } else if (SYNC_FAILURE_RE.test(text)) {
      syncErrorLines.push(text);
    }
  }

  // Higher-severity red sync errors take precedence over yellow needs-root warnings.
  const dedupedSyncErrors = dedupeStrings(syncErrorLines);
  if (dedupedSyncErrors.length > 0) {
    return {
      kind: "sync-error",
      tone: "bad",
      label: m(msg("Sync error")),
      details: dedupedSyncErrors,
    };
  }

  const grantError = input.probe?.grant_error?.trim() ?? "";
  const noGrantItems = Array.isArray(input.probe?.no_grant)
    ? input.probe.no_grant.map(extractDriftText).filter(Boolean)
    : [];
  const hasNeedsRoot =
    Boolean(grantError) ||
    input.probe?.no_grant === true ||
    noGrantItems.length > 0 ||
    needsRootDriftLines.length > 0;
  if (hasNeedsRoot) {
    const details = dedupeStrings([
      ...(grantError ? [grantError] : []),
      ...noGrantItems,
      ...needsRootDriftLines,
    ]);
    return {
      kind: "needs-root",
      tone: "warn",
      label: m(msg("Needs root")),
      details:
        details.length > 0
          ? details
          : [m(msg("Host provisioning requires a root grant from the owner"))],
    };
  }

  // Routine syncable drift is handled by fleet auto-sync and does not raise an alarm on the machine card.
  return null;
}

/**
 * Joins local host telemetry, DevDeck remote `nodes`, `hosts.report.hosts` (CI probes),
 * and `ship.hosts` drift/notes via exact name or `node.members` (e.g. a laptop and its Linux VM: host-d ↔ host-d-linux).
 */
export function mergeFleetHosts(input: {
  readonly localHost: DevdeckHostTelemetry | null;
  readonly localServers: ReadonlyArray<DevdeckServerItem>;
  readonly localSessions: ReadonlyArray<DevdeckSessionItem>;
  readonly localAlerts: ReadonlyArray<DevdeckAlertItem>;
  readonly localWorktrees?: DevdeckWorktreesPanel | null;
  readonly nodes: Readonly<Record<string, DevdeckNodeState>>;
  readonly hostsReport: DevdeckHostsPanel | null;
  readonly shipPanel: DevdeckShipPanel | null;
}): ReadonlyArray<MergedFleetHost> {
  const probeByName = new Map<string, DevdeckHostProbeReport>();
  for (const h of input.hostsReport?.report?.hosts ?? []) {
    if (h?.name) probeByName.set(h.name, h);
  }
  const shipHostByName = new Map<string, DevdeckShipHostCheck>();
  for (const sh of input.shipPanel?.hosts?.hosts ?? []) {
    if (sh?.name) shipHostByName.set(sh.name, sh);
  }

  const consumedProbes = new Set<string>();
  const result: MergedFleetHost[] = [];

  const findLinkedProbe = (
    name: string,
    members: ReadonlyArray<string>,
  ): {
    readonly probe: DevdeckHostProbeReport | null;
    readonly shipHost: DevdeckShipHostCheck | null;
  } => {
    const candidates = [name, ...members];
    let probe: DevdeckHostProbeReport | null = null;
    let shipHost: DevdeckShipHostCheck | null = null;
    for (const c of candidates) {
      if (!probe && probeByName.has(c)) {
        probe = probeByName.get(c) ?? null;
        consumedProbes.add(c);
      }
      if (!shipHost && shipHostByName.has(c)) {
        shipHost = shipHostByName.get(c) ?? null;
      }
    }
    return { probe, shipHost };
  };

  // 1. Local host first (always present when DevDeck reports `host` or a local probe exists)
  const localName =
    input.localHost?.name ?? [...probeByName.values()].find((h) => h.ssh === null)?.name ?? null;
  if (localName) {
    const localNode = input.nodes[localName];
    const members = localNode?.members ?? [];
    const { probe, shipHost } = findLinkedProbe(localName, members);
    const driftEntries: ReadonlyArray<DevdeckDriftEntry> = [
      ...(probe?.drift ?? []),
      ...(shipHost?.drift ?? []),
    ];
    const drift = dedupeStrings(driftEntries);
    const notes = dedupeStrings([...(probe?.notes ?? []), ...(shipHost?.notes ?? [])]);
    const localError = localNode?.error ?? null;
    const problem = classifyHostProblem({
      isOffline: Boolean(localError),
      error: localError,
      probe,
      driftEntries,
    });
    result.push({
      id: localName,
      shortName: localName,
      probeHostName: probe?.name ?? null,
      isLocal: true,
      hasDevdeckNode: Boolean(localNode),
      status: problem?.kind === "offline" ? "offline" : problem ? "degraded" : "online",
      problem,
      platform: probe?.platform ?? "linux",
      ssh: null,
      note: localNode?.note ?? null,
      telemetry: input.localHost ?? asTelemetry(localNode?.host),
      power: localNode?.power ?? null,
      powerSaver: Boolean(localNode?.saving || localNode?.power_saver),
      members,
      probe,
      ciOff: Boolean(probe?.ci_off),
      ciOffReason: probe?.ci_off_reason ?? null,
      drift,
      notes,
      servers: input.localServers,
      sessions: input.localSessions,
      alerts: input.localAlerts,
      worktrees: input.localWorktrees ?? localNode?.worktrees ?? null,
      error: localNode?.error ?? null,
    });
  }

  // 2. Remote DevDeck nodes
  for (const [nodeKey, node] of Object.entries(input.nodes)) {
    if (localName && nodeKey === localName) continue;
    const members = node.members ?? [];
    const { probe, shipHost } = findLinkedProbe(nodeKey, members);
    const driftEntries: ReadonlyArray<DevdeckDriftEntry> = [
      ...(probe?.drift ?? []),
      ...(shipHost?.drift ?? []),
    ];
    const drift = dedupeStrings(driftEntries);
    const notes = dedupeStrings([...(probe?.notes ?? []), ...(shipHost?.notes ?? [])]);
    const rawStatus = (node.status ?? "").toLowerCase();
    const isOffline =
      rawStatus === "offline" ||
      rawStatus === "down" ||
      Boolean(node.error) ||
      (probe !== null && probe.reached === false);
    const problem = classifyHostProblem({
      isOffline,
      error: node.error ?? null,
      probe,
      driftEntries,
    });
    const status: MergedFleetHost["status"] = isOffline
      ? "offline"
      : problem !== null
        ? "degraded"
        : "online";
    result.push({
      id: nodeKey,
      shortName: nodeKey,
      probeHostName: probe?.name ?? null,
      isLocal: Boolean(node.is_local),
      hasDevdeckNode: true,
      status,
      problem,
      platform: probe?.platform ?? (members.length > 1 ? "darwin + linux" : "linux"),
      ssh: node.ssh ?? probe?.ssh ?? shipHost?.where ?? null,
      note: node.note ?? null,
      telemetry: asTelemetry(node.host),
      power: node.power ?? null,
      powerSaver: Boolean(node.saving || node.power_saver),
      members,
      probe,
      ciOff: Boolean(probe?.ci_off),
      ciOffReason: probe?.ci_off_reason ?? null,
      drift,
      notes,
      servers: Array.isArray(node.servers) ? node.servers : [],
      sessions: Array.isArray(node.sessions) ? node.sessions : [],
      alerts: normalizeAlertList(node.alerts),
      worktrees: node.worktrees ?? null,
      error: node.error ?? null,
    });
  }

  // 3. Any probe-only hosts not represented by a DevDeck node
  for (const [name, probe] of probeByName.entries()) {
    if (consumedProbes.has(name)) continue;
    // A manifest row the server lists before any hosts check only carries CI state for a node.
    if (probe.reached === undefined) continue;
    const shipHost = shipHostByName.get(name) ?? null;
    const driftEntries: ReadonlyArray<DevdeckDriftEntry> = [
      ...(probe.drift ?? []),
      ...(shipHost?.drift ?? []),
    ];
    const drift = dedupeStrings(driftEntries);
    const notes = dedupeStrings([...(probe.notes ?? []), ...(shipHost?.notes ?? [])]);
    const probeOffline = probe.reached === false;
    const probeError = probeOffline ? m(msg("Host unreachable during last probe")) : null;
    const problem = classifyHostProblem({
      isOffline: probeOffline,
      error: probeError,
      probe,
      driftEntries,
    });
    result.push({
      id: name,
      shortName: name,
      probeHostName: name,
      isLocal: probe.ssh === null,
      hasDevdeckNode: false,
      status: probeOffline ? "offline" : problem !== null ? "degraded" : "online",
      problem,
      platform: probe.platform ?? "linux",
      ssh: probe.ssh ?? shipHost?.where ?? null,
      note: null,
      telemetry: null,
      power: null,
      powerSaver: false,
      members: [],
      probe,
      ciOff: Boolean(probe.ci_off),
      ciOffReason: probe.ci_off_reason ?? null,
      drift,
      notes,
      servers: [],
      sessions: [],
      alerts: [],
      worktrees: null,
      error: probe.reached === false ? m(msg("Host unreachable during last probe")) : null,
    });
  }

  return result;
}
