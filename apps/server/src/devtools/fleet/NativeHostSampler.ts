// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Native local host telemetry sampler composing T3 HostResources + disk/GPU/load/uptime/history.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { HostPowerSnapshot, HostResourcesSnapshot } from "@t3tools/contracts";

import {
  NODE_HIST_LEN,
  type FleetDiskInfo,
  type FleetGpuInfo,
  type FleetHostTelemetry,
  type FleetMemInfo,
  type FleetPowerState,
} from "./FleetTypes.ts";

const NV_CACHE_MS = 5_000;
const NV_TIMEOUT_MS = 3_000;
const ROUTE_HIST_INTERVAL_MS = 25_000;
const NV_CANDIDATES = ["nvidia-smi", "/usr/lib/wsl/lib/nvidia-smi"] as const;

export interface MountSpec {
  readonly path: string;
  readonly label: string;
}

export interface NativeHostSamplerDeps {
  readonly hostname?: string | undefined;
  readonly platform?: NodeJS.Platform | undefined;
  readonly procRoot?: string | undefined;
  readonly drmRoot?: string | undefined;
  readonly powerSupplyRoot?: string | undefined;
  readonly mounts?: ReadonlyArray<MountSpec> | undefined;
  readonly readHostResources?: (() => Promise<HostResourcesSnapshot | null>) | undefined;
  readonly readDesktopPower?: (() => Promise<HostPowerSnapshot | null>) | undefined;
  readonly execNvidiaSmi?: (() => Promise<string | null>) | undefined;
}

