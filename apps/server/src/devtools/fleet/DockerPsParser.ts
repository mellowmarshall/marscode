// @effect-diagnostics nodeBuiltinImport:off - Pure parsers for Docker ps/stats output and Linux ss TCP listener listings.
import type { FleetServerItem, FleetServerPort } from "./FleetTypes.ts";

export function parseSizeBytes(raw: string): number {
  const m = /^\s*([0-9]+(?:\.[0-9]+)?)\s*([KMGTPE]?i?B)\s*$/i.exec(raw);
  if (!m) return 0;
  const val = Number(m[1]);
  if (!Number.isFinite(val)) return 0;
  const unit = (m[2] ?? "B").toLowerCase();
  const table: Record<string, number> = {
    b: 1,
    kb: 1e3,
    kib: 1024,
    mb: 1e6,
    mib: 1024 ** 2,
    gb: 1e9,
    gib: 1024 ** 3,
    tb: 1e12,
    tib: 1024 ** 4,
  };
  return Math.round(val * (table[unit] ?? 1));
}

export function parseDockerPorts(raw: string): ReadonlyArray<FleetServerPort> {
  const seen = new Set<number>();
  const out: FleetServerPort[] = [];
  for (const part of raw.split(",")) {
    const m =
      /(?:^|[\s,])(?:127\.0\.0\.1|0\.0\.0\.0|\[::\]|::|localhost):(\d+)->(\d+)\/(tcp|udp)/.exec(
        part.trim(),
      );
    if (!m || m[3] !== "tcp") continue;
    const hostPort = Number(m[1]);
    const targetPort = Number(m[2]);
    if (!Number.isInteger(hostPort) || hostPort <= 0 || seen.has(hostPort)) continue;
    seen.add(hostPort);
    out.push({
      port: hostPort,
      ...(Number.isInteger(targetPort) && targetPort > 0 ? { to: targetPort } : {}),
      proto: "http",
      url: `http://127.0.0.1:${hostPort}`,
    });
  }
  return out;
}

export function parseDockerStatusUptime(status: string): number | undefined {
  const m = /^Up\s+(?:About\s+)?(?:an?|\d+)\s+(second|minute|hour|day|week|month)/i.exec(
    status.trim(),
  );
  if (!m) return undefined;
  const numMatch = /\d+/.exec(m[0]);
  const n = numMatch ? Number(numMatch[0]) : 1;
  const unit = (m[1] ?? "").toLowerCase();
  const mult: Record<string, number> = {
    second: 1,
    minute: 60,
    hour: 3_600,
    day: 86_400,
    week: 604_800,
    month: 2_592_000,
  };
  return n * (mult[unit] ?? 1);
}

export function parseDockerPsLines(
  psOutput: string,
  statsById: ReadonlyMap<string, { readonly cpuPct: number; readonly memBytes: number }>,
): ReadonlyArray<FleetServerItem> {
  const out: FleetServerItem[] = [];
  for (const line of psOutput.split("\n")) {
    if (!line.trim()) continue;
    const cols = line.split("\t");
    if (cols.length < 5) continue;
    const [
      id = "",
      name = "",
      rawState = "",
      status = "",
      image = "",
      composeProject = "",
      composeService = "",
      composeOneoff = "",
      workingDir = "",
      portsRaw = "",
    ] = cols;
    if (composeOneoff.toLowerCase() === "true") continue;
    const cleanName = name.replace(/^\//, "").trim();
    if (!cleanName) continue;
    const stateLower = rawState.trim().toLowerCase();
    const state = stateLower === "running" ? "up" : "stopped";
    const ports = parseDockerPorts(portsRaw);
    const primary = ports[0];
    const stat = statsById.get(id.trim()) ?? statsById.get(id.trim().slice(0, 12));
    const uptimeS = state === "up" ? parseDockerStatusUptime(status) : undefined;
    out.push({
      id: composeProject && composeService ? `${composeProject}/${composeService}` : cleanName,
      ...(composeProject ? { project: composeProject } : {}),
      service: composeService || cleanName,
      kind: composeProject ? "compose" : "container",
      ...(primary?.url ? { url: primary.url } : {}),
      ...(primary ? { port: primary.port } : {}),
      ...(ports.length > 0 ? { ports } : {}),
      state,
      managed: true,
      container: cleanName,
      ...(image ? { image } : {}),
      ...(workingDir ? { cwd: workingDir } : {}),
      ...(stat ? { cpu_pct: stat.cpuPct, mem_bytes: stat.memBytes } : {}),
      ...(uptimeS !== undefined ? { uptime_s: uptimeS } : {}),
      can_start: state !== "up",
      can_stop: state === "up",
    });
  }
  return out;
}

export function parseSsListeners(output: string): ReadonlyArray<{
  readonly port: number;
  readonly pid: number;
  readonly procName: string;
}> {
  const out: Array<{ readonly port: number; readonly pid: number; readonly procName: string }> = [];
  const seen = new Set<string>();
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const cols = trimmed.split(/\s+/);
    const localAddr = cols[3] ?? "";
    const portMatch = /:(\d+)$/.exec(localAddr);
    if (!portMatch) continue;
    const port = Number(portMatch[1]);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) continue;
    const procMatch = /users:\(\("([^"]+)",pid=(\d+)/.exec(trimmed);
    if (!procMatch) continue;
    const procName = procMatch[1] ?? "";
    const pid = Number(procMatch[2]);
    if (!Number.isInteger(pid) || pid <= 1) continue;
    const key = `${pid}:${port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ port, pid, procName });
  }
  return out;
}
