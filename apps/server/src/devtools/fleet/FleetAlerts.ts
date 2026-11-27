// @effect-diagnostics nodeBuiltinImport:off - Native fleet "alerts" panel: port collisions and the host-guards GitHub audit report.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type {
  FleetAlertItem,
  FleetAlertState,
  FleetAlertsPanel,
  FleetPortListener,
  FleetServerItem,
} from "./FleetTypes.ts";

const AUDIT_SOURCE = "GitHub audit";
const AUDIT_STALE_AFTER_MS = (2 * 60 + 15) * 60_000;
const AUDIT_FUTURE_SKEW_MS = 5 * 60_000;
const AUDIT_SETTLED_STATES = new Set(["verified", "exempt", "folded", "history"]);
/** The report is read on the event loop each snapshot; larger files are refused. */
const AUDIT_MAX_BYTES = 2 * 1024 * 1024;
// O_NONBLOCK keeps open() from waiting on a FIFO's writer; O_NOFOLLOW refuses a symlink.
const AUDIT_OPEN_FLAGS =
  NodeFS.constants.O_RDONLY |
  (NodeFS.constants.O_NOFOLLOW ?? 0) |
  (NodeFS.constants.O_NONBLOCK ?? 0);

type AuditFileRead =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly detail: string };

/** Reads a regular, non-symlink file of at most `maxBytes`; anything else is refused. */
function readBoundedRegularFile(path: string, maxBytes: number): AuditFileRead {
  let fd: number;
  try {
    fd = NodeFS.openSync(path, AUDIT_OPEN_FLAGS);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "ELOOP" || code === "EMLINK"
      ? { ok: false, detail: "Audit report is not a regular file" }
      : { ok: false, detail: "No readable audit report" };
  }
  try {
    const stat = NodeFS.fstatSync(fd);
    if (!stat.isFile()) return { ok: false, detail: "Audit report is not a regular file" };
    if (stat.size > maxBytes) return { ok: false, detail: "Audit report is too large" };
    // Read one byte past the cap so a file that grew after fstat is still refused.
    const buf = Buffer.alloc(maxBytes + 1);
    let total = 0;
    for (;;) {
      const n = NodeFS.readSync(fd, buf, total, buf.length - total, null);
      if (n === 0) break;
      total += n;
      if (total > maxBytes) return { ok: false, detail: "Audit report is too large" };
    }
    return { ok: true, text: buf.toString("utf8", 0, total) };
  } catch {
    return { ok: false, detail: "No readable audit report" };
  } finally {
    NodeFS.closeSync(fd);
  }
}

export function defaultGitHubAuditPath(): string {
  return NodePath.join(
    NodeOS.homedir(),
    ".local",
    "state",
    "host-guards",
    "github-audit",
    "report.json",
  );
}

function serverLabel(srv: FleetServerItem): string {
  if (srv.container) return `container ${srv.container}`;
  const name = srv.service ?? srv.id;
  return srv.pid ? `${name} (PID ${srv.pid})` : name;
}

function serverOwnerKey(srv: FleetServerItem): string {
  if (srv.container) return `container:${srv.container}`;
  if (srv.pid) return `pid:${srv.pid}`;
  return `id:${srv.id}`;
}

function serverHostPorts(srv: FleetServerItem): ReadonlySet<number> {
  const ports = new Set<number>();
  if (srv.port !== undefined) ports.add(srv.port);
  for (const p of srv.ports ?? []) ports.add(p.port);
  return ports;
}

/**
 * Port collisions on this host: one port bound by two running servers, or a host
 * process listening on a port that a running container publishes (the container
 * silently loses or steals that traffic).
 */
export function detectPortCollisions(
  servers: ReadonlyArray<FleetServerItem>,
  shadows: ReadonlyArray<FleetPortListener>,
): ReadonlyArray<FleetAlertItem> {
  const owners = new Map<number, Map<string, string>>();
  for (const srv of servers) {
    if (srv.state !== "up") continue;
    for (const port of serverHostPorts(srv)) {
      const byOwner = owners.get(port) ?? new Map<string, string>();
      byOwner.set(serverOwnerKey(srv), serverLabel(srv));
      owners.set(port, byOwner);
    }
  }

  const items: FleetAlertItem[] = [];
  for (const port of [...owners.keys()].toSorted((a, b) => a - b)) {
    const labels = [...owners.get(port)!.values()];
    if (labels.length < 2) continue;
    items.push({
      source: "local",
      name: "port collision",
      state: "firing",
      detail: `port ${port} is bound by ${labels.join(" and ")}`,
    });
  }
  const seenShadow = new Set<string>();
  for (const shadow of shadows.toSorted((a, b) => a.port - b.port || a.pid - b.pid)) {
    const key = `${shadow.port}:${shadow.pid}`;
    if (seenShadow.has(key)) continue;
    seenShadow.add(key);
    const publishers = [...(owners.get(shadow.port)?.values() ?? [])];
    const publisher = publishers.length > 0 ? publishers.join(" and ") : "a container";
    items.push({
      source: "local",
      name: "port collision",
      state: "firing",
      detail: `port ${shadow.port} is published by ${publisher} and also held by ${shadow.procName} (PID ${shadow.pid})`,
    });
  }
  if (items.length === 0) {
    return [
      {
        source: "local",
        name: "port collisions",
        state: "ok",
        detail: `${owners.size} host ports checked`,
      },
    ];
  }
  return items;
}

