// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Native local Docker + listening dev server scanner and controller (no DevDeck daemon needed).
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { parseDockerPsLines, parseSizeBytes, parseSsListeners } from "./DockerPsParser.ts";
import type { FleetServerItem } from "./FleetTypes.ts";

const DOCKER_PS_TIMEOUT_MS = 4_000;
const DOCKER_STATS_TIMEOUT_MS = 4_000;
const DOCKER_STATS_CACHE_MS = 10_000;
const DOCKER_CTL_TIMEOUT_MS = 20_000;
const SOCKET_SCAN_TIMEOUT_MS = 2_000;
const SAFE_CONTAINER_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

const IGNORED_DEV_PROCS = new Set([
  "sshd",
  "systemd",
  "systemd-resolved",
  "docker-proxy",
  "dockerd",
  "containerd",
  "rootlesskit",
  "slirp4netns",
  "dbus-daemon",
  "pipewire",
  "pulseaudio",
  "cupsd",
  "avahi-daemon",
  "tailscaled",
  "t3code",
  "t3-resource-monitor",
  "electron",
  "antigravity",
  "postgres",
  "mysqld",
  "redis-server",
  "chrome",
  "chromium",
  "firefox",
]);

function execFileSafe(
  bin: string,
  args: ReadonlyArray<string>,
  timeoutMs: number,
): Promise<{ readonly ok: boolean; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve) => {
    NodeChildProcess.execFile(
      bin,
      args,
      { timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          stdout: stdout ?? "",
          stderr: stderr ?? (err ? err.message : ""),
        });
      },
    );
  });
}

export async function readLinuxProcStartTicks(
  pid: number,
  platform: NodeJS.Platform,
): Promise<string | null> {
  if (platform !== "linux") return null;
  try {
    const stat = await NodeFSP.readFile(`/proc/${pid}/stat`, "utf8");
    const closeParen = stat.lastIndexOf(")");
    if (closeParen === -1) return null;
    const fields = stat
      .slice(closeParen + 2)
      .trim()
      .split(/\s+/);
    // field index 19 after comm is field 22 (starttime in clock ticks since boot)
    return fields[19] ?? null;
  } catch {
    return null;
  }
}

export async function collectProtectedSelfPids(
  platform: NodeJS.Platform = "linux",
): Promise<ReadonlySet<number>> {
  const protectedPids = new Set<number>([process.pid]);
  if (process.ppid > 1) protectedPids.add(process.ppid);

  // Walk full ancestor chain so neither T3 server nor Electron/AppImage can ever be targeted.
  let cur = process.ppid;
  for (let depth = 0; depth < 32 && cur > 1; depth += 1) {
    protectedPids.add(cur);
    let ppid = 0;
    if (platform === "linux") {
      try {
        const stat = await NodeFSP.readFile(`/proc/${cur}/stat`, "utf8");
        const closeParen = stat.lastIndexOf(")");
        if (closeParen === -1) break;
        const fields = stat
          .slice(closeParen + 2)
          .trim()
          .split(/\s+/);
        ppid = Number(fields[1]);
      } catch {
        break;
      }
    } else if (platform === "darwin") {
      const res = await execFileSafe("ps", ["-o", "ppid=", "-p", String(cur)], 1_000);
      if (!res.ok) break;
      ppid = Number(res.stdout.trim());
    } else {
      break;
    }
    if (!Number.isInteger(ppid) || ppid <= 1 || protectedPids.has(ppid)) break;
    cur = ppid;
  }
  return protectedPids;
}

async function readLinuxProcessMeta(pid: number): Promise<{
  readonly uid: number | null;
  readonly cmdline: string;
  readonly cwd: string | undefined;
  readonly memBytes: number;
} | null> {
  try {
    const [statusRaw, cmdRaw, statmRaw, cwd] = await Promise.all([
      NodeFSP.readFile(`/proc/${pid}/status`, "utf8").catch(() => ""),
      NodeFSP.readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => ""),
      NodeFSP.readFile(`/proc/${pid}/statm`, "utf8").catch(() => ""),
      NodeFSP.readlink(`/proc/${pid}/cwd`).catch(() => undefined),
    ]);
    const uidMatch = /^Uid:\s+(\d+)/m.exec(statusRaw);
    const uid = uidMatch ? Number(uidMatch[1]) : null;
    const cmdline = cmdRaw.replace(/\0+/g, " ").trim();
    const rssPages = Number(statmRaw.trim().split(/\s+/)[1] ?? "0");
    const memBytes = Number.isFinite(rssPages) && rssPages > 0 ? rssPages * 4096 : 0;
    return { uid, cmdline, cwd, memBytes };
  } catch {
    return null;
  }
}