export interface LocalHostSampleResult {
  readonly host: FleetHostTelemetry;
  readonly power: FleetPowerState;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function parseProcStat(text: string): {
  readonly idle: number;
  readonly total: number;
  readonly cpus: number;
} | null {
  let idle = 0;
  let total = 0;
  let cpus = 0;
  let foundAgg = false;
  for (const line of text.split("\n")) {
    if (!line.startsWith("cpu")) continue;
    const fields = line.trim().split(/\s+/);
    if (fields[0] === "cpu") {
      // user nice system idle iowait irq softirq steal (first 8 fields; guest is included in user)
      for (let i = 1; i <= 8 && i < fields.length; i += 1) {
        const val = Number(fields[i]);
        if (!Number.isFinite(val)) continue;
        total += val;
        if (i === 4 || i === 5) idle += val;
      }
      foundAgg = true;
    } else if (/^cpu\d+$/.test(fields[0] ?? "")) {
      cpus += 1;
    }
  }
  return foundAgg ? { idle, total, cpus } : null;
}

export function parseProcMeminfo(text: string): FleetMemInfo | null {
  let totalKb = 0;
  let availKb = 0;
  let freeKb = 0;
  for (const line of text.split("\n")) {
    const m = /^(MemTotal|MemAvailable|MemFree):\s+(\d+)\s+kB/.exec(line);
    if (!m) continue;
    const kb = Number(m[2]);
    if (!Number.isFinite(kb)) continue;
    if (m[1] === "MemTotal") totalKb = kb;
    else if (m[1] === "MemAvailable") availKb = kb;
    else if (m[1] === "MemFree") freeKb = kb;
  }
  if (totalKb <= 0) return null;
  const total = totalKb * 1024;
  const avail = (availKb > 0 ? availKb : freeKb) * 1024;
  return {
    used: Math.max(0, Math.min(total, total - avail)),
    total,
  };
}

export function parseGpuLines(text: string): FleetGpuInfo | null {
  let best: FleetGpuInfo | null = null;
  for (const rawLine of text.split("\n")) {
    const fields = rawLine.trim().split(/\s+/);
    if (fields.length !== 4) continue;
    const kind = fields[0];
    if (kind !== "SYSFS" && kind !== "NV") continue;
    const unit = kind === "NV" ? 1024 * 1024 : 1;
    const busyNum = fields[1] === "-" ? Number.NaN : Number(fields[1]);
    const busyPct =
      Number.isFinite(busyNum) && busyNum >= 0 && busyNum <= 100 ? round1(busyNum) : undefined;
    const usedRaw = fields[2] === "-" ? Number.NaN : Number(fields[2]);
    const totalRaw = fields[3] === "-" ? Number.NaN : Number(fields[3]);
    const hasVram =
      Number.isFinite(usedRaw) &&
      Number.isFinite(totalRaw) &&
      usedRaw >= 0 &&
      totalRaw > 0 &&
      usedRaw <= totalRaw;
    const vramUsed = hasVram ? Math.round(usedRaw * unit) : 0;
    const vramTotal = hasVram ? Math.round(totalRaw * unit) : 0;
    if (busyPct === undefined && vramTotal === 0) continue;
    const candidate: FleetGpuInfo = {
      ...(busyPct !== undefined ? { busy_pct: busyPct } : {}),
      vram_used: vramUsed,
      vram_total: vramTotal,
    };
    if (!best || candidate.vram_total > best.vram_total) {
      best = candidate;
    }
  }
  return best;
}

export function parseNvidiaSmiCsv(csv: string): FleetGpuInfo | null {
  const lines: string[] = [];
  for (const row of csv.trim().split("\n")) {
    const parts = row.split(",").map((s) => s.trim());
    if (parts.length !== 3) continue;
    lines.push(`NV ${parts[0] || "-"} ${parts[1] || "-"} ${parts[2] || "-"}`);
  }
  return parseGpuLines(lines.join("\n"));
}

async function readFileTrimmed(path: string): Promise<string | null> {
  try {
    return (await NodeFSP.readFile(path, "utf8")).trim();
  } catch {
    return null;
  }
}

async function readSysfsGpu(drmRoot: string): Promise<FleetGpuInfo | null> {
  let entries: string[];
  try {
    entries = await NodeFSP.readdir(drmRoot);
  } catch {
    return null;
  }
  const lines: string[] = [];
  for (const entry of entries) {
    if (!/^card\d+$/.test(entry)) continue;
    const devDir = NodePath.join(drmRoot, entry, "device");
    const runtimeStatus = await readFileTrimmed(NodePath.join(devDir, "power/runtime_status"));
    const busy =
      runtimeStatus === "suspended"
        ? null
        : await readFileTrimmed(NodePath.join(devDir, "gpu_busy_percent"));
    const vramUsed = await readFileTrimmed(NodePath.join(devDir, "mem_info_vram_used"));
    const vramTotal = await readFileTrimmed(NodePath.join(devDir, "mem_info_vram_total"));
    if (busy === null && vramTotal === null) continue;
    lines.push(`SYSFS ${busy ?? "-"} ${vramUsed ?? "-"} ${vramTotal ?? "-"}`);
  }
  return parseGpuLines(lines.join("\n"));
}

function defaultExecNvidiaSmi(): Promise<string | null> {
  const tryAt = (index: number): Promise<string | null> => {
    const bin = NV_CANDIDATES[index];
    if (!bin) return Promise.resolve(null);
    return new Promise((resolve) => {
      NodeChildProcess.execFile(
        bin,
        ["--query-gpu=utilization.gpu,memory.used,memory.total", "--format=csv,noheader,nounits"],
        { timeout: NV_TIMEOUT_MS, maxBuffer: 64 * 1024 },
        (err, stdout) => {
          if (!err && stdout.trim()) {
            resolve(stdout);
            return;
          }
          void tryAt(index + 1).then(resolve);
        },
      );
    });
  };
  return tryAt(0);
}

async function readDisks(mounts: ReadonlyArray<MountSpec>): Promise<ReadonlyArray<FleetDiskInfo>> {
  const out: FleetDiskInfo[] = [];
  const seenDevs = new Set<number | bigint>();
  for (const mount of mounts) {
    try {
      const [st, fsStat] = await Promise.all([
        NodeFSP.stat(mount.path),
        NodeFSP.statfs(mount.path),
      ]);
      if (seenDevs.has(st.dev)) continue;
      seenDevs.add(st.dev);
      const total = Number(fsStat.bsize) * Number(fsStat.blocks);
      const avail = Number(fsStat.bsize) * Number(fsStat.bavail);
      if (!Number.isFinite(total) || total <= 0) continue;
      const used = Math.max(0, Math.min(total, total - Math.max(0, avail)));
      out.push({ mount: mount.path, label: mount.label, used, total });
    } catch {
      // mount absent or inaccessible
    }
  }
  return out;
}

async function readLinuxPowerSupply(root: string): Promise<FleetPowerState> {
  let entries: string[];
  try {
    entries = await NodeFSP.readdir(root);
  } catch {
    return {};
  }
  let hasBattery = false;
  let mainsOnline: boolean | null = null;
  for (const entry of entries) {
    const type = await readFileTrimmed(NodePath.join(root, entry, "type"));
    if (type === "Battery") {
      hasBattery = true;
    } else if (type === "Mains") {
      const online = await readFileTrimmed(NodePath.join(root, entry, "online"));
      if (online === "1") mainsOnline = true;
      else if (online === "0" && mainsOnline === null) mainsOnline = false;
    }
  }
  if (!hasBattery) return { power: "ac" };
  if (mainsOnline === true) return { power: "ac" };
  if (mainsOnline === false) return { power: "battery" };
  return {};
}

export class NativeHostSampler {
  private readonly hostname: string;
  private readonly platform: NodeJS.Platform;
  private readonly procRoot: string;
  private readonly drmRoot: string;
  private readonly powerSupplyRoot: string;
  private readonly mounts: ReadonlyArray<MountSpec>;
  private readonly readHostResources: (() => Promise<HostResourcesSnapshot | null>) | undefined;
  private readonly readDesktopPower: (() => Promise<HostPowerSnapshot | null>) | undefined;
  private readonly execNvidiaSmi: () => Promise<string | null>;