interface AuditFinding {
  readonly repo: string;
  readonly number: number;
  readonly state: string;
  readonly detail: string;
  readonly stale: boolean;
}

function asRecord(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

function str(raw: unknown): string {
  return typeof raw === "string" ? raw : "";
}

function parseFinding(raw: unknown): AuditFinding {
  const rec = asRecord(raw);
  return {
    repo: str(rec.repo),
    number: typeof rec.number === "number" ? rec.number : 0,
    state: str(rec.state),
    detail: str(rec.detail),
    stale: rec.stale === true,
  };
}

/**
 * Reads the host-guards GitHub audit report. Missing, invalid, incomplete, or stale
 * evidence never yields an all-ok panel.
 */
export function readGitHubAuditAlerts(
  auditPath: string,
  nowMs: number,
): ReadonlyArray<FleetAlertItem> {
  const missing: FleetAlertItem = {
    source: AUDIT_SOURCE,
    name: "Audit coverage",
    state: "silent",
    detail: "No readable audit report",
  };
  const file = readBoundedRegularFile(auditPath, AUDIT_MAX_BYTES);
  if (!file.ok) return [{ ...missing, detail: file.detail }];
  let parsed: unknown;
  try {
    parsed = JSON.parse(file.text);
  } catch {
    return [{ ...missing, detail: "Audit report is invalid" }];
  }
  const report = asRecord(parsed);
  if (report.schema !== 1) {
    return [{ ...missing, detail: "Audit report is invalid" }];
  }
  const at = str(report.at);
  const atMs = Date.parse(at);
  const stale =
    !Number.isFinite(atMs) ||
    nowMs - atMs > AUDIT_STALE_AFTER_MS ||
    atMs > nowMs + AUDIT_FUTURE_SKEW_MS;
  const pending = typeof report.pending === "number" ? report.pending : 0;
  const repos = Array.isArray(report.repos) ? report.repos : [];
  const errors = Array.isArray(report.errors) ? report.errors.map(str).filter(Boolean) : [];
  const reportState = str(report.state);

  let detail = `${pending} checks pending; ${repos.length} repositories; ${str(report.scope)}`;
  if (errors.length > 0) detail += `; ${errors[0]}`;
  const coverageOk =
    !stale &&
    repos.length > 0 &&
    errors.length === 0 &&
    pending === 0 &&
    (reportState === "ok" || reportState === "findings");
  const items: FleetAlertItem[] = [
    {
      source: AUDIT_SOURCE,
      name: "Audit coverage",
      state: coverageOk ? "ok" : "silent",
      since: at,
      detail: stale ? `Stale audit: ${detail}` : detail,
    },
  ];

  const installation = parseFinding(report.installation);
  const installState: FleetAlertState = stale
    ? "silent"
    : installation.state === "verified"
      ? "ok"
      : installation.state === "drift"
        ? "firing"
        : "silent";
  items.push({
    source: AUDIT_SOURCE,
    name: "Installed gh shim",
    state: installState,
    since: at,
    detail: installation.detail,
  });

  const byRepo = new Map<string, { unverified: number; stale: number; firstNumber: number }>();
  const issues = Array.isArray(report.issues) ? report.issues.map(parseFinding) : [];
  for (const issue of issues) {
    if (AUDIT_SETTLED_STATES.has(issue.state) || issue.detail === "Evidence check pending") {
      continue;
    }
    const tally = byRepo.get(issue.repo) ?? { unverified: 0, stale: 0, firstNumber: 0 };
    if (!stale && !issue.stale && issue.state === "unverified") {
      if (tally.unverified === 0) tally.firstNumber = issue.number;
      tally.unverified += 1;
    } else {
      tally.stale += 1;
    }
    byRepo.set(issue.repo, tally);
  }
  for (const repo of [...byRepo.keys()].toSorted()) {
    const tally = byRepo.get(repo)!;
    items.push({
      source: AUDIT_SOURCE,
      name: repo,
      state: tally.unverified > 0 ? "firing" : "silent",
      since: at,
      detail:
        tally.unverified > 0
          ? `${tally.unverified} closed issues without landing evidence (e.g. #${tally.firstNumber})`
          : `${tally.stale} closed issues not checked or check failed`,
      url: `https://github.com/${repo}/issues?q=is%3Aissue+is%3Aclosed+reason%3Acompleted`,
    });
  }
  return items;
}

export function buildFleetAlertsPanel(input: {
  readonly servers: ReadonlyArray<FleetServerItem>;
  readonly portShadows: ReadonlyArray<FleetPortListener>;
  readonly githubAuditPath: string;
  readonly nowMs: number;
}): FleetAlertsPanel {
  return {
    items: [
      ...detectPortCollisions(input.servers, input.portShadows),
      ...readGitHubAuditAlerts(input.githubAuditPath, input.nowMs),
    ],
  };
}