export class NativeServersScanner {
  private readonly platform: NodeJS.Platform;
  private statsCache: {
    readonly at: number;
    readonly map: ReadonlyMap<string, { readonly cpuPct: number; readonly memBytes: number }>;
  } | null = null;
  private latestServers: ReadonlyArray<FleetServerItem> = [];
  private devStartTicksByPid = new Map<number, string>();
  private lastScanAt = 0;

  constructor(platform: NodeJS.Platform = "linux") {
    this.platform = platform;
  }

  getLatest(): ReadonlyArray<FleetServerItem> {
    return this.latestServers;
  }

  getLastScanAt(): number {
    return this.lastScanAt;
  }

  private async fetchDockerStats(): Promise<
    ReadonlyMap<string, { readonly cpuPct: number; readonly memBytes: number }>
  > {
    const now = Date.now();
    if (this.statsCache && now - this.statsCache.at < DOCKER_STATS_CACHE_MS) {
      return this.statsCache.map;
    }
    const res = await execFileSafe(
      "docker",
      ["stats", "--no-stream", "--format", "{{.ID}}\t{{.CPUPerc}}\t{{.MemUsage}}"],
      DOCKER_STATS_TIMEOUT_MS,
    );
    const map = new Map<string, { readonly cpuPct: number; readonly memBytes: number }>();
    if (res.ok) {
      for (const line of res.stdout.split("\n")) {
        const [id, cpuRaw, memRaw] = line.split("\t");
        if (!id?.trim()) continue;
        const cpuPct = Number((cpuRaw ?? "").replace("%", "").trim());
        const memUsedRaw = (memRaw ?? "").split("/")[0]?.trim() ?? "";
        map.set(id.trim(), {
          cpuPct: Number.isFinite(cpuPct) ? Math.round(cpuPct * 10) / 10 : 0,
          memBytes: parseSizeBytes(memUsedRaw),
        });
      }
    }
    this.statsCache = { at: now, map };
    return map;
  }

  private async scanDocker(includeStats: boolean): Promise<ReadonlyArray<FleetServerItem>> {
    const ps = await execFileSafe(
      "docker",
      [
        "ps",
        "-a",
        "--format",
        '{{.ID}}\t{{.Names}}\t{{.State}}\t{{.Status}}\t{{.Image}}\t{{.Label "com.docker.compose.project"}}\t{{.Label "com.docker.compose.service"}}\t{{.Label "com.docker.compose.oneoff"}}\t{{.Label "com.docker.compose.project.working_dir"}}\t{{.Ports}}',
      ],
      DOCKER_PS_TIMEOUT_MS,
    );
    if (!ps.ok || !ps.stdout.trim()) return [];
    const hasRunning = ps.stdout.split("\n").some((line) => line.split("\t")[2] === "running");
    const stats =
      includeStats && hasRunning
        ? await this.fetchDockerStats()
        : (this.statsCache?.map ?? new Map());
    return parseDockerPsLines(ps.stdout, stats);
  }

  private async scanLocalDevListeners(
    dockerPorts: ReadonlySet<number>,
  ): Promise<ReadonlyArray<FleetServerItem>> {
    if (this.platform !== "linux") return [];
    const [ssRes, protectedPids] = await Promise.all([
      execFileSafe("ss", ["-Hltnp"], SOCKET_SCAN_TIMEOUT_MS),
      collectProtectedSelfPids(this.platform),
    ]);
    if (!ssRes.ok || !ssRes.stdout.trim()) return [];

    const myUid = typeof process.getuid === "function" ? process.getuid() : null;
    const listeners = parseSsListeners(ssRes.stdout);
    const out: FleetServerItem[] = [];
    const nextTicks = new Map<number, string>();

    for (const item of listeners) {
      if (dockerPorts.has(item.port)) continue;
      if (protectedPids.has(item.pid)) continue;
      if (IGNORED_DEV_PROCS.has(item.procName.toLowerCase())) continue;

      const [meta, startTicks] = await Promise.all([
        readLinuxProcessMeta(item.pid),
        readLinuxProcStartTicks(item.pid, this.platform),
      ]);
      if (!meta || !startTicks) continue;
      if (myUid !== null && meta.uid !== null && meta.uid !== myUid) continue;
      if (
        /\bT3 Code\b|\bt3code\b|\bt3-resource-monitor\b|\bantigravity\b|\bacp-mcp-bridge\b/i.test(
          meta.cmdline,
        )
      ) {
        continue;
      }

      nextTicks.set(item.pid, startTicks);
      const dirBase = meta.cwd ? NodePath.basename(meta.cwd) : "";
      const serviceLabel =
        dirBase && dirBase !== "/" && dirBase !== "dev"
          ? `${dirBase} (${item.procName})`
          : item.procName;

      out.push({
        id: `dev:${item.pid}:${item.port}`,
        service: serviceLabel,
        kind: "dev",
        url: `http://127.0.0.1:${item.port}`,
        port: item.port,
        ports: [{ port: item.port, proto: "http", url: `http://127.0.0.1:${item.port}` }],
        state: "up",
        managed: false,
        pid: item.pid,
        ...(meta.cwd ? { cwd: meta.cwd } : {}),
        ...(meta.memBytes > 0 ? { mem_bytes: meta.memBytes } : {}),
        can_start: false,
        can_stop: true,
      });
    }
    this.devStartTicksByPid = nextTicks;
    return out;
  }