  private prevStat: { readonly idle: number; readonly total: number } | null = null;
  private cpuHist: number[] = [];
  private routeCpuHist: number[] = [];
  private lastRouteCpuAt = 0;
  private gpuHist: number[] = [];
  private lastCpuPct: number | undefined;
  private nvCache: { readonly at: number; readonly gpu: FleetGpuInfo | null } | null = null;
  private nvInflight: Promise<FleetGpuInfo | null> | null = null;
  private latest: LocalHostSampleResult | null = null;

  constructor(deps: NativeHostSamplerDeps = {}) {
    this.hostname = deps.hostname ?? NodeOS.hostname();
    this.platform = deps.platform ?? "linux";
    this.procRoot = deps.procRoot ?? "/proc";
    this.drmRoot = deps.drmRoot ?? "/sys/class/drm";
    this.powerSupplyRoot = deps.powerSupplyRoot ?? "/sys/class/power_supply";
    this.mounts =
      deps.mounts ??
      (this.platform === "darwin"
        ? [{ path: "/System/Volumes/Data", label: "macOS" }]
        : [
            { path: "/", label: "root (/home)" },
            { path: "/data", label: "/data" },
          ]);
    this.readHostResources = deps.readHostResources;
    this.readDesktopPower = deps.readDesktopPower;
    this.execNvidiaSmi = deps.execNvidiaSmi ?? defaultExecNvidiaSmi;
  }

  getLatest(): LocalHostSampleResult | null {
    return this.latest;
  }

  /** 30s-cadence CPU history aligned with `ship-queue/sq_route.py` (`NODE_SAMPLES=10` = 5 min). */
  getRouteCpuHist(): ReadonlyArray<number> {
    if (this.routeCpuHist.length > 0) return [...this.routeCpuHist];
    return this.lastCpuPct !== undefined ? [this.lastCpuPct] : [];
  }

  private async readGpu(): Promise<FleetGpuInfo | null> {
    if (this.platform !== "linux") return null;
    const sysfsGpu = await readSysfsGpu(this.drmRoot);
    if (sysfsGpu) return sysfsGpu;

    const now = Date.now();
    if (this.nvCache && now - this.nvCache.at < NV_CACHE_MS) {
      return this.nvCache.gpu;
    }
    if (!this.nvInflight) {
      this.nvInflight = this.execNvidiaSmi()
        .then((csv) => {
          const parsed = csv ? parseNvidiaSmiCsv(csv) : null;
          this.nvCache = { at: Date.now(), gpu: parsed };
          return parsed;
        })
        .catch(() => {
          this.nvCache = { at: Date.now(), gpu: null };
          return null;
        })
        .finally(() => {
          this.nvInflight = null;
        });
    }
    if (this.nvCache) return this.nvCache.gpu;
    return this.nvInflight;
  }

  private async readPower(): Promise<FleetPowerState> {
    if (this.readDesktopPower) {
      try {
        const snap = await this.readDesktopPower();
        if (snap && !snap.stale) {
          const power =
            snap.onBattery === "true" ? "battery" : snap.onBattery === "false" ? "ac" : undefined;
          const powerSaver = snap.lowPowerMode === "true" ? true : undefined;
          if (power !== undefined || powerSaver !== undefined) {
            return {
              ...(power !== undefined ? { power } : {}),
              ...(powerSaver !== undefined ? { powerSaver } : {}),
            };
          }
        }
      } catch {
        // fall through to OS power supply check
      }
    }
    if (this.platform === "linux") {
      return readLinuxPowerSupply(this.powerSupplyRoot);
    }
    return {};
  }