  async scan(options?: {
    readonly includeStats?: boolean;
  }): Promise<ReadonlyArray<FleetServerItem>> {
    const dockerItems = await this.scanDocker(options?.includeStats ?? false);
    const dockerPorts = new Set<number>();
    for (const item of dockerItems) {
      if (item.port) dockerPorts.add(item.port);
      for (const p of item.ports ?? []) dockerPorts.add(p.port);
    }
    const devItems = await this.scanLocalDevListeners(dockerPorts);
    const merged = [...dockerItems, ...devItems];
    this.latestServers = merged;
    this.lastScanAt = Date.now();
    return merged;
  }

  async controlServer(
    verb: "start" | "stop",
    targetId: string,
    body?: Record<string, unknown>,
  ): Promise<{ readonly ok: boolean; readonly message: string }> {
    if (this.latestServers.length === 0) {
      await this.scan({ includeStats: false });
    }
    const explicitContainer = typeof body?.container === "string" ? body.container.trim() : "";
    const matched = this.latestServers.find(
      (s) =>
        s.id === targetId ||
        (s.project && s.service && `${s.project}/${s.service}` === targetId) ||
        (explicitContainer && s.container === explicitContainer),
    );

    if (matched?.container) {
      const containerName = matched.container;
      if (!SAFE_CONTAINER_RE.test(containerName)) {
        return { ok: false, message: `Invalid container name: ${containerName}` };
      }
      const res = await execFileSafe("docker", [verb, containerName], DOCKER_CTL_TIMEOUT_MS);
      if (!res.ok) {
        return {
          ok: false,
          message: res.stderr.trim() || `docker ${verb} ${containerName} failed`,
        };
      }
      this.statsCache = null;
      return { ok: true, message: `${verb === "start" ? "Started" : "Stopped"} ${containerName}` };
    }

    if (verb === "stop") {
      if (this.platform !== "linux") {
        return { ok: false, message: "Stopping unmanaged dev servers is supported on Linux only" };
      }
      const pidRaw = typeof body?.pid === "number" ? body.pid : matched?.pid;
      if (typeof pidRaw !== "number" || !Number.isInteger(pidRaw) || pidRaw <= 1) {
        return { ok: false, message: `Unknown server target: ${targetId}` };
      }
      const protectedPids = await collectProtectedSelfPids(this.platform);
      if (protectedPids.has(pidRaw)) {
        return { ok: false, message: "Refusing to stop protected T3 process" };
      }
      const expectedTicks = this.devStartTicksByPid.get(pidRaw);
      const isScannedDev = this.latestServers.some((s) => s.kind === "dev" && s.pid === pidRaw);
      if (!isScannedDev || !expectedTicks) {
        return { ok: false, message: `PID ${pidRaw} is not an active scanned dev server` };
      }
      const [liveTicks, meta] = await Promise.all([
        readLinuxProcStartTicks(pidRaw, this.platform),
        readLinuxProcessMeta(pidRaw),
      ]);
      const myUid = typeof process.getuid === "function" ? process.getuid() : null;
      if (
        liveTicks !== expectedTicks ||
        !meta ||
        (myUid !== null && meta.uid !== null && meta.uid !== myUid) ||
        /\bT3 Code\b|\bt3code\b|\bt3-resource-monitor\b|\bantigravity\b|\bacp-mcp-bridge\b/i.test(
          meta.cmdline,
        )
      ) {
        return { ok: false, message: `PID ${pidRaw} exited or changed identity before stop` };
      }
      try {
        process.kill(pidRaw, "SIGTERM");
        return { ok: true, message: `Sent SIGTERM to dev server PID ${pidRaw}` };
      } catch (err) {
        return {
          ok: false,
          message: err instanceof Error ? err.message : `Failed to stop PID ${pidRaw}`,
        };
      }
    }

    return { ok: false, message: `Starting unmanaged dev server ${targetId} is not supported` };
  }
}