  async sample(options?: { readonly preferFastLinux?: boolean }): Promise<LocalHostSampleResult> {
    const preferFastLinux = options?.preferFastLinux ?? false;
    let cpus = NodeOS.cpus().length;
    let cpuPct: number | undefined = this.lastCpuPct;
    let mem: FleetMemInfo = {
      used: Math.max(0, NodeOS.totalmem() - NodeOS.freemem()),
      total: NodeOS.totalmem(),
    };

    if (this.platform === "linux") {
      const [statRaw, memRaw] = await Promise.all([
        readFileTrimmed(NodePath.join(this.procRoot, "stat")),
        readFileTrimmed(NodePath.join(this.procRoot, "meminfo")),
      ]);
      const parsedStat = statRaw ? parseProcStat(statRaw) : null;
      if (parsedStat) {
        if (parsedStat.cpus > 0) cpus = parsedStat.cpus;
        if (
          this.prevStat &&
          parsedStat.total > this.prevStat.total &&
          parsedStat.idle >= this.prevStat.idle
        ) {
          const dt = parsedStat.total - this.prevStat.total;
          const di = parsedStat.idle - this.prevStat.idle;
          cpuPct = round1(Math.max(0, Math.min(100, (100 * (dt - di)) / dt)));
        }
        this.prevStat = { idle: parsedStat.idle, total: parsedStat.total };
      }
      const parsedMem = memRaw ? parseProcMeminfo(memRaw) : null;
      if (parsedMem) mem = parsedMem;
    }

    // Seed CPU/memory from T3's native HostResources service when on non-Linux or on the very first Linux sample.
    if ((cpuPct === undefined || !preferFastLinux) && this.readHostResources) {
      try {
        const hr = await this.readHostResources();
        if (hr) {
          if (hr.cpuCount > 0) cpus = hr.cpuCount;
          if (cpuPct === undefined && hr.cpuUtilization !== null) {
            cpuPct = round1(Math.max(0, Math.min(100, hr.cpuUtilization * 100)));
          }
          if (hr.totalMemoryBytes > 0) {
            mem = {
              used: Math.max(0, hr.totalMemoryBytes - hr.availableMemoryBytes),
              total: hr.totalMemoryBytes,
            };
          }
        }
      } catch {
        // keep direct OS reading
      }
    }

    if (cpuPct !== undefined) {
      this.lastCpuPct = cpuPct;
      this.cpuHist.push(cpuPct);
      if (this.cpuHist.length > NODE_HIST_LEN) {
        this.cpuHist = this.cpuHist.slice(-NODE_HIST_LEN);
      }
      const nowMs = Date.now();
      if (this.routeCpuHist.length === 0 || nowMs - this.lastRouteCpuAt >= ROUTE_HIST_INTERVAL_MS) {
        this.lastRouteCpuAt = nowMs;
        this.routeCpuHist.push(cpuPct);
        if (this.routeCpuHist.length > NODE_HIST_LEN) {
          this.routeCpuHist = this.routeCpuHist.slice(-NODE_HIST_LEN);
        }
      }
    }

    const [disks, rawGpu, power] = await Promise.all([
      readDisks(this.mounts),
      this.readGpu(),
      this.readPower(),
    ]);

    let gpu: FleetGpuInfo | undefined;
    if (rawGpu) {
      if (rawGpu.busy_pct !== undefined) {
        this.gpuHist.push(rawGpu.busy_pct);
        if (this.gpuHist.length > NODE_HIST_LEN) {
          this.gpuHist = this.gpuHist.slice(-NODE_HIST_LEN);
        }
      }
      gpu = {
        ...rawGpu,
        ...(this.gpuHist.length > 0 ? { busy_hist: [...this.gpuHist] } : {}),
      };
    }

    const load1Raw = NodeOS.loadavg()[0];
    const load1 =
      typeof load1Raw === "number" && Number.isFinite(load1Raw) && this.platform !== "win32"
        ? round2(load1Raw)
        : undefined;

    const host: FleetHostTelemetry = {
      name: this.hostname,
      uptime_s: Math.max(0, Math.floor(NodeOS.uptime())),
      ...(load1 !== undefined ? { load1 } : {}),
      cpus: Math.max(1, cpus),
      ...(cpuPct !== undefined ? { cpu_pct: cpuPct } : {}),
      cpu_hist: [...this.cpuHist],
      mem,
      disks,
      ...(gpu ? { gpu } : {}),
      ts: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    };

    const result: LocalHostSampleResult = { host, power };
    this.latest = result;
    return result;
  }
}
